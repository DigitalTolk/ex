import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

const sendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
}));

const threadDataState: { current: { id: string; authorID: string; body: string }[] } = {
  current: [],
};
vi.mock('@/hooks/useThreads', () => ({
  useThreadMessages: () => ({ data: threadDataState.current, isLoading: false }),
}));

import { ThreadPanel } from '@/components/chat/ThreadPanel';

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TooltipProvider>
          <ThreadPanel
            channelId="ch-1"
            threadRootID="root-1"
            onClose={vi.fn()}
            userMap={{}}
            currentUserId="me"
          />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('ThreadPanel autoscroll', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([]);
    threadDataState.current = [
      { id: 'r-1', authorID: 'u-1', body: 'first' },
    ];
  });

  function rerenderPanel(rerender: (ui: React.ReactElement) => void) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <TooltipProvider>
            <ThreadPanel
              channelId="ch-1"
              threadRootID="root-1"
              onClose={vi.fn()}
              userMap={{}}
              currentUserId="me"
            />
          </TooltipProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );
  }

  it('scrolls to the newest reply when the thread opens', () => {
    // Regression: opening a thread used to leave the user at the
    // OLDEST reply because the auto-stick effect only fired on
    // length growth (new reply), not on initial mount.
    threadDataState.current = [
      { id: 'r-1', authorID: 'u-1', body: 'first' },
      { id: 'r-2', authorID: 'u-2', body: 'second' },
      { id: 'r-3', authorID: 'u-1', body: 'third' },
    ];
    // Provide a non-zero scrollHeight so the synchronous pin has
    // somewhere to scroll to under jsdom (which doesn't lay out).
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 800;
      },
    });
    try {
      renderPanel();
      const list = screen.getByLabelText('Thread').querySelector('.overflow-y-auto') as HTMLElement;
      expect(list.scrollTop).toBe(800);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return 0;
        },
      });
    }
  });

  it('re-arms initial scroll-to-bottom when the user opens a different thread', () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    let mockHeight = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return mockHeight;
      },
    });
    try {
      threadDataState.current = [{ id: 'r-1', authorID: 'u-1', body: 'first' }];
      mockHeight = 600;
      const { rerender } = renderPanel();
      let list = screen.getByLabelText('Thread').querySelector('.overflow-y-auto') as HTMLElement;
      expect(list.scrollTop).toBe(600);

      // User opens a DIFFERENT thread root (threadRootID changes).
      // The new thread has its own data; the scroll must re-pin to
      // the bottom of THAT thread, not stay at the previous offset.
      threadDataState.current = [
        { id: 'r-99', authorID: 'u-2', body: 'first reply of thread B' },
        { id: 'r-100', authorID: 'u-3', body: 'newer reply of thread B' },
      ];
      mockHeight = 1200;
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      rerender(
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <TooltipProvider>
              <ThreadPanel
                channelId="ch-1"
                threadRootID="root-2"
                onClose={vi.fn()}
                userMap={{}}
                currentUserId="me"
              />
            </TooltipProvider>
          </BrowserRouter>
        </QueryClientProvider>,
      );
      list = screen.getByLabelText('Thread').querySelector('.overflow-y-auto') as HTMLElement;
      expect(list.scrollTop).toBe(1200);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', desc);
    }
  });

  it('scrolls to the bottom when a new reply arrives and the user is already near the bottom', () => {
    const { rerender } = renderPanel();
    const list = screen.getByLabelText('Thread').querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 800 });
    // distanceFromBottom = 1000 - (180 + 800) = 20px → within threshold.
    list.scrollTop = 180;

    threadDataState.current = [...threadDataState.current, { id: 'r-2', authorID: 'u-2', body: 'second' }];
    rerenderPanel(rerender);

    expect(list.scrollTop).toBe(1000);
  });

  it('does NOT yank the user down when they are reading older replies', () => {
    const { rerender } = renderPanel();
    const list = screen.getByLabelText('Thread').querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    // distanceFromBottom = 1000 - (100 + 400) = 500px → above threshold.
    list.scrollTop = 100;

    threadDataState.current = [...threadDataState.current, { id: 'r-2', authorID: 'u-2', body: 'second' }];
    rerenderPanel(rerender);

    expect(list.scrollTop).toBe(100);
  });
});
