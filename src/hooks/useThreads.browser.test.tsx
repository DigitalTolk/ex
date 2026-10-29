import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useThreadFollowing,
  useFollowThread,
  useUnfollowThread,
  useThreadMessages,
  markThreadSeen,
  threadDeepLink,
  resetSeenCache,
  getSeenMap,
  type ThreadSummary,
} from './useThreads';
import { queryKeys } from '@/lib/query-keys';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
  resetSeenCache();
  window.localStorage.removeItem('ex.threads.seen.v1');
});

function Probe<T>({ hook }: { hook: () => { data?: T } }) {
  const r = hook();
  return (
    <div
      data-testid="probe"
      data-data={r.data === undefined ? '' : JSON.stringify(r.data)}
      data-url={apiFetchMock.mock.calls[0]?.[0] ?? ''}
    />
  );
}

function MutationTrigger({
  hook,
  vars,
}: {
  hook: () => { mutate: (v: unknown) => void };
  vars: unknown;
}) {
  const m = hook();
  return <button data-testid="trigger" onClick={() => m.mutate(vars)} />;
}

function renderHook<T>(hook: () => { data?: T }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe hook={hook} />
    </QueryClientProvider>,
  );
}

const threadSummary = (overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  parentID: 'ch-1',
  parentType: 'channel',
  threadRootID: 't-1',
  rootAuthorID: 'u-1',
  rootBody: 'hi',
  rootCreatedAt: '2026-01-01T00:00:00Z',
  replyCount: 1,
  latestActivityAt: '2026-01-02T00:00:00Z',
  ...overrides,
});

describe('useThreads — queries and mutations', () => {
  it('useThreadFollowing asks the follow path, and reads anything but true as not following', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderHook(() => useThreadFollowing({ parentID: 'ch-1', parentType: 'channel', threadRootID: 't-1' }));
    await expect.poll(() => screen.getByTestId('probe').element().getAttribute('data-data')).toBe('false');
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/threads/channels/ch-1/t-1/follow');
  });

  it('useThreadFollowing waits for a thread to ask about', async () => {
    await renderHook(() => useThreadFollowing({ parentID: '', parentType: 'channel', threadRootID: 't-1' }));
    await renderHook(() => useThreadFollowing({ parentID: 'ch-1', parentType: 'channel', threadRootID: 't-1' }, false));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useThreadMessages is gated on having both parent and threadRootID', async () => {
    await renderHook(() => useThreadMessages({ threadRootID: 't-1' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useThreadMessages builds the channel path correctly', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useThreadMessages({ channelId: 'ch-1', threadRootID: 't-1' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/messages/t-1/thread');
  });

  it('useThreadMessages builds the conversation path correctly', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useThreadMessages({ conversationId: 'cv-1', threadRootID: 't-1' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-1/messages/t-1/thread');
  });

  it('useFollowThread PUTs to the follow path, encoding parent ids', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MutationTrigger
          hook={useFollowThread as never}
          vars={{ parentID: 'ch 1', parentType: 'channel', threadRootID: 't 1' }}
        />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/threads/channels/ch%201/t%201/follow');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('PUT');
    // The thread's Follow button flips without asking again.
    expect(qc.getQueryData(queryKeys.threadFollow('ch 1', 't 1'))).toBe(true);
  });

  it('useUnfollowThread DELETEs the same follow path', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MutationTrigger
          hook={useUnfollowThread as never}
          vars={{ parentID: 'cv-1', parentType: 'conversation', threadRootID: 't-1' }}
        />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/threads/conversations/cv-1/t-1/follow');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
    expect(qc.getQueryData(queryKeys.threadFollow('cv-1', 't-1'))).toBe(false);
  });

  // Following a listed thread marks its card; unfollowing takes the card off
  // the Threads page at once — on every visit's list it is in.
  it('a follow change updates the listed card, and an unfollow removes it', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pages = { pages: [{ threads: [threadSummary({ threadRootID: 't-1', following: false }), threadSummary({ threadRootID: 't-2' })] }], pageParams: [''] };
    qc.setQueryData(queryKeys.threadPages('v1'), pages);
    const target = { parentID: 'ch-1', parentType: 'channel', threadRootID: 't-1' } as const;
    function Buttons() {
      const follow = useFollowThread();
      const unfollow = useUnfollowThread();
      return (
        <>
          <button data-testid="follow" onClick={() => follow.mutate(target)} />
          <button data-testid="unfollow" onClick={() => unfollow.mutate(target)} />
        </>
      );
    }
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Buttons />
      </QueryClientProvider>,
    );
    const listed = () => (qc.getQueryData(queryKeys.threadPages('v1')) as typeof pages).pages[0].threads;
    (screen.getByTestId('follow').element() as HTMLButtonElement).click();
    await expect.poll(() => listed()[0].following).toBe(true);
    (screen.getByTestId('unfollow').element() as HTMLButtonElement).click();
    await expect.poll(() => listed().map((t) => t.threadRootID)).toEqual(['t-2']);
  });
});

describe('useThreads — seen-state and link helpers', () => {
  it('markThreadSeen persists the seen timestamp and triggers a CustomEvent', async () => {
    const handler = vi.fn();
    window.addEventListener('ex:threads-seen-changed', handler);
    try {
      markThreadSeen('t-99', '2026-04-04T12:00:00Z');
      expect(getSeenMap()['t-99']).toBe('2026-04-04T12:00:00Z');
      expect(handler).toHaveBeenCalled();
    } finally {
      window.removeEventListener('ex:threads-seen-changed', handler);
    }
  });

  it('markThreadSeen also fires the server PUT when a target is supplied', () => {
    apiFetchMock.mockResolvedValue(undefined);
    markThreadSeen('t-1', '2026-04-04T12:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(apiFetchMock).toHaveBeenCalled();
    expect(apiFetchMock.mock.calls[0][0]).toContain('/user-state/threads/channels/ch-1/t-1/seen');
  });

  it('threadDeepLink builds /channel/<slug>?thread=...#msg-... for a channel thread', () => {
    const url = threadDeepLink(
      threadSummary({ parentType: 'channel', parentID: 'ch-1', threadRootID: 't-1' }),
      'My Channel',
    );
    expect(url).toBe('/channel/my-channel?thread=t-1#msg-t-1');
  });

  it('threadDeepLink falls back to the parent ID when slugify yields an empty string', () => {
    const url = threadDeepLink(
      threadSummary({ parentType: 'channel', parentID: 'ch-x', threadRootID: 't-2' }),
      '...',
    );
    expect(url).toBe('/channel/ch-x?thread=t-2#msg-t-2');
  });

  it('threadDeepLink builds the /conversation form for a conversation thread', () => {
    const url = threadDeepLink(
      threadSummary({ parentType: 'conversation', parentID: 'cv-1', threadRootID: 't-3' }),
      'irrelevant',
    );
    expect(url).toBe('/conversation/cv-1?thread=t-3#msg-t-3');
  });

  it('markThreadSeen defaults the timestamp to now when none is supplied', () => {
    markThreadSeen('t-default');
    // A timestamp was recorded (the default `new Date().toISOString()` path).
    expect(typeof getSeenMap()['t-default']).toBe('string');
    expect(getSeenMap()['t-default'].length).toBeGreaterThan(0);
  });

  it('caps the seen-map, evicting the oldest entries past the limit', () => {
    // Seed 500 OLD entries directly, then mark one NEW thread seen — the map is
    // capped at 500, so the new entry is kept and an old one is evicted.
    const seed: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) {
      seed[`old-${i}`] = `2020-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`;
    }
    localStorage.setItem('ex.threads.seen.v1', JSON.stringify(seed));
    resetSeenCache();

    markThreadSeen('brand-new', '2030-01-01T00:00:00Z');

    const map = getSeenMap();
    expect(Object.keys(map).length).toBe(500);
    expect(map['brand-new']).toBe('2030-01-01T00:00:00Z'); // newest kept
    expect(map['old-0']).toBeUndefined(); // an oldest entry evicted
  });

  it('markThreadSeen targets the conversations server path for a conversation thread', () => {
    apiFetchMock.mockResolvedValue(undefined);
    markThreadSeen('t-7', '2026-04-04T12:00:00Z', { parentID: 'cv-9', parentType: 'conversation' });
    expect(apiFetchMock.mock.calls[0][0]).toContain('/user-state/threads/conversations/cv-9/t-7/seen');
  });

  it('markThreadSeen swallows a rejected server PUT (.catch arm)', async () => {
    // The fire-and-forget PUT rejects → `.catch(() => undefined)` (line 100)
    // must absorb it without an unhandled rejection.
    apiFetchMock.mockRejectedValue(new Error('offline'));
    markThreadSeen('t-rej', '2026-04-04T12:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    await new Promise((r) => setTimeout(r, 50));
    expect(getSeenMap()['t-rej']).toBe('2026-04-04T12:00:00Z');
  });
});
