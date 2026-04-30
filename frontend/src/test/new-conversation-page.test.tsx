import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NewConversationPage from '@/pages/NewConversationPage';

const mockCreate = vi.fn();
const apiFetchMock = vi.fn();

vi.mock('@/hooks/useConversations', () => ({
  useSearchUsers: (q: string) => ({
    data:
      q.trim().length >= 2
        ? [
            { id: 'u-1', displayName: 'Alice', email: 'a@x.com' },
            { id: 'u-2', displayName: 'Bob', email: 'b@x.com' },
          ]
        : [],
  }),
  useCreateConversation: () => ({
    mutateAsync: (input: { type: string; participantIDs: string[] }) => {
      mockCreate(input);
      return Promise.resolve({ id: 'conv-new', type: input.type, participantIDs: input.participantIDs });
    },
    isPending: false,
  }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => 'tok',
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', email: 'me@x.com', displayName: 'Me' } }),
}));

// Stub MessageInput to a tiny form: a textarea + "Send" button. The page's
// real composer is exercised in MessageInput's own tests; here we only
// care that this page wires onSend correctly. The body lives on the DOM
// node so the test can drive it with fireEvent.change without needing
// React state inside the mock.
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: ({
    onSend,
    disabled,
    placeholder,
  }: {
    onSend: (v: { body: string; attachmentIDs: string[] }) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <div>
      <textarea
        aria-label="Message input"
        placeholder={placeholder}
        disabled={disabled}
        data-testid="msg-body"
      />
      <button
        type="button"
        aria-label="Send"
        disabled={disabled}
        onClick={() => {
          const ta = document.querySelector(
            '[data-testid="msg-body"]',
          ) as HTMLTextAreaElement | null;
          onSend({ body: ta?.value ?? '', attachmentIDs: [] });
        }}
      >
        Send
      </button>
    </div>
  ),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/conversations/new']}>
        <Routes>
          <Route path="/conversations/new" element={<NewConversationPage />} />
          <Route path="/conversation/:id" element={<div data-testid="conv-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NewConversationPage', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: 'msg-1' });
  });

  it('renders the To: line with a recipients input — no separate "Search users" field, no Back arrow', () => {
    renderPage();
    expect(screen.getByText('To:')).toBeInTheDocument();
    expect(screen.getByTestId('recipients-input')).toBeInTheDocument();
    // The legacy back-arrow button must be gone.
    expect(screen.queryByLabelText('Back')).toBeNull();
    // The legacy "Search users" label must be gone.
    expect(screen.queryByLabelText('Search users')).toBeNull();
  });

  it('lays out like a chat window: To: row at top, empty middle, composer at bottom', () => {
    // The page must mirror the channel/conversation view shell so it
    // doesn't visually jolt when the user routes here from a chat. We
    // assert structural ordering rather than pixel positions: the
    // recipients input appears in the DOM before the empty middle area,
    // which appears before the composer's Send button.
    renderPage();
    const root = screen.getByTestId('new-conversation-form');
    // Chat-shell uses flex-1 + flex-col + overflow-hidden so the page
    // fills the content area without scrolling at the page level.
    expect(root.className).toMatch(/flex-1/);
    expect(root.className).toMatch(/flex-col/);
    expect(root.className).toMatch(/overflow-hidden/);

    const recipients = screen.getByTestId('recipients-input');
    const send = screen.getByLabelText('Send');
    // DOM-order check: To: input precedes Send button.
    expect(
      recipients.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The empty-state hint copy lives between the two — guarding that
    // we didn't accidentally drop the middle area.
    expect(
      screen.getByText(/Type a name above to find someone/),
    ).toBeInTheDocument();
  });

  it('shows a different empty-area hint once at least one recipient is picked', () => {
    renderPage();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    expect(screen.getByText(/No messages yet/)).toBeInTheDocument();
  });

  it('shows the autocomplete dropdown only when the query has matching users', () => {
    renderPage();
    expect(screen.queryByTestId('recipients-suggestions')).toBeNull();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'al' } });
    expect(screen.getByTestId('recipients-suggestions')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-option-u-1')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-option-u-2')).toBeInTheDocument();
  });

  it('picking a user adds a closable pill and clears the input', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'al' } });
    // mousedown is what the option uses (so it beats the input blur).
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    expect(screen.getByTestId('recipient-pill-u-1')).toHaveTextContent('Alice');
    expect(input.value).toBe('');
    // Pill is removable.
    fireEvent.click(screen.getByLabelText('Remove Alice'));
    expect(screen.queryByTestId('recipient-pill-u-1')).toBeNull();
  });

  it('Enter key picks the highlighted suggestion', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input');
    fireEvent.change(input, { target: { value: 'al' } });
    // First suggestion is highlighted by default.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('recipient-pill-u-1')).toBeInTheDocument();
  });

  it('Backspace on empty input pops the last pill', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input');
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    fireEvent.change(input, { target: { value: 'bo' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-2').querySelector('button')!);
    expect(screen.getByTestId('recipient-pill-u-1')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-pill-u-2')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.queryByTestId('recipient-pill-u-2')).toBeNull();
    expect(screen.getByTestId('recipient-pill-u-1')).toBeInTheDocument();
  });

  it('sending the first message creates a DM and posts the message, then navigates', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);

    const editor = screen.getByLabelText('Message input');
    fireEvent.change(editor, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ type: 'dm', participantIDs: ['u-1'] });
    });
    // Then the message POST against the new conversation id.
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/v1/conversations/conv-new/messages',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('hello there'),
      }),
    );
    // And we land on the conversation route.
    await waitFor(() => {
      expect(screen.getByTestId('conv-page')).toBeInTheDocument();
    });
  });

  it('sending with multiple recipients creates a group (not a DM)', async () => {
    renderPage();
    const input = screen.getByTestId('recipients-input');
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    fireEvent.change(input, { target: { value: 'bo' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-2').querySelector('button')!);

    const editor = screen.getByLabelText('Message input');
    fireEvent.change(editor, { target: { value: 'hi all' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        type: 'group',
        participantIDs: ['u-1', 'u-2'],
      });
    });
  });

  it('does not create a conversation if the user has not picked anyone', () => {
    renderPage();
    // Composer is disabled until a recipient is picked.
    const send = screen.getByLabelText('Send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('does not create a conversation if the message body is empty', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    // Empty body: composer's onSend was wired by handleSend, which short-
    // circuits without calling the create mutation.
    fireEvent.click(screen.getByLabelText('Send'));
    await Promise.resolve();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('shows an error when the API rejects on send', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Network down'));
    renderPage();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    const editor = screen.getByLabelText('Message input');
    fireEvent.change(editor, { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => {
      expect(screen.getByTestId('new-conversation-error')).toHaveTextContent('Network down');
    });
  });

  it('shows the generic "Failed to send" when the rejection is not an Error', async () => {
    apiFetchMock.mockImplementationOnce(() => Promise.reject('boom'));
    renderPage();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByTestId('recipient-option-u-1').querySelector('button')!);
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => {
      expect(screen.getByTestId('new-conversation-error')).toHaveTextContent('Failed to send');
    });
  });

  it('arrow keys cycle the highlighted suggestion; mouseEnter updates it too', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input');
    fireEvent.change(input, { target: { value: 'al' } });
    const opt1 = screen.getByTestId('recipient-option-u-1');
    const opt2 = screen.getByTestId('recipient-option-u-2');
    expect(opt1.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(opt2.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(opt1.getAttribute('aria-selected')).toBe('true');

    // ArrowUp wraps to the last option.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(opt2.getAttribute('aria-selected')).toBe('true');

    // mouseEnter on opt1 brings the highlight back.
    fireEvent.mouseEnter(opt1.querySelector('button')!);
    expect(opt1.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking the To: row focuses the input', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input') as HTMLInputElement;
    // Defocus so we can verify focus is restored.
    input.blur();
    expect(document.activeElement).not.toBe(input);
    // The wrapper is the parent of the input that has the click handler.
    const wrapper = input.parentElement!;
    fireEvent.click(wrapper);
    expect(document.activeElement).toBe(input);
  });
});
