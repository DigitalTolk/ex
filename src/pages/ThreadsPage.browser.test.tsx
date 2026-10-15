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

vi.mock('@/hooks/useThreads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useThreads')>()),
  useUserThreads: () => ({ data: threads, isLoading: false }),
}));
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
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ isOnline: () => false, online: new Set<string>(), setUserOnline: () => undefined }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (url: string) =>
    Promise.resolve(
      url.includes('/thread')
        ? [{ id: url.includes('t-1') ? 't-1' : 't-2', parentID: 'ch-1', authorID: 'u-1', body: 'root', createdAt: '2026-04-26T10:00:00Z' }]
        : [],
    ),
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
    // The page title keeps its inset.
    const title = document.querySelector('h1')!;
    expect(title.textContent).toBe('Threads');
    expect(title.getBoundingClientRect().left).toBeGreaterThanOrEqual(16);
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
