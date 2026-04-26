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
let permissionSpy: string | null = null;

function Probe() {
  const { dispatch, setActiveParent, permission } = useNotifications();
  useEffect(() => {
    dispatchSpy = dispatch;
    setActiveSpy = setActiveParent;
    permissionSpy = permission;
  }, [dispatch, setActiveParent, permission]);
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
    dispatchSpy = null;
    setActiveSpy = null;
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

  it('falls back to no-op when used outside the provider', () => {
    // Render Probe without NotificationProvider — useNotifications returns
    // safe defaults so unrelated tests don't have to set up the context.
    render(<Probe />);
    expect(() => dispatchSpy!(samplePayload)).not.toThrow();
    expect(playMock).not.toHaveBeenCalled();
  });
});
