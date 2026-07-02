import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { resetSeenCache, type ThreadSummary } from '@/hooks/useThreads';
import { NotificationCountTitleBridge } from './NotificationCountTitleBridge';

// The title bridge sums the server-computed per-target unread MESSAGE counts
// straight from the channel/conversation list cache (the same single source the
// sidebar badges read) plus the unread-thread count — so multiple messages in
// one parent climb the tab title instead of being collapsed to a single "(1)".
const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  unreadThreadNotifications: new Set<string>(),
  threads: [] as ThreadSummary[],
  threadNotifications: [] as string[],
  threadSeen: {} as Record<string, string>,
  channels: [] as { channelID: string; muted?: boolean; unreadCount?: number }[],
  conversations: [] as { conversationID: string; unreadCount?: number }[],
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: mockState.isAuthenticated }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
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
  markLocalUserStateWrite: vi.fn(),
  shouldRefetchUserStateForRemoteUpdate: vi.fn(() => true),
  resetUserStateSessionState: vi.fn(),
  useUserState: () => ({
    data: {
      threadNotifications: mockState.threadNotifications,
      threadSeen: { ...mockState.threadSeen, ...JSON.parse(localStorage.getItem('ex.threads.seen.v1') ?? '{}') },
      hiddenConversations: [],
    },
  }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: mockState.channels }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useUserConversations: () => ({ data: mockState.conversations }),
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
    mockState.unreadThreadNotifications = new Set();
    mockState.threads = [];
    mockState.threadNotifications = [];
    mockState.threadSeen = {};
    mockState.channels = [];
    mockState.conversations = [];
  });

  afterEach(() => {
    act(() => {
      setDocumentNotificationCount(0);
    });
  });

  it('sums channel + DM message counts and the thread count into the title', async () => {
    mockState.channels = [
      { channelID: 'ch-1', unreadCount: 2 },
      { channelID: 'ch-2', unreadCount: 1 },
    ];
    mockState.conversations = [{ conversationID: 'conv-1', unreadCount: 3 }];
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
    mockState.channels = [{ channelID: 'ch-1', unreadCount: 1 }];
    const { rerender } = render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));

    mockState.channels = [{ channelID: 'ch-1', unreadCount: 4 }];
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(4) Threads · ex'));
  });

  it('excludes muted channels from the title count (muted = quiet)', async () => {
    mockState.channels = [
      { channelID: 'ch-loud', unreadCount: 3 },
      { channelID: 'ch-muted', muted: true, unreadCount: 50 },
    ];
    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    // Only the non-muted channel's 3 counts; the muted channel's 50 are ignored.
    await waitFor(() => expect(document.title).toBe('(3) Threads · ex'));
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

    mockState.conversations = [{ conversationID: 'conv-1', unreadCount: 1 }];
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));

    mockState.conversations = [];
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('counts a server-seeded unread conversation', async () => {
    mockState.conversations = [{ conversationID: 'conv-1', unreadCount: 1 }];

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
  });

  it('counts a DM as exactly its single source count (no double-count)', async () => {
    // The list cache is the single source — there is no separate live set to
    // sum against, so one unread DM message is exactly "(1)", never "(2)".
    mockState.conversations = [{ conversationID: 'conv-1', unreadCount: 1 }];

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
  });

  it('counts thread notifications in addition to the unread DM parent', async () => {
    mockState.conversations = [{ conversationID: 'conv-1', unreadCount: 1 }];
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
    mockState.channels = [{ channelID: 'ch-1', unreadCount: 2 }];
    mockState.conversations = [{ conversationID: 'conv-1', unreadCount: 1 }];
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
