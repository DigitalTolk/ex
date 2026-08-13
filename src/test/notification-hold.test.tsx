import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from '@/context/NotificationContext';
import { recordNotification, resetNotificationDedup } from '@/lib/notification-dedup';
import { markUserActivity, resetUserActivityForTests } from '@/lib/user-activity';

// The non-leader hold path (SPEC GAP-13): a non-leader tab must hold a
// notification while the leader surfaces it — but if TWO holds pass and
// nobody recorded the alert, the leader is gone/wedged and this tab surfaces
// anyway (a possible duplicate beats a silent miss).

const leaderState = { isLeader: false };

vi.mock('@/lib/tab-leader', () => ({
  isLeaderTab: () => leaderState.isLeader,
  hasOtherTabs: () => true,
  setTabActiveParent: vi.fn(),
  remoteTabViewing: () => false,
  remoteTabViewingThread: () => false,
  remoteUserAtDevice: () => false,
  nonLeaderHoldMs: 1500,
}));

const playMock = vi.fn();
vi.mock('@/lib/notification-sound', () => ({
  playNotificationPing: () => playMock(),
}));

vi.mock('@/lib/ws-sender', () => ({
  sendWS: vi.fn(),
  setWSSender: vi.fn(),
}));

const payload: NotificationPayload = {
  kind: 'message',
  title: 'Alice',
  body: 'incident!',
  deepLink: '/conversation/dm-1',
  parentID: 'dm-1',
  parentType: 'conversation',
  messageID: 'm-held',
  createdAt: new Date().toISOString(),
};

let dispatchSpy: ((n: NotificationPayload) => void) | null = null;

function Probe() {
  const { dispatch } = useNotifications();
  useEffect(() => {
    dispatchSpy = dispatch;
  }, [dispatch]);
  return null;
}

function installNotification(): ReturnType<typeof vi.fn> {
  const ctor = vi.fn().mockImplementation(function NotificationStub() {
    return { onclick: null, close: () => {} };
  });
  Object.defineProperty(window, 'Notification', {
    value: Object.assign(ctor, { permission: 'granted', requestPermission: vi.fn() }),
    configurable: true,
    writable: true,
  });
  return ctor;
}

describe('non-leader hold', () => {
  let notificationCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    leaderState.isLeader = false;
    playMock.mockReset();
    resetNotificationDedup();
    resetUserActivityForTests();
    localStorage.clear();
    notificationCtor = installNotification();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    render(
      <NotificationProvider>
        <Probe />
      </NotificationProvider>,
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
      markUserActivity();
    });
  });

  afterEach(() => {
    resetUserActivityForTests();
    vi.useRealTimers();
  });

  it('stays quiet while held, then surfaces on promotion to leader', () => {
    act(() => dispatchSpy!(payload));
    expect(notificationCtor).not.toHaveBeenCalled();
    leaderState.isLeader = true; // old leader closed; election promoted us
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('drops the held copy when the leader records it meanwhile (dedup wins)', () => {
    act(() => dispatchSpy!(payload));
    recordNotification('m-held', Date.now()); // the leader surfaced it
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('surfaces anyway after TWO holds with no leader delivery (GAP-13: duplicate beats silent miss)', () => {
    act(() => dispatchSpy!(payload));
    act(() => {
      vi.advanceTimersByTime(1500); // first hold: still non-leader, un-deduped → hold again
    });
    expect(notificationCtor).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1500); // second hold: leader never delivered → surface here
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });
});
