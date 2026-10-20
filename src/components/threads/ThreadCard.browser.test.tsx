import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ThreadCard } from './ThreadCard';
import type { ThreadSummary } from '@/hooks/useThreads';
import type { Message } from '@/types';

// A long thread card collapses its middle replies behind "Show N more
// replies". The link sits where the replies' text starts — beside their
// avatars, not under them — on every screen size. Real message rows here:
// the link's indent follows their avatar column.

const messages: Message[] = [
  { id: 'root', parentID: 'ch-1', authorID: 'u-1', body: 'root', createdAt: '2026-04-26T10:00:00Z' },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `r-${i}`,
    parentID: 'ch-1',
    parentMessageID: 'root',
    authorID: i % 2 ? 'u-1' : 'u-2',
    body: `reply ${i}`,
    createdAt: `2026-04-26T10:${String(i + 1).padStart(2, '0')}:00Z`,
  })),
];

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (url: string) => Promise.resolve(url.includes('/messages/root/thread') ? messages : []),
}));
vi.mock('@/hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  usePendingMessageActions: () => ({ retry: vi.fn(), discard: vi.fn() }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useDrafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDrafts')>()),
  useDraftForScope: () => ({ data: undefined }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: vi.fn() }),
  condemnDraftForSend: vi.fn(() => vi.fn()),
  removeDraftScopeFromCache: vi.fn(),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ isOnline: () => false, online: new Set<string>(), setUserOnline: () => undefined }),
}));
vi.mock('@/components/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: () => <div data-testid="thread-composer" style={{ height: 44 }} />,
}));

const summary: ThreadSummary = {
  parentID: 'ch-1',
  parentType: 'channel',
  threadRootID: 'root',
  rootAuthorID: 'u-1',
  rootBody: 'root',
  rootCreatedAt: '2026-04-26T10:00:00Z',
  replyCount: 12,
  latestActivityAt: '2026-04-26T10:12:00Z',
};

describe('ThreadCard collapsed replies', () => {
  it('starts "Show more replies" where the replies\' text starts', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <div style={{ width: Math.min(window.innerWidth, 900) }}>
            <ThreadCard summary={summary} title="~general" deepLink="/channel/general?thread=root" currentUserId="u-9" />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-testid="thread-card-expand"]')).not.toBeNull(), { timeout: 5000 });
    // The first reply shown after the link starts a new author group, so it
    // has its avatar beside the text.
    const link = document.querySelector('[data-testid="thread-card-expand"]')!.getBoundingClientRect();
    const text = document.querySelector('[data-message-id="r-10"] [data-testid="message-text-column"]')!.getBoundingClientRect();
    expect(Math.round(link.left)).toBe(Math.round(text.left));
  });
});
