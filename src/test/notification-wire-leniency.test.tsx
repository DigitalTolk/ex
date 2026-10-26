import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { NotificationProvider, useNotifications, type NotificationPayload } from '@/context/NotificationContext';
import { resetNotificationDedup } from '@/lib/notification-dedup';
import { deliverFrame, expectInvalidPayloadReported, wsHandlers } from '@/test/ws-frames';

// A notification.new frame end to end: socket payload → the registry's
// (lenient) schema → NotificationContext → an OS banner. The backend already
// decided this user must be alerted, so nothing about the payload's shape
// beyond kind + parentID may stop the banner.

vi.mock('@/lib/notification-sound', () => ({ playNotificationPing: vi.fn(), playApprovalChime: vi.fn() }));
vi.mock('@/lib/ws-sender', () => ({ sendWS: vi.fn(), setWSSender: vi.fn() }));

let dispatch: ((n: NotificationPayload) => void) | null = null;
function Probe() {
  const ctx = useNotifications();
  useEffect(() => {
    dispatch = ctx.dispatch;
  }, [ctx.dispatch]);
  return null;
}

function installNotification() {
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

describe('notification.new payload leniency', () => {
  let original: PropertyDescriptor | undefined;
  let banner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetNotificationDedup();
    original = Object.getOwnPropertyDescriptor(window, 'Notification');
    banner = installNotification();
    render(
      <NotificationProvider>
        <Probe />
      </NotificationProvider>,
    );
  });

  afterEach(() => {
    dispatch = null;
    if (original) Object.defineProperty(window, 'Notification', original);
  });

  function deliver(payload: unknown) {
    const opts = { handlers: wsHandlers({ 'notification.new': (n) => dispatch!(n) }) };
    act(() => deliverFrame(opts, 'notification.new', payload));
  }

  it('surfaces a notification with unexpected, extra and missing optional fields', () => {
    deliver({
      kind: 'mention',
      parentID: 'ch-1',
      parentType: 'a-kind-of-parent-from-the-future',
      title: 'Alice in ~general',
      body: 'disk at 95%',
      // missing: deepLink, createdAt, messageID
      webhook: 'yes',
      parentUnreadNotifyCount: 'many',
      priority: 'p1',
      tags: ['incident'],
    });
    expect(banner).toHaveBeenCalledTimes(1);
    expect(banner).toHaveBeenCalledWith('Alice in ~general', expect.objectContaining({ body: 'disk at 95%' }));
  });

  it('surfaces a kind the client has no special handling for', () => {
    deliver({ kind: 'catchup', parentID: 'ch-1', title: 'Watcher backlog', messageID: 'm-1' });
    expect(banner).toHaveBeenCalledWith('Watcher backlog', expect.anything());
  });

  it('reports, rather than silently drops, a payload with nothing to route on', () => {
    expectInvalidPayloadReported('notification.new', () => deliver({ title: 'no kind', body: 'no parent' }));
    expect(banner).not.toHaveBeenCalled();
  });
});
