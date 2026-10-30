import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ThreadsPage from './ThreadsPage';
import type { ThreadSummary } from '@/hooks/useThreads';
import type { Message } from '@/types';

// On a phone the Threads page lists its threads edge to edge, one after
// another with a rule between them — no cards, whose border, rounding and
// inset took width from the messages. A wider window keeps the cards.

const threads: ThreadSummary[] = ['t-1', 't-2'].map((id) => ({
  parentID: 'ch-1',
  parentType: 'channel',
  threadRootID: id,
  rootAuthorID: 'u-1',
  rootBody: 'root',
  rootCreatedAt: '2026-04-26T10:00:00Z',
  replyCount: 1,
  latestActivityAt: '2026-04-26T10:00:00Z',
}));

// The list the server pages out: one page per entry, the cursor "r:<n>"
// naming the next.
let threadPages: ThreadSummary[][] = [threads];
const listRequests: string[] = [];
vi.mock('@/hooks/useChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useChannels')>()),
  useUserChannels: () => ({ data: [{ channelID: 'ch-1', channelName: 'general' }] }),
}));
vi.mock('@/hooks/useConversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useConversations')>()),
  useUserConversations: () => ({ data: [] }),
}));
vi.mock('@/hooks/useUserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useUserState')>()),
  useUserState: () => ({ data: { threadNotifications: [], threadSeen: {}, threadMarkedUnread: {} } }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({ unreadThreadNotifications: new Set<string>() }),
  useOptionalUnread: () => ({ unreadThreadNotifications: new Set<string>() }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ isOnline: () => false, online: new Set<string>(), setUserOnline: () => undefined }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (url: string) => {
    const list = /^\/api\/v1\/threads(?:\?cursor=(.*))?$/.exec(url);
    if (list) {
      listRequests.push(url);
      const page = list[1] ? Number(decodeURIComponent(list[1]).slice(2)) : 0;
      return Promise.resolve({
        threads: threadPages[page] ?? [],
        nextCursor: page + 1 < threadPages.length ? `r:${page + 1}` : undefined,
      });
    }
    const root = /\/messages\/([^/]+)\/thread$/.exec(url)?.[1] ?? 't-2';
    return Promise.resolve(
      url.includes('/thread')
        ? [{ id: root, parentID: 'ch-1', authorID: 'u-1', body: 'root', createdAt: '2026-04-26T10:00:00Z' }]
        : [],
    );
  },
}));
vi.mock('@/hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => ({ data: undefined }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: vi.fn() }),
  condemnDraftForSend: vi.fn(() => vi.fn()),
  removeDraftScopeFromCache: vi.fn(),
}));
// The messages and the composer have their own suites; here they only take
// up the room a thread's content does.
vi.mock('@/components/chat/MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div data-testid="thread-message" style={{ height: 40 }}>
      {message.body}
    </div>
  ),
}));
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: () => <div data-testid="thread-composer" style={{ height: 44 }} />,
}));

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 700, display: 'flex', flexDirection: 'column' }}>
          <ThreadsPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="thread-card"]')).toHaveLength(2), {
    timeout: 5000,
  });
  return screen;
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="thread-card"]'));

describe('Threads page layout', () => {
  it('on a phone runs each thread edge to edge, with a rule between them', async () => {
    if (!document.documentElement.classList.contains('tier-mobile')) return;
    await renderPage();
    const width = document.documentElement.clientWidth;
    for (const card of cards()) {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      expect(rect.left).toBe(0);
      expect(rect.width).toBe(width);
      expect(style.borderTopLeftRadius).toBe('0px');
      expect(style.borderLeftWidth).toBe('0px');
      expect(style.borderTopWidth).toBe('0px');
      expect(style.borderBottomWidth).toBe('1px');
    }
    // One right after the other.
    const [first, second] = cards().map((card) => card.getBoundingClientRect());
    expect(second.top).toBe(first.bottom);
    // The page title moves up beside the back button in the top bar; the page
    // keeps its heading for screen readers only.
    const title = document.querySelector('h1')!;
    expect(title.textContent).toBe('Threads');
    expect(title.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  });

  it('in a wider window keeps each thread in its card', async () => {
    if (document.documentElement.classList.contains('tier-mobile')) return;
    await renderPage();
    for (const card of cards()) {
      const style = getComputedStyle(card);
      expect(card.getBoundingClientRect().left).toBeGreaterThanOrEqual(16);
      expect(style.borderTopLeftRadius).toBe('8px');
      expect(style.borderLeftWidth).toBe('1px');
    }
  });
});

describe('Threads page with many threads', () => {
  // Each card is a whole thread (messages, reactions, a composer) with its
  // own query; the page mounts only the cards near the view, and loads the
  // list itself a page at a time as the reader reaches its end.
  it('loads more pages as the reader scrolls, and mounts only the cards near the view', async () => {
    const all = [...threads, ...Array.from({ length: 58 }, (_, i) => ({ ...threads[0], threadRootID: `t-many-${i}` }))];
    threadPages = [all.slice(0, 20), all.slice(20, 40), all.slice(40)];
    listRequests.length = 0;
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/threads']}>
            <div style={{ height: 700, display: 'flex', flexDirection: 'column' }}>
              <ThreadsPage />
            </div>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0), { timeout: 5000 });
      await expect.poll(() => cards().length).toBeLessThan(30);
      // Only the first page so far.
      expect(listRequests).toEqual(['/api/v1/threads']);

      const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement;
      const last = all[all.length - 1].threadRootID;
      await expect
        .poll(() => {
          scroller.scrollTop = scroller.scrollHeight;
          return document.querySelector(`[data-thread-root-id="${last}"]`);
        })
        .not.toBeNull();
      expect(listRequests).toEqual(['/api/v1/threads', '/api/v1/threads?cursor=r%3A1', '/api/v1/threads?cursor=r%3A2']);
      expect(cards().length).toBeLessThan(30);
    } finally {
      threadPages = [threads];
    }
  });

  // A few unread threads fit on the screen, so nothing is scrolled: the rest
  // of the followed threads must still load after them.
  it('loads the threads after a short first page without any scrolling', async () => {
    const rest = Array.from({ length: 5 }, (_, i) => ({ ...threads[0], threadRootID: `t-rest-${i}` }));
    threadPages = [threads, rest];
    listRequests.length = 0;
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/threads']}>
            <div style={{ height: 700, display: 'flex', flexDirection: 'column' }}>
              <ThreadsPage />
            </div>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await expect.poll(() => cards().length).toBe(7);
      expect(listRequests).toEqual(['/api/v1/threads', '/api/v1/threads?cursor=r%3A1']);
    } finally {
      threadPages = [threads];
    }
  });
});
