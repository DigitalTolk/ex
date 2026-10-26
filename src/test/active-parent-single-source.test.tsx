import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NotificationProvider, useNotifications, type NotificationPayload } from '@/context/NotificationContext';
import { UnreadProvider, useUnread } from '@/context/UnreadContext';
import { useParentChat } from '@/hooks/useParentChat';
import { markUserActivity } from '@/lib/user-activity';
import { resetNotificationDedup } from '@/lib/notification-dedup';
import { activeParentID, useActiveParentStore } from '@/stores/active-parent';

// The open chat is recorded ONCE (stores/active-parent, set by useParentChat);
// unread's "viewing this parent", notification suppression and the tab
// election's broadcast all read that record — they used to keep a copy each.

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch,
}));
vi.mock('@/lib/notification-sound', () => ({ playNotificationPing: vi.fn(), playApprovalChime: vi.fn() }));
const sendWS = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ws-sender', () => ({ sendWS, setWSSender: vi.fn() }));

let probe: { dispatch: (n: NotificationPayload) => void; isActiveChannel: (id: string) => boolean } | null = null;
function Probe() {
  const { dispatch } = useNotifications();
  const { isActiveChannel } = useUnread();
  useEffect(() => {
    probe = { dispatch, isActiveChannel };
  }, [dispatch, isActiveChannel]);
  return null;
}

function OpenChat({ kind, id }: { kind: 'channel' | 'conversation'; id: string }) {
  useParentChat({ kind, id, userID: 'u-me' });
  return null;
}

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <UnreadProvider>
          <NotificationProvider>
            <Probe />
            {children}
          </NotificationProvider>
        </UnreadProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function alert(parentID: string, messageID: string): NotificationPayload {
  return { kind: 'message', title: 'Alice', body: 'hi', deepLink: '/', parentID, parentType: 'channel', messageID };
}

describe('the active parent is one record', () => {
  let banner: ReturnType<typeof vi.fn>;
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue([]);
    sendWS.mockReset();
    resetNotificationDedup();
    original = Object.getOwnPropertyDescriptor(window, 'Notification');
    banner = vi.fn().mockImplementation(function NotificationStub() {
      return { onclick: null, close: () => {} };
    });
    Object.defineProperty(window, 'Notification', {
      value: Object.assign(banner, { permission: 'granted', requestPermission: vi.fn() }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  afterEach(() => {
    probe = null;
    if (original) Object.defineProperty(window, 'Notification', original);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  });

  it('opening a chat makes it the parent unread, notifications and the tab election see', () => {
    const { rerender, unmount } = render(<OpenChat kind="channel" id="ch-1" />, { wrapper: Providers });
    expect(useActiveParentStore.getState().parent).toEqual({ kind: 'channel', id: 'ch-1' });
    expect(probe!.isActiveChannel('ch-1')).toBe(true);

    // Looking at it: its alert surfaces nothing (and acks), another parent's does.
    act(() => {
      window.dispatchEvent(new Event('focus'));
      markUserActivity();
      probe!.dispatch(alert('ch-1', 'm-1'));
    });
    expect(banner).not.toHaveBeenCalled();
    expect(sendWS).toHaveBeenCalledWith({ type: 'notification.ack', messageID: 'm-1' }, expect.anything());
    act(() => probe!.dispatch(alert('ch-2', 'm-2')));
    expect(banner).toHaveBeenCalledTimes(1);

    // Switching chats moves the one record.
    rerender(<OpenChat kind="conversation" id="dm-1" />);
    expect(useActiveParentStore.getState().parent).toEqual({ kind: 'conversation', id: 'dm-1' });
    expect(probe!.isActiveChannel('ch-1')).toBe(false);

    // Closing it leaves nothing open: the channel's alerts surface again.
    unmount();
    expect(activeParentID()).toBeNull();
  });

  it('a closed chat no longer suppresses its alerts', () => {
    const { unmount } = render(<OpenChat kind="channel" id="ch-1" />, { wrapper: Providers });
    unmount();
    render(<span />, { wrapper: Providers });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      markUserActivity();
      probe!.dispatch(alert('ch-1', 'm-3'));
    });
    expect(banner).toHaveBeenCalledTimes(1);
  });

  it('opening a chat reads it through the one mark-read write', async () => {
    apiFetch.mockImplementation(async (path: string) => (path === '/api/v1/channels/ch-1/read' ? undefined : []));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', unreadCount: 2 }]);
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <OpenChat kind="channel" id="ch-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' }));
    expect(qc.getQueryData<{ unreadCount: number }[]>(['userChannels'])?.[0].unreadCount).toBe(0);
  });
});
