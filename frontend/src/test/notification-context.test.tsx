import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, screen } from '@testing-library/react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from '@/context/NotificationContext';

const playMock = vi.fn();
vi.mock('@/lib/notification-sound', () => ({
  playNotificationPing: () => playMock(),
}));

const toastMock = vi.fn();
vi.mock('sonner', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

const samplePayload: NotificationPayload = {
  kind: 'message',
  title: 'Alice in #general',
  body: 'hello there',
  deepLink: '/channel/general',
  parentID: 'ch-1',
  parentType: 'channel',
  messageID: 'm-1',
  createdAt: new Date().toISOString(),
};

let dispatchSpy: ((n: NotificationPayload) => void) | null = null;
let setActiveSpy: ((id: string | null) => void) | null = null;
let setUserSpy: ((id: string | null) => void) | null = null;
let permissionSpy: string | null = null;

function Probe() {
  const { dispatch, setActiveParent, setCurrentUserID, permission } = useNotifications();
  useEffect(() => {
    dispatchSpy = dispatch;
    setActiveSpy = setActiveParent;
    setUserSpy = setCurrentUserID;
    permissionSpy = permission;
  }, [dispatch, setActiveParent, setCurrentUserID, permission]);
  return <div data-testid="probe">{permission}</div>;
}

function renderProbe() {
  return render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
}

describe('NotificationProvider', () => {
  let origNotification: typeof Notification | undefined;
  let notificationCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    playMock.mockReset();
    toastMock.mockReset();
    dispatchSpy = null;
    setActiveSpy = null;
    setUserSpy = null;
    permissionSpy = null;
    localStorage.clear();
    sessionStorage.clear();
    origNotification = (window as unknown as { Notification?: typeof Notification }).Notification;
    notificationCtor = vi.fn().mockImplementation(() => ({ onclick: null, close: () => {} }));
    Object.defineProperty(window, 'Notification', {
      value: Object.assign(notificationCtor, {
        permission: 'granted',
        requestPermission: vi.fn().mockResolvedValue('granted'),
      }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  });

  afterEach(() => {
    if (origNotification) {
      Object.defineProperty(window, 'Notification', { value: origNotification, configurable: true });
    }
  });

  it('plays sound and creates browser notification on dispatch', () => {
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor.mock.calls[0][0]).toBe('Alice in #general');
  });

  it('suppresses notifications for the active parent (already on screen)', () => {
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!(samplePayload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('still fires browser notification when document is visible (regression: previously gated)', () => {
    // The old behavior suppressed popups whenever the tab was focused,
    // which made users believe notifications were broken — they only
    // heard the sound. Now the popup always fires while permission is
    // granted; active-parent suppression alone handles the on-screen case.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('reports permission=granted when Notification.permission is granted', () => {
    renderProbe();
    expect(screen.getByTestId('probe').textContent).toBe('granted');
    expect(permissionSpy).toBe('granted');
  });

  it('suppresses notifications for the viewer\'s own messages echoed back', () => {
    renderProbe();
    act(() => {
      setUserSpy!('u-me');
      dispatchSpy!({ ...samplePayload, authorID: 'u-me' });
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('still fires when authorID does not match the current user', () => {
    renderProbe();
    act(() => {
      setUserSpy!('u-me');
      dispatchSpy!({ ...samplePayload, authorID: 'u-other' });
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('still fires popups for mentions even when on the active parent', () => {
    // Mentions are personal — a user might be on the channel but scrolled
    // far away, or have it open in a background tab. They should always
    // hear/see a mention popup so the alert isn't silently dropped.
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!({ ...samplePayload, kind: 'mention' });
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('still fires popups for thread replies even when on the active parent', () => {
    // Thread replies live in a side panel that may not be open. Suppressing
    // them just because the parent channel is on screen made replies
    // invisible — fire popups regardless of active parent.
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!({ ...samplePayload, kind: 'thread_reply' });
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('always fires an in-app toast on dispatch (popup that works without OS permission)', () => {
    // The OS Notification API has many barriers (default-permission,
    // focus rules on Safari, OS DnD). The in-app toast is the primary
    // popup so the user always sees something — the OS popup is a bonus.
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toBe('Alice in #general');
    const opts = toastMock.mock.calls[0][1] as { description: string; action?: { label: string } };
    expect(opts.description).toBe('hello there');
    expect(opts.action?.label).toBe('Open');
  });

  it('still fires the in-app toast when OS permission is "default" (never granted)', () => {
    // If the user never clicked "Enable" on the prompt, Notification
    // permission stays "default" and the OS popup is silent. The toast
    // must still appear so the user gets feedback.
    Object.defineProperty(window, 'Notification', {
      value: Object.assign(vi.fn(), {
        permission: 'default',
        requestPermission: vi.fn().mockResolvedValue('default'),
      }),
      configurable: true,
      writable: true,
    });
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire a toast when the active parent suppresses the notification', () => {
    // Active-parent suppression for a regular message also drops the
    // toast — the user is already looking at the message; doubling up
    // with a popup is noise.
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!(samplePayload);
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('falls back to no-op when used outside the provider', () => {
    // Render Probe without NotificationProvider — useNotifications returns
    // safe defaults so unrelated tests don't have to set up the context.
    render(<Probe />);
    expect(() => dispatchSpy!(samplePayload)).not.toThrow();
    expect(playMock).not.toHaveBeenCalled();
  });
});
