import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { resetSeenCache, type ThreadSummary } from '@/hooks/useThreads';
import { NotificationCountTitleBridge } from './NotificationCountTitleBridge';

// The title bridge sums the authoritative per-target unread MESSAGE counts
// (the same maps the sidebar badges read, seeded from the server seq count by
// UnreadServerCountSync) plus the unread-thread count — so multiple messages in
// one parent climb the tab title instead of being collapsed to a single "(1)".
const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  channelUnreadCounts: new Map<string, number>(),
  conversationUnreadCounts: new Map<string, number>(),
  unreadThreadNotifications: new Set<string>(),
  threads: [] as ThreadSummary[],
  threadNotifications: [] as string[],
  threadSeen: {} as Record<string, string>,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: mockState.isAuthenticated }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    channelUnreadCounts: mockState.channelUnreadCounts,
    conversationUnreadCounts: mockState.conversationUnreadCounts,
    unreadThreadNotifications: mockState.unreadThreadNotifications,
  }),
}));

vi.mock('@/hooks/useThreads', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useThreads')>('@/hooks/useThreads');
  return {
    ...actual,
    useUserThreads: () => ({ data: mockState.threads }),
  };
});

vi.mock('@/hooks/useUserState', () => ({
  useUserState: () => ({
    data: {
      threadNotifications: mockState.threadNotifications,
      threadSeen: { ...mockState.threadSeen, ...JSON.parse(localStorage.getItem('ex.threads.seen.v1') ?? '{}') },
      hiddenConversations: [],
    },
  }),
}));

function TitleConsumer() {
  useDocumentTitle('Threads');
  return null;
}

describe('NotificationCountTitleBridge', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSeenCache();
    act(() => {
      setDocumentNotificationCount(0);
    });
    document.title = 'ex';
    mockState.isAuthenticated = true;
    mockState.channelUnreadCounts = new Map();
    mockState.conversationUnreadCounts = new Map();
    mockState.unreadThreadNotifications = new Set();
    mockState.threads = [];
    mockState.threadNotifications = [];
    mockState.threadSeen = {};
  });

  afterEach(() => {
    act(() => {
      setDocumentNotificationCount(0);
    });
  });

  it('sums channel + DM message counts and the thread count into the title', async () => {
    mockState.channelUnreadCounts = new Map([['ch-1', 2], ['ch-2', 1]]);
    mockState.conversationUnreadCounts = new Map([['conv-1', 3]]);
    mockState.threads = [
      makeThread({ threadRootID: 'root-unread', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
      makeThread({ threadRootID: 'root-seen', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
    ];
    localStorage.setItem(
      'ex.threads.seen.v1',
      JSON.stringify({
        'root-unread': '2026-05-04T07:59:00.000Z',
        'root-seen': '2026-05-04T08:01:00.000Z',
      }),
    );

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    // 2 + 1 (channels) + 3 (DM) + 1 (unread thread) = 7
    await waitFor(() => {
      expect(document.title).toBe('(7) Threads · ex');
    });
  });

  it('climbs as more messages arrive in a single channel (was stuck at 1)', async () => {
    mockState.channelUnreadCounts = new Map([['ch-1', 1]]);
    const { rerender } = render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));

    mockState.channelUnreadCounts = new Map([['ch-1', 4]]);
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(4) Threads · ex'));
  });

  it('drops thread unread count when a thread is marked seen', async () => {
    mockState.threads = [
      makeThread({ threadRootID: 'root-unread', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
    ];
    localStorage.setItem(
      'ex.threads.seen.v1',
      JSON.stringify({ 'root-unread': '2026-05-04T07:59:00.000Z' }),
    );
    const { markThreadSeen } = await import('@/hooks/useThreads');

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
    act(() => {
      markThreadSeen('root-unread', '2026-05-04T08:01:00.000Z');
    });
    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('reflects a DM unread count appearing and clearing', async () => {
    mockState.threads = [
      makeThread({ threadRootID: 'existing-thread', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
    ];

    const { rerender } = render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('Threads · ex'));

    mockState.conversationUnreadCounts = new Map([['conv-1', 1]]);
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));

    mockState.conversationUnreadCounts = new Map();
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('counts a server-seeded unread conversation', async () => {
    mockState.conversationUnreadCounts = new Map([['conv-1', 1]]);

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
  });

  it('counts a DM as exactly its single source count (no double-count)', async () => {
    // The count map is the single source — there is no separate live set to
    // sum against, so one unread DM message is exactly "(1)", never "(2)".
    mockState.conversationUnreadCounts = new Map([['conv-1', 1]]);

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
  });

  it('counts thread notifications in addition to the unread DM parent', async () => {
    mockState.conversationUnreadCounts = new Map([['conv-1', 1]]);
    mockState.unreadThreadNotifications = new Set(['root-in-dm']);
    mockState.threads = [
      makeThread({
        parentID: 'conv-1',
        parentType: 'conversation',
        threadRootID: 'root-in-dm',
        latestActivityAt: '2026-05-04T08:00:00.000Z',
      }),
    ];

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(2) Threads · ex'));
  });

  it('does not count stale thread notifications when the thread is not listed', async () => {
    mockState.unreadThreadNotifications = new Set(['root-orphan']);
    mockState.threads = [];

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('does not double-count the same unread thread from notification and thread activity', async () => {
    mockState.unreadThreadNotifications = new Set(['root-unread']);
    mockState.threads = [
      makeThread({ threadRootID: 'root-unread', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
    ];
    localStorage.setItem(
      'ex.threads.seen.v1',
      JSON.stringify({ 'root-unread': '2026-05-04T07:59:00.000Z' }),
    );

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
  });

  it('local thread seen state overrides a stale persisted thread notification', async () => {
    mockState.threadNotifications = ['root-unread'];
    mockState.threads = [
      makeThread({ threadRootID: 'root-unread', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
    ];
    localStorage.setItem(
      'ex.threads.seen.v1',
      JSON.stringify({ 'root-unread': '2026-05-04T08:01:00.000Z' }),
    );

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('does not count unread notifications while signed out', async () => {
    mockState.isAuthenticated = false;
    mockState.channelUnreadCounts = new Map([['ch-1', 2]]);
    mockState.conversationUnreadCounts = new Map([['conv-1', 1]]);
    mockState.unreadThreadNotifications = new Set(['root-unread']);
    mockState.threads = [
      makeThread({ threadRootID: 'root-unread', latestActivityAt: '2026-05-04T08:00:00.000Z' }),
    ];

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });
});

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    parentID: 'ch-1',
    parentType: 'channel',
    threadRootID: 'root',
    rootAuthorID: 'u-1',
    rootBody: 'hello',
    rootCreatedAt: '2026-05-04T07:00:00.000Z',
    replyCount: 1,
    latestActivityAt: '2026-05-04T08:00:00.000Z',
    ...overrides,
  };
}
