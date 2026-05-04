import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { setDocumentNotificationCount } from '@/lib/document-title';
import type { ThreadSummary } from '@/hooks/useThreads';
import { NotificationCountTitleBridge } from './NotificationCountTitleBridge';

const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  unreadChannels: new Set<string>(),
  unreadChannelNotifications: new Set<string>(),
  unreadConversations: new Set<string>(),
  unreadThreadNotifications: new Set<string>(),
  threads: [] as ThreadSummary[],
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: mockState.isAuthenticated }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: mockState.unreadChannels,
    unreadChannelNotifications: mockState.unreadChannelNotifications,
    unreadConversations: mockState.unreadConversations,
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
      channelNotifications: [],
      threadNotifications: [],
      threadSeen: JSON.parse(localStorage.getItem('ex.threads.seen.v1') ?? '{}'),
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
    act(() => {
      setDocumentNotificationCount(0);
    });
    document.title = 'ex';
    mockState.isAuthenticated = true;
    mockState.unreadChannels = new Set();
    mockState.unreadChannelNotifications = new Set();
    mockState.unreadConversations = new Set();
    mockState.unreadThreadNotifications = new Set();
    mockState.threads = [];
  });

  afterEach(() => {
    act(() => {
      setDocumentNotificationCount(0);
    });
  });

  it('prefixes the document title with channel ping, DM, and thread unread totals', async () => {
    mockState.unreadChannels = new Set(['ch-1', 'ch-2']);
    mockState.unreadChannelNotifications = new Set(['ch-2']);
    mockState.unreadConversations = new Set(['conv-1']);
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

    await waitFor(() => {
      expect(document.title).toBe('(3) Threads · ex');
    });
  });

  it('does not count ordinary unread channel messages', async () => {
    mockState.unreadChannels = new Set(['ch-1']);

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('Threads · ex'));
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

  it('does not count existing unbaselined threads as unread DMs arrive and clear', async () => {
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

    mockState.unreadConversations = new Set(['conv-1']);
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));

    mockState.unreadConversations = new Set();
    rerender(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );
    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('counts thread notifications in addition to the unread DM parent', async () => {
    mockState.unreadConversations = new Set(['conv-1']);
    mockState.unreadThreadNotifications = new Set(['root-in-dm']);

    render(
      <>
        <NotificationCountTitleBridge />
        <TitleConsumer />
      </>,
    );

    await waitFor(() => expect(document.title).toBe('(2) Threads · ex'));
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

  it('does not count unread notifications while signed out', async () => {
    mockState.isAuthenticated = false;
    mockState.unreadChannels = new Set(['ch-1']);
    mockState.unreadChannelNotifications = new Set(['ch-1']);
    mockState.unreadConversations = new Set(['conv-1']);
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
