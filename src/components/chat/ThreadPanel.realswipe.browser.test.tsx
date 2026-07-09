import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadPanel } from './ThreadPanel';
import { swipe } from '@/test/gestures';
import type { Message } from '@/types';

// REAL-surface proof for the thread sidebar: ThreadPanel spreads the REAL
// useSwipeDismiss('right', onClose) motionProps onto its <motion.aside>. A
// genuine rightward finger drag past the threshold must animate it off-screen
// and fire onClose; a small below-threshold drag springs back and stays open.
// Only the data deps are mocked — useSwipeDismiss (and useIsMobile) run for real
// so Motion's drag engine is exercised via swipe().

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useFrequentEmojis: () => ['thumbsup', 'heart', 'tada'],
}));
vi.mock('@/hooks/useUsersBatch', () => ({ useUsersBatch: () => ({ data: [] }) }));
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), mutate: vi.fn(), isPending: false }),
  uploadAttachment: vi.fn(),
}));
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useThreads', () => ({
  useUserThreads: () => ({ data: [] }),
  useThreadMessages: () => ({
    data: [
      { id: 'ROOT', parentID: 'ch-1', parentType: 'channel', authorID: 'u-1', body: 'root', createdAt: '2026-05-01T10:00:00Z' },
      { id: 'R0', parentID: 'ch-1', parentType: 'channel', authorID: 'u-1', body: 'reply', parentMessageID: 'ROOT', createdAt: '2026-05-01T11:00:00Z' },
    ] as Message[],
    isLoading: false,
  }),
  useFollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  useUnfollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  markThreadSeen: vi.fn(),
}));
vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => ({ data: undefined }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: vi.fn() }),
  condemnDraftForSend: vi.fn(() => vi.fn()),
  removeDraftScopeFromCache: vi.fn(),
}));
vi.mock('@/hooks/useNonMemberInvite', () => ({
  useNonMemberInvite: () => ({ pendingInvites: [], channelSlug: 'general', checkMentions: vi.fn(), clearInvites: vi.fn() }),
}));
vi.mock('./NonMemberInvitePrompt', () => ({ NonMemberInvitePrompt: () => null }));
vi.mock('./TypingIndicator', () => ({ ThreadTypingIndicator: () => <div data-testid="typing" /> }));
vi.mock('./MessageInput', () => ({ MessageInput: () => <div data-testid="message-input" /> }));
vi.mock('./MessageDropZone', () => ({
  MessageDropZone: ({ children }: { children: React.ReactNode }) => <div data-testid="drop-zone">{children}</div>,
}));
vi.mock('./MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div id={`msg-${message.id}`} data-message-id={message.id} style={{ height: 40 }}>
      {message.body}
    </div>
  ),
}));

afterEach(() => cleanup());

const aside = () => document.querySelector('aside[aria-label="Thread"]') as HTMLElement | null;

async function renderPanel(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ThreadPanel
          channelId="ch-1"
          threadRootID="ROOT"
          onClose={onClose}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          currentUserId="u-1"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('ThreadPanel — real swipe-to-dismiss', () => {
  it('a RIGHT swipe past the threshold closes the thread', async () => {
    if (window.innerWidth > 767) return; // drag only arms on mobile
    const onClose = await renderPanel();
    const el = aside();
    expect(el).not.toBeNull();

    // A real rightward drag well past DISMISS_DISTANCE (72px).
    await swipe(el!, { dx: 220, steps: 8, stepMs: 18 });

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a small RIGHT swipe below the threshold springs back and stays open', async () => {
    if (window.innerWidth > 767) return;
    const onClose = await renderPanel();
    const el = aside();
    expect(el).not.toBeNull();

    // 40px (< 72px) released slowly (settle → ~0 velocity): stays open.
    await swipe(el!, { dx: 40, steps: 5, stepMs: 24, settle: true });

    await new Promise((r) => setTimeout(r, 60));
    expect(onClose).not.toHaveBeenCalled();
    expect(aside()).not.toBeNull();
  });
});
