import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, act } from '@testing-library/react';
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

describe('MessageInput focusKey', () => {
  it('refocuses the textarea when focusKey changes', async () => {
    const { rerender } = render(<MessageInput onSend={vi.fn()} focusKey="ch-1" />);
    const ta = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    expect(document.activeElement).toBe(ta);
  });
});
