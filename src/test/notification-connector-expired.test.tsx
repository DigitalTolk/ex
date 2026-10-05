// A connector whose credential died is not a message: no parent, no author,
// nothing to dedup by messageID. It must surface anyway — and it must surface
// even where OS notifications are unavailable, because an agent telling the
// person to "press Reconnect" points at something they were never shown.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from '@/context/NotificationContext';
import { resetNotificationDedup } from '@/lib/notification-dedup';

const playMock = vi.fn();
const approvalChimeMock = vi.fn();
vi.mock('@/lib/notification-sound', () => ({
  playNotificationPing: () => playMock(),
  playApprovalChime: () => approvalChimeMock(),
}));

vi.mock('@/lib/ws-sender', () => ({ sendWS: vi.fn(), setWSSender: vi.fn() }));

const toastMock = vi.fn();
vi.mock('@/lib/toast', () => ({ showToast: (...a: unknown[]) => toastMock(...a) }));

const attentionMock = vi.fn();
vi.mock('@/lib/attention', () => ({ requestOsAttention: () => attentionMock() }));


let dispatchSpy: ((n: NotificationPayload) => void) | null = null;

function Probe() {
  const { dispatch } = useNotifications();
  useEffect(() => {
    dispatchSpy = dispatch;
  }, [dispatch]);
  return <div data-testid="probe" />;
}

function renderProbe() {
  return render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
}

function installNotification(permission: NotificationPermission, opts: { throws?: boolean } = {}) {
  const instances: { onclick: null | (() => void); close: () => void }[] = [];
  const ctor = vi.fn().mockImplementation(function NotificationStub() {
    if (opts.throws) throw new Error('webview says no');
    const inst = { onclick: null, close: vi.fn() };
    instances.push(inst);
    return inst;
  });
  Object.defineProperty(window, 'Notification', {
    value: Object.assign(ctor, { permission, requestPermission: vi.fn().mockResolvedValue(permission) }),
    configurable: true,
    writable: true,
  });
  return { ctor, instances };
}

function expiredFx(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    kind: 'connector_expired',
    title: 'TolkCRM needs reconnecting',
    body: 'Your TolkCRM session expired, so agents can no longer use it.',
    deepLink: '/agents/connectors',
    parentID: '',
    parentType: 'channel',
    createdAt: new Date().toISOString(),
    ...over,
  } as NotificationPayload;
}

beforeEach(() => {
  resetNotificationDedup();
  toastMock.mockClear();
  attentionMock.mockClear();
  window.history.pushState(null, '', '/');
});

afterEach(() => {
  dispatchSpy = null;
});

describe('connector-expired alerts', () => {
  it('raises an OS banner that lands on the connectors page', () => {
    const { ctor, instances } = installNotification('granted');
    renderProbe();
    act(() => dispatchSpy?.(expiredFx()));

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toBe('TolkCRM needs reconnecting');
    expect(attentionMock).toHaveBeenCalled();
    // Clicking it goes where the fix is.
    // navigateInApp is SPA navigation, not a reload: assert the URL moved.
    act(() => instances[0].onclick?.());
    expect(window.location.pathname).toBe('/agents/connectors');
  });

  it('falls back to a toast when the OS will not show one', () => {
    installNotification('denied');
    renderProbe();
    act(() => dispatchSpy?.(expiredFx()));

    expect(toastMock).toHaveBeenCalledTimes(1);
    const [body, variant, opts] = toastMock.mock.calls[0] as [string, string, { title: string; onActivate: () => void }];
    expect(body).toContain('session expired');
    expect(variant).toBe('error');
    expect(opts.title).toBe('TolkCRM needs reconnecting');
    act(() => opts.onActivate());
    expect(window.location.pathname).toBe('/agents/connectors');
  });

  it('toasts when the Notification constructor throws in a webview', () => {
    installNotification('granted', { throws: true });
    renderProbe();
    act(() => dispatchSpy?.(expiredFx()));
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('alerts once however many tabs receive the same event', () => {
    installNotification('denied');
    renderProbe();
    act(() => dispatchSpy?.(expiredFx()));
    act(() => dispatchSpy?.(expiredFx()));
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('is never suppressed by what the person happens to be reading', () => {
    installNotification('denied');
    renderProbe();
    // An expired credential is theirs alone to fix, so unlike a message it
    // alerts even while they stare at a channel.
    act(() => dispatchSpy?.(expiredFx({ parentID: 'c-1', parentMessageID: 'm-1' } as Partial<NotificationPayload>)));
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
