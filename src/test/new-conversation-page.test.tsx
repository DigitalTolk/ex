import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NewConversationPage from '@/pages/NewConversationPage';

const mockCreate = vi.fn();
const apiFetchMock = vi.fn();

const userConversations = vi.hoisted(() => ({ value: [] as unknown[] | undefined }));
vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useUserConversations: () => ({ data: userConversations.value }),
  useUserLookup: (q: string) => ({
    // Mirror the real hook: `data` is undefined (not []) while the query is
    // disabled/unresolved — the page must coerce it.
    data:
      q === 'me'
        ? [{ id: 'u-me', displayName: 'Me', email: 'me@x.com' }]
        : q.trim().length >= 2
        ? [
            { id: 'u-1', displayName: 'Alice', email: 'a@x.com' },
            { id: 'u-2', displayName: 'Bob', email: 'b@x.com' },
          ]
        : undefined,
  }),
  useCreateConversation: () => ({
    // A test can answer with a promise of its own (a failure, one it holds).
    mutateAsync: (input: { type: string; participantIDs: string[] }) =>
      mockCreate(input) ??
      Promise.resolve({ id: input.type === 'group' ? 'conv-group' : 'conv-new', type: input.type, participantIDs: input.participantIDs }),
    isPending: false,
  }),
}));

// What the server holds: the user's drafts, and each conversation's messages.
const server = vi.hoisted(() => ({
  drafts: [] as object[],
  history: {} as Record<string, object[]>,
}));
let draftGen = 0;
function serve(url: string, init?: { method?: string; body?: string }) {
  if (url === '/api/v1/drafts' && init?.method === 'PUT') {
    const saved = JSON.parse(init.body!) as { body: string; attachmentIDs: string[] };
    return Promise.resolve(saved.body || saved.attachmentIDs.length ? { ...saved, id: 'd', gen: `g-${++draftGen}` } : undefined);
  }
  if (url === '/api/v1/drafts') return Promise.resolve(server.drafts);
  const history = /^\/api\/v1\/conversations\/([^/]+)\/messages\?/.exec(url);
  if (history) return Promise.resolve({ items: server.history[history[1]] ?? [], hasMoreOlder: false, hasMoreNewer: false });
  if (init?.method === 'POST') return Promise.resolve({ id: 'msg-1' });
  return Promise.resolve([]);
}

// The draft saves the page sent, in order.
function draftSaves() {
  return apiFetchMock.mock.calls
    .filter(([url, init]) => url === '/api/v1/drafts' && init?.method === 'PUT')
    .map(([, init]) => {
      const { parentID, body } = JSON.parse(init.body) as { parentID: string; body: string };
      return { parentID, body };
    });
}

function messagePosts() {
  return apiFetchMock.mock.calls.filter(([url, init]) => /\/messages$/.test(url) && init?.method === 'POST').map(([url]) => url);
}

// The message list stands in as the messages it was given; a click replies
// in the message's thread.
vi.mock('@/components/chat/MessageList', () => ({
  MessageList: ({
    pages,
    conversationId,
    onReplyInThread,
  }: {
    pages: { items: { id: string; body: string }[] }[];
    conversationId?: string;
    onReplyInThread?: (id: string) => void;
  }) => (
    <div data-testid={`history-${conversationId}`}>
      {pages.flatMap((p) => p.items).map((m) => (
        <button key={m.id} type="button" onClick={() => onReplyInThread?.(m.id)}>
          {m.body}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => 'tok',
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', email: 'me@x.com', displayName: 'Me' } }),
}));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

// Stub MessageInput to a tiny form: a textarea + "Send" button. The page's
// real composer is exercised in MessageInput's own tests; here we only
// care that this page wires onSend correctly. The body lives on the DOM
// node so the test can drive it with fireEvent.change without needing
// React state inside the mock. The extra "Force send" button bypasses the
// disabled gate so tests can exercise the page's own no-recipient guard
// (its inline error), which the disabled composer normally shadows.
// The composer's draft hand-off (onDraftChange), as the page last gave it.
const composer = vi.hoisted(() => ({
  onDraftChange: undefined as undefined | ((v: { body: string; attachmentIDs: string[] }, o?: { notify?: boolean }) => void),
}));
function write(body: string, options?: { notify?: boolean }, attachmentIDs: string[] = []) {
  act(() => composer.onDraftChange?.({ body, attachmentIDs }, options));
}

vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: ({
    onSend,
    disabled,
    placeholder,
    initialBody,
    onDraftChange,
  }: {
    onSend: (v: { body: string; attachmentIDs: string[] }) => void;
    disabled?: boolean;
    placeholder?: string;
    initialBody?: string;
    onDraftChange?: typeof composer.onDraftChange;
  }) => {
    composer.onDraftChange = onDraftChange;
    return (
    <div>
      <output data-testid="initial-body">{initialBody}</output>
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
      <button
        type="button"
        data-testid="force-send"
        onClick={() => {
          const ta = document.querySelector(
            '[data-testid="msg-body"]',
          ) as HTMLTextAreaElement | null;
          onSend({ body: ta?.value ?? '', attachmentIDs: [] });
        }}
      >
        Force send
      </button>
    </div>
    );
  },
}));

function ConversationRoute() {
  const { pathname, search } = useLocation();
  return <div data-testid="conv-page">{pathname + search}</div>;
}

function pickUser(query: string, id: string) {
  fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: query } });
  fireEvent.mouseDown(screen.getByTestId(`recipient-option-${id}`).querySelector('button')!);
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/conversations/new']}>
        <Routes>
          <Route path="/conversations/new" element={<NewConversationPage />} />
          <Route path="/conversation/:id" element={<ConversationRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NewConversationPage', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(serve);
    server.drafts = [];
    server.history = {};
    userConversations.value = [];
    composer.onDraftChange = undefined;
    mockIsMobile = false;
  });

  it('autofocuses the recipients input on desktop but not on mobile', () => {
    // Desktop keeps the convenience autofocus…
    const desktop = renderPage();
    expect(document.activeElement).toBe(screen.getByTestId('recipients-input'));
    desktop.unmount();
    // …mobile must not: an autofocused input pops the keyboard mid
    // page-transition and forces focus-scroll inside the overflow-hidden
    // app shell (part of the "new DM page loads glitched" bug).
    mockIsMobile = true;
    renderPage();
    expect(document.activeElement).not.toBe(screen.getByTestId('recipients-input'));
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
    expect(root.className).toMatch(/min-h-0/);
    expect(root.className).toMatch(/overflow-hidden/);

    expect(screen.getByTestId('recipients-input')).toHaveClass('text-sm', 'mobile:text-base');

    const recipients = screen.getByTestId('recipients-input');
    const send = screen.getByLabelText('Send');
    // DOM-order check: To: input precedes Send button.
    expect(
      recipients.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

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
    expect(messagePosts()).toEqual([]);
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

  it('shows an inline error when a send fires with no recipients picked', async () => {
    // The composer normally disables itself, but the page owns the final
    // guard: an onSend with zero recipients must produce the inline error,
    // not a conversation.
    renderPage();
    fireEvent.click(screen.getByTestId('force-send'));
    expect(await screen.findByTestId('new-conversation-error')).toHaveTextContent(
      'Pick at least one recipient.',
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(messagePosts()).toEqual([]);
  });

  it('adds a recipient exactly once when mousedown and click both fire from one gesture', () => {
    // UserPickerRow picks on mousedown AND keeps click as the touch
    // fallback, so one tap can invoke pick() twice in the same batch. The
    // second call must dedup against the first inside the state updater —
    // the render-scope `picked` is stale for it.
    renderPage();
    const input = screen.getByTestId('recipients-input');
    fireEvent.change(input, { target: { value: 'al' } });
    const option = screen.getByTestId('recipient-option-u-1').querySelector('button')!;
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(screen.getAllByTestId(/^recipient-pill-/)).toHaveLength(1);
    expect(screen.getByTestId('recipient-pill-u-1')).toHaveTextContent('Alice');
  });

  it('ignores navigation keys while there are no suggestions', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input');
    // No query → no suggestions: ArrowDown/Enter must be inert (and not
    // crash on an empty list).
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId(/^recipient-pill-/)).toBeNull();
    expect(screen.queryByTestId('recipients-suggestions')).toBeNull();
  });

  it('leaves the suggestion list untouched for non-navigation keys', () => {
    renderPage();
    const input = screen.getByTestId('recipients-input');
    fireEvent.change(input, { target: { value: 'al' } });
    // A key the handler doesn't own (e.g. Escape) falls through all the
    // navigation branches: highlight and list stay as they were.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('recipients-suggestions')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-option-u-1').getAttribute('aria-selected')).toBe('true');
  });

  it('shows an error when the API rejects on send', async () => {
    apiFetchMock.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Promise.reject(new Error('Network down')) : serve(url, init),
    );
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
    apiFetchMock.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Promise.reject('boom') : serve(url, init),
    );
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

  // With people picked and no conversation with exactly them yet, the ones
  // that take them in are a click away. One made but never written to is
  // nobody's conversation yet, so it isn't among them.
  it('lists the conversations you already have with the people picked', async () => {
    userConversations.value = [
      { conversationID: 'g-ab', type: 'group', displayName: 'Alice, Bob', participantIDs: ['u-me', 'u-1', 'u-2'] },
      { conversationID: 'g-bc', type: 'group', displayName: 'Bob, Carol', participantIDs: ['u-me', 'u-2', 'u-3'], activated: true },
      { conversationID: 'dm-b', type: 'dm', displayName: 'Bob', participantIDs: ['u-me', 'u-2'], activated: false },
      { conversationID: 'dm-c', type: 'dm', displayName: 'Carol', participantIDs: ['u-me', 'u-3'] },
    ];
    renderPage();
    expect(screen.queryByText('Existing conversations')).toBeNull();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'Bo' } });
    fireEvent.mouseDown(await screen.findByText('Bob'));
    const rows = screen.getAllByTestId(/^existing-conversation-/).map((el) => el.textContent);
    expect(rows).toEqual(['Alice, Bob', 'Bob, Carol']);
    expect(screen.queryByTestId(/^history-/)).toBeNull();
    fireEvent.click(screen.getByTestId('existing-conversation-g-ab'));
    expect(await screen.findByTestId('conv-page')).toHaveTextContent('/conversation/g-ab');
  });

  it('lists the conversations you are in when you pick yourself', async () => {
    userConversations.value = [
      { conversationID: 'dm-c', type: 'dm', displayName: 'Carol', participantIDs: ['u-me', 'u-3'], activated: true },
    ];
    renderPage();
    pickUser('me', 'u-me');
    expect(screen.getAllByTestId(/^existing-conversation-/).map((el) => el.textContent)).toEqual(['Carol']);
  });

  it('lists nothing while your conversations are still loading', async () => {
    userConversations.value = undefined;
    renderPage();
    fireEvent.change(screen.getByTestId('recipients-input'), { target: { value: 'Al' } });
    fireEvent.mouseDown(await screen.findByText('Alice'));
    expect(screen.queryByText('Existing conversations')).toBeNull();
  });

  it('addresses the box to the people picked', () => {
    renderPage();
    expect(screen.getByLabelText('Message input')).toHaveAttribute('placeholder', 'Pick at least one recipient first…');
    pickUser('al', 'u-1');
    expect(screen.getByLabelText('Message input')).toHaveAttribute('placeholder', 'Write to Alice');
    pickUser('bo', 'u-2');
    expect(screen.getByLabelText('Message input')).toHaveAttribute('placeholder', 'Write to Alice, Bob');
  });

  describe('with a conversation you already have with exactly the people picked', () => {
    beforeEach(() => {
      userConversations.value = [
        { conversationID: 'dm-a', type: 'dm', displayName: 'Alice', participantIDs: ['u-me', 'u-1'], activated: true },
        { conversationID: 'g-ab', type: 'group', displayName: 'Alice, Bob', participantIDs: ['u-me', 'u-1', 'u-2'], activated: true },
      ];
      server.history = { 'dm-a': [{ id: 'm-1', parentID: 'dm-a', authorID: 'u-1', body: 'Earlier hello', createdAt: '2026-11-01T10:00:00Z' }] };
    });

    it('shows its messages, and a reply in a thread opens it there', async () => {
      renderPage();
      pickUser('al', 'u-1');
      fireEvent.click(await screen.findByText('Earlier hello'));
      expect(screen.queryByText('Existing conversations')).toBeNull();
      expect(await screen.findByTestId('conv-page')).toHaveTextContent('/conversation/dm-a?thread=m-1');
    });

    it('opens with its draft in the box, and leaves that draft where it is when the people change', async () => {
      server.drafts = [
        { id: 'd-a', userID: 'u-me', parentID: 'dm-a', parentType: 'conversation', body: 'half written', gen: 'g-a', createdAt: '', updatedAt: '' },
      ];
      renderPage();
      pickUser('al', 'u-1');
      await waitFor(() => expect(screen.getByTestId('initial-body')).toHaveTextContent('half written'));
      // Leaving the box: it hands over the draft it showed, unchanged.
      write('half written', { notify: true });
      pickUser('bo', 'u-2');
      // The box now shows the group's draft (none), and the user writes there.
      write('');
      write('to both');
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'g-ab', body: 'to both' }]));
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('takes a draft it showed along once it is changed, if only by dropping its file', async () => {
      server.drafts = [
        { id: 'd-a', userID: 'u-me', parentID: 'dm-a', parentType: 'conversation', body: 'see file', attachmentIDs: ['att-1'], gen: 'g-a', createdAt: '', updatedAt: '' },
      ];
      renderPage();
      pickUser('al', 'u-1');
      await waitFor(() => expect(screen.getByTestId('initial-body')).toHaveTextContent('see file'));
      // Handed over unchanged: nothing to save, and nothing of the page's own.
      write('see file', { notify: true }, ['att-1']);
      write('see file', undefined, []);
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'dm-a', body: 'see file' }]));
      pickUser('bo', 'u-2');
      write('see file');
      await waitFor(() =>
        expect(draftSaves()).toEqual([
          { parentID: 'dm-a', body: 'see file' },
          { parentID: 'g-ab', body: 'see file' },
          { parentID: 'dm-a', body: '' },
        ]),
      );
    });

    it('sends there', async () => {
      renderPage();
      pickUser('al', 'u-1');
      fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'again' } });
      fireEvent.click(screen.getByLabelText('Send'));
      expect(await screen.findByTestId('conv-page')).toHaveTextContent('/conversation/dm-a');
      expect(messagePosts()).toEqual(['/api/v1/conversations/dm-a/messages']);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // What is written is kept as the draft of the conversation with the people
  // picked, made for it (without anyone hearing of it) the first time there
  // is something to keep.
  describe('drafts', () => {
    it('keeps what is written as the draft of a conversation made for it, and sends nothing', async () => {
      renderPage();
      // Nobody picked: nowhere to keep it.
      write('too early');
      pickUser('al', 'u-1');
      // An empty box keeps nothing and makes nothing.
      write('');
      write('hi');
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'conv-new', body: 'hi' }]));
      expect(mockCreate.mock.calls).toEqual([[{ type: 'dm', participantIDs: ['u-1'] }]]);
      expect(messagePosts()).toEqual([]);
    });

    it('takes the text along when the people change, leaving no draft behind', async () => {
      renderPage();
      pickUser('al', 'u-1');
      write('hi');
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'conv-new', body: 'hi' }]));
      pickUser('bo', 'u-2');
      write('hi both');
      await waitFor(() =>
        expect(draftSaves()).toEqual([
          { parentID: 'conv-new', body: 'hi' },
          { parentID: 'conv-group', body: 'hi both' },
          { parentID: 'conv-new', body: '' },
        ]),
      );
    });

    it('leaves no draft behind when the box is emptied after the people changed', async () => {
      renderPage();
      pickUser('al', 'u-1');
      write('hi');
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'conv-new', body: 'hi' }]));
      pickUser('bo', 'u-2');
      write('');
      await waitFor(() =>
        expect(draftSaves()).toEqual([
          { parentID: 'conv-new', body: 'hi' },
          { parentID: 'conv-new', body: '' },
        ]),
      );
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('makes the conversation once, however many saves wait for it', async () => {
      let made!: (conv: object) => void;
      mockCreate.mockReturnValueOnce(new Promise((resolve) => (made = resolve)));
      renderPage();
      pickUser('al', 'u-1');
      write('h');
      write('hi');
      await act(async () => made({ id: 'conv-new', type: 'dm', participantIDs: ['u-1'] }));
      await waitFor(() => expect(draftSaves()).toEqual([
        { parentID: 'conv-new', body: 'h' },
        { parentID: 'conv-new', body: 'hi' },
      ]));
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('tries again to make the conversation when making it failed', async () => {
      mockCreate.mockReturnValueOnce(Promise.reject(new Error('down')));
      renderPage();
      pickUser('al', 'u-1');
      write('hi');
      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
      write('hi!');
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'conv-new', body: 'hi!' }]));
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('sends to the people picked last, leaving no draft where the text was before', async () => {
      renderPage();
      pickUser('al', 'u-1');
      write('hi');
      await waitFor(() => expect(draftSaves()).toEqual([{ parentID: 'conv-new', body: 'hi' }]));
      pickUser('bo', 'u-2');
      fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hi' } });
      fireEvent.click(screen.getByLabelText('Send'));
      expect(await screen.findByTestId('conv-page')).toHaveTextContent('/conversation/conv-group');
      expect(messagePosts()).toEqual(['/api/v1/conversations/conv-group/messages']);
      expect(draftSaves()).toEqual([
        { parentID: 'conv-new', body: 'hi' },
        { parentID: 'conv-new', body: '' },
      ]);
    });

    it('shows why when the conversation could not be made for a send', async () => {
      mockCreate.mockReturnValueOnce(Promise.reject(new Error('Could not start it')));
      renderPage();
      pickUser('al', 'u-1');
      fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hi' } });
      fireEvent.click(screen.getByLabelText('Send'));
      expect(await screen.findByTestId('new-conversation-error')).toHaveTextContent('Could not start it');
      expect(messagePosts()).toEqual([]);
    });
  });
});
