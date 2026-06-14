import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useUserThreads,
  useFollowThread,
  useUnfollowThread,
  useThreadMessages,
  markThreadSeen,
  hasUnreadActivity,
  unreadThreadIDs,
  sortThreadsByUnreadThenActivity,
  threadDeepLink,
  resetSeenCache,
  getSeenMap,
  type ThreadSummary,
} from './useThreads';

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
  it('useUserThreads coerces a non-array response to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderHook(() => useUserThreads());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
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
  });
});

describe('useThreads — seen-state and sorting helpers', () => {
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

  it('hasUnreadActivity is true when no seen entry exists', () => {
    expect(hasUnreadActivity(threadSummary(), {})).toBe(true);
  });

  it('hasUnreadActivity compares latestActivityAt to seenAt timestamps', () => {
    const t = threadSummary({ latestActivityAt: '2026-01-10T00:00:00Z' });
    expect(hasUnreadActivity(t, { 't-1': '2026-01-09T00:00:00Z' })).toBe(true);
    expect(hasUnreadActivity(t, { 't-1': '2026-01-11T00:00:00Z' })).toBe(false);
  });

  it('unreadThreadIDs returns only listed threads that are actually unread', () => {
    const threads = [
      threadSummary({ threadRootID: 't-1', latestActivityAt: '2026-01-10T00:00:00Z' }),
      threadSummary({ threadRootID: 't-2', latestActivityAt: '2026-01-08T00:00:00Z' }),
    ];
    const ids = unreadThreadIDs(
      threads,
      ['t-1', 't-3'], // server-side notifications (t-3 not listed → dropped)
      new Set(['t-2']),
      { 't-1': '2026-01-11T00:00:00Z' /* read */, 't-2': '2026-01-01T00:00:00Z' /* unread */ },
    );
    expect(ids.has('t-1')).toBe(false);
    expect(ids.has('t-2')).toBe(true);
    expect(ids.has('t-3')).toBe(false);
  });

  it('sortThreadsByUnreadThenActivity puts unread threads first, then by activity desc', () => {
    const threads = [
      threadSummary({ threadRootID: 'old-read', latestActivityAt: '2026-01-01T00:00:00Z' }),
      threadSummary({ threadRootID: 'new-unread', latestActivityAt: '2026-01-05T00:00:00Z' }),
      threadSummary({ threadRootID: 'newer-read', latestActivityAt: '2026-01-10T00:00:00Z' }),
    ];
    const sorted = sortThreadsByUnreadThenActivity(threads, new Set(['new-unread']));
    expect(sorted[0].threadRootID).toBe('new-unread');
    expect(sorted[1].threadRootID).toBe('newer-read');
    expect(sorted[2].threadRootID).toBe('old-read');
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

  it('markThreadSeen targets the conversations server path for a conversation thread', () => {
    apiFetchMock.mockResolvedValue(undefined);
    markThreadSeen('t-7', '2026-04-04T12:00:00Z', { parentID: 'cv-9', parentType: 'conversation' });
    expect(apiFetchMock.mock.calls[0][0]).toContain('/user-state/threads/conversations/cv-9/t-7/seen');
  });

  it('unreadThreadIDs skips threads with no recorded seen entry', () => {
    const threads = [
      threadSummary({ threadRootID: 't-seen', latestActivityAt: '2026-01-10T00:00:00Z' }),
      threadSummary({ threadRootID: 't-noseen', latestActivityAt: '2026-01-10T00:00:00Z' }),
    ];
    const ids = unreadThreadIDs(
      threads,
      [], // no server notifications
      new Set(),
      { 't-seen': '2026-01-01T00:00:00Z' /* unread */ }, // t-noseen has no entry → skipped
    );
    expect(ids.has('t-seen')).toBe(true);
    expect(ids.has('t-noseen')).toBe(false);
  });

  it('sortThreadsByUnreadThenActivity orders two unread threads by activity and tolerates bad dates', () => {
    const threads = [
      threadSummary({ threadRootID: 'a', latestActivityAt: '2026-01-02T00:00:00Z' }),
      threadSummary({ threadRootID: 'b', latestActivityAt: 'not-a-real-date' }),
      threadSummary({ threadRootID: 'c', latestActivityAt: '2026-01-09T00:00:00Z' }),
    ];
    // All three unread → aUnread === bUnread, so they sort purely by activity;
    // the invalid date coerces to 0 and sinks to the bottom.
    const sorted = sortThreadsByUnreadThenActivity(threads, new Set(['a', 'b', 'c']));
    expect(sorted[0].threadRootID).toBe('c');
    expect(sorted[2].threadRootID).toBe('b');
  });

  it('hasUnreadActivity falls back to the persisted seen-map when no map is passed', () => {
    // Default `seen = loadSeen()` parameter (line 109). Persist a seen
    // entry, then call without the seen arg so the default fires.
    markThreadSeen('t-default-seen', '2026-01-11T00:00:00Z');
    const t = threadSummary({ threadRootID: 't-default-seen', latestActivityAt: '2026-01-10T00:00:00Z' });
    expect(hasUnreadActivity(t)).toBe(false);
  });

  it('unreadThreadIDs returns an empty set when called with no arguments (default params)', () => {
    // Exercises the default params on lines 116-119.
    expect(unreadThreadIDs().size).toBe(0);
  });

  it('sortThreadsByUnreadThenActivity returns [] when called with no arguments (default params)', () => {
    // Exercises the default params on lines 146-147.
    expect(sortThreadsByUnreadThenActivity()).toEqual([]);
  });
});
