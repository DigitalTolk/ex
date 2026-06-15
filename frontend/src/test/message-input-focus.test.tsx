import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

// The CM6 composer sources autocomplete data from these hooks — stub them with
// static empty data so their queries don't resolve async outside act().
vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useChannels', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useChannels')>()),
  useChannelMembers: () => ({ data: [] }),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from '@/components/chat/MessageInput';

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('MessageInput focusKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refocuses the editor when focusKey changes', async () => {
    const { rerender } = render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input');
    // Move focus elsewhere
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MessageInput onSend={vi.fn()} focusKey="ch-2" />
      </QueryClientProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(document.activeElement).toBe(editor);
  });

  it('does not autofocus the editor on mobile when focusKey changes', async () => {
    setMobileMatch(true);
    const { rerender } = render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input');
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MessageInput onSend={vi.fn()} focusKey="ch-2" />
      </QueryClientProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(editor);
  });

  it('keeps the mobile composer one line until the user focuses it', () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input');

    expect(editor).toHaveClass('max-md:!min-h-9', 'max-md:!max-h-9');
    fireEvent.focus(editor);
    expect(editor).not.toHaveClass('max-md:!min-h-9');
    expect(editor).not.toHaveClass('max-md:!max-h-9');
  });

  it('refocuses the mobile composer when the page returns to the foreground with the keyboard up', async () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input') as HTMLElement;
    fireEvent.focus(editor);

    // Simulate iOS app-switch: the contenteditable loses focus while the
    // tab is hidden, but the keyboard is still up because the user just
    // tapped back into our app.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    fireEvent.blur(editor);

    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(document.activeElement).toBe(editor);
    setMobileMatch(false);
  });

  it('does not refocus on foreground if the editor was not focused when the page hid', async () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input') as HTMLElement;

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(document.activeElement).not.toBe(editor);
    setMobileMatch(false);
  });

  it('keeps the mobile composer compact until focus reveals the full toolbar and attachment action', () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input');

    expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Attach file')).not.toBeInTheDocument();
    fireEvent.focus(editor);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const attach = screen.getByLabelText('Attach file');

    expect(toolbar).not.toHaveClass('overflow-x-auto', 'max-md:touch-pan-x');
    expect(screen.getByLabelText('Bold (Ctrl+B)')).toHaveClass('max-md:h-9', 'max-md:w-9');
    expect(screen.getAllByLabelText('Attach file')).toHaveLength(1);
    expect(attach).toHaveClass('text-muted-foreground', 'hover:text-foreground', 'max-md:h-9', 'max-md:w-9', 'shrink-0');
    expect(screen.queryByLabelText('Quote')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('List')).not.toBeInTheDocument();
  });
});
