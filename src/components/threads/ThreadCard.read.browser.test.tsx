import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadCard } from './ThreadCard';
import type { ThreadSummary } from '@/hooks/useThreads';
import type { Message } from '@/types';
import { forceAwayUntilInput, markUserActivity, resetUserActivityForTests } from '@/lib/user-activity';

// An unread card on the Threads page is read once its newest reply has been
// on screen — not when its top peeks in at the bottom of the window, and not
// while it's merely near enough to load.

const seenPuts: string[] = [];
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && url.endsWith('/seen')) seenPuts.push(/threads\/channels\/ch-1\/([^/]+)\/seen/.exec(url)![1]);
    const root = /\/messages\/([^/]+)\/thread$/.exec(url)?.[1];
    if (!root) return Promise.resolve([]);
    return Promise.resolve([
      { id: root, parentID: 'ch-1', authorID: 'u-1', body: 'root', createdAt: '2026-04-26T10:00:00Z' },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `${root}-r${i}`,
        parentID: 'ch-1',
        parentMessageID: root,
        authorID: 'u-2',
        body: `reply ${i}`,
        createdAt: `2026-04-26T10:0${i + 1}:00Z`,
      })),
    ]);
  },
}));
vi.mock('@/hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useDrafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDrafts')>()),
  useDraftForScope: () => ({ data: undefined }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: vi.fn() }),
}));
// Each message takes up the room a real one does; their rendering has its
// own suites.
vi.mock('@/components/chat/MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div data-testid="thread-message" style={{ height: 60 }}>
      {message.body}
    </div>
  ),
}));
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: () => <div data-testid="thread-composer" style={{ height: 44 }} />,
}));

const summary = (id: string): ThreadSummary => ({
  parentID: 'ch-1',
  parentType: 'channel',
  threadRootID: id,
  rootAuthorID: 'u-1',
  rootBody: 'root',
  rootCreatedAt: '2026-04-26T10:00:00Z',
  replyCount: 4,
  latestActivityAt: `2099-01-01T00:00:00.000Z`,
});

afterEach(() => {
  seenPuts.length = 0;
  resetUserActivityForTests();
  vi.restoreAllMocks();
});

describe('ThreadCard reading', () => {
  it('reads the card whose replies are on screen, and the next one only once its end is', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    markUserActivity();
    await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          {/* Each card is about 400px tall (header, five 60px messages, the
              composer): the first fills the window and the second's header
              shows below it. */}
          <div data-testid="scroller" style={{ height: 480, overflowY: 'auto' }}>
            <ThreadCard summary={summary('t-a')} title="~general" deepLink="/channel/general?thread=t-a" currentUserId="u-me" unread />
            <ThreadCard summary={summary('t-b')} title="~general" deepLink="/channel/general?thread=t-b" currentUserId="u-me" unread />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    const [, second] = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="thread-card"]'));
    // Both load: the second sits well inside the read-ahead.
    await expect.poll(() => document.querySelectorAll('[data-testid="thread-message"]').length).toBe(10);
    await expect.poll(() => seenPuts).toEqual(['t-a']);
    // The second card's top is on screen, its replies are not.
    const visibleTop = second.getBoundingClientRect().top;
    expect(visibleTop).toBeLessThan(scroller.getBoundingClientRect().bottom);
    // Let any late observer callback land before saying it stayed unread.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(seenPuts).toEqual(['t-a']);

    scroller.scrollTop = scroller.scrollHeight;
    await expect.poll(() => seenPuts).toEqual(['t-a', 't-b']);
  });

  it('leaves a card unread while the window is in the background, and reads it on return', async () => {
    // Away: the last input was long ago, so nothing on screen is being read.
    forceAwayUntilInput();
    await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ThreadCard summary={summary('t-c')} title="~general" deepLink="/channel/general?thread=t-c" currentUserId="u-me" unread />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await expect.poll(() => document.querySelectorAll('[data-testid="thread-message"]').length).toBe(5);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(seenPuts).toEqual([]);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await expect.poll(() => seenPuts).toEqual(['t-c']);
  });
});
