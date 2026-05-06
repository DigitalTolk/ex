import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

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

    expect(editor).toHaveClass('max-md:min-h-[1.5rem]', 'max-md:max-h-[1.5rem]');
    fireEvent.focus(editor);
    expect(editor).not.toHaveClass('max-md:min-h-[1.5rem]');
    expect(editor).not.toHaveClass('max-md:max-h-[1.5rem]');
  });

  it('hides mobile formatting controls until the user focuses the input line', () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const editor = screen.getByLabelText('Message input');

    expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Attach file')).not.toBeInTheDocument();
    fireEvent.focus(editor);
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.getByLabelText('Attach file')).toBeInTheDocument();
  });
});
