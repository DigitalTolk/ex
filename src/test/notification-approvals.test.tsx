import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, waitFor } from '@testing-library/react';
import {
  NotificationProvider,
  useNotifications,
  type ApprovalAlert,
} from '@/context/NotificationContext';
import { resetNotificationDedup } from '@/lib/notification-dedup';
import { markUserActivity, setHardAway } from '@/lib/user-activity';

const playMock = vi.fn();
const approvalChimeMock = vi.fn();
vi.mock('@/lib/notification-sound', () => ({
  playNotificationPing: () => playMock(),
  playApprovalChime: () => approvalChimeMock(),
}));

const sendWSMock = vi.fn();
vi.mock('@/lib/ws-sender', () => ({
  sendWS: (payload: unknown) => sendWSMock(payload),
  setWSSender: vi.fn(),
}));

const idleDetectorMock = vi.hoisted(() => ({
  start: vi.fn(async () => true),
  stop: vi.fn(),
}));
vi.mock('@/lib/idle-detector', () => ({
  startIdleDetection: idleDetectorMock.start,
  stopIdleDetection: idleDetectorMock.stop,
}));

const toastMock = vi.fn();
vi.mock('@/lib/toast', () => ({
  showToast: (...args: unknown[]) => toastMock(...args),
}));

const attentionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/attention', () => ({
  requestOsAttention: attentionMock,
}));

const apiFetchMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: apiFetchMock,
}));

let notifyApprovalSpy: ((a: ApprovalAlert) => void) | null = null;
let setSoundSpy: ((v: boolean) => void) | null = null;
let setBrowserSpy: ((v: boolean) => void) | null = null;

function Probe() {
  const { notifyApproval, setSoundEnabled, setBrowserEnabled } = useNotifications();
  useEffect(() => {
    notifyApprovalSpy = notifyApproval;
    setSoundSpy = setSoundEnabled;
    setBrowserSpy = setBrowserEnabled;
  }, [notifyApproval, setSoundEnabled, setBrowserEnabled]);
  return <div data-testid="probe" />;
}

function renderProbe() {
  return render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
}

type NotificationInstance = { onclick: null | (() => void); onclose: null | (() => void); close: () => void };

function installNotification(permission: NotificationPermission, opts: { throws?: boolean } = {}) {
  const instances: NotificationInstance[] = [];
  const ctor = vi.fn().mockImplementation(function NotificationStub() {
    if (opts.throws) throw new Error('webview says no');
    const inst: NotificationInstance = { onclick: null, onclose: null, close: vi.fn() };
    instances.push(inst);
    return inst;
  });
  Object.defineProperty(window, 'Notification', {
    value: Object.assign(ctor, {
      permission,
      requestPermission: vi.fn().mockResolvedValue(permission),
    }),
    configurable: true,
    writable: true,
  });
  return { ctor, instances };
}

function alertFx(over: Partial<ApprovalAlert> = {}): ApprovalAlert {
  return {
    approvalID: 'ap-1',
    runID: 'run-1',
    parentID: 'c-1',
    parentType: 'channel',
    agentName: 'gg',
    summary: 'wants to run rm',
    messageID: 'm-1',
    deepLink: '/channel/c-1',
    ...over,
  };
}

describe('useNotifications outside a provider', () => {
  it('returns a noop notifyApproval so bare components can render', () => {
    let noop: ((a: ApprovalAlert) => void) | undefined;
    function Bare() {
      const { notifyApproval } = useNotifications();
      useEffect(() => {
        noop = notifyApproval;
      }, [notifyApproval]);
      return null;
    }
    render(<Bare />);
    expect(() => noop?.(alertFx())).not.toThrow();
  });
});

describe('NotificationProvider — approval alerts', () => {
  let origNotification: typeof Notification | undefined;

  beforeEach(() => {
    playMock.mockReset();
    approvalChimeMock.mockReset();
    sendWSMock.mockReset();
    toastMock.mockReset();
    attentionMock.mockReset();
    apiFetchMock.mockClear();
    apiFetchMock.mockImplementation(() => Promise.resolve({}));
    notifyApprovalSpy = null;
    resetNotificationDedup();
    localStorage.clear();
    sessionStorage.clear();
    origNotification = (window as unknown as { Notification?: typeof Notification }).Notification;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  });

  afterEach(() => {
    delete (window as Window & { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
    delete (window as Window & { __EX_APPROVAL_NOTIFY__?: unknown }).__EX_APPROVAL_NOTIFY__;
    setHardAway('test', false);
    if (origNotification) {
      Object.defineProperty(window, 'Notification', { value: origNotification, configurable: true });
    }
  });

  function arm({ sound = true, browser = true } = {}) {
    renderProbe();
    act(() => {
      setSoundSpy?.(sound);
      setBrowserSpy?.(browser);
    });
  }

  it('ignores alerts without an approvalID', () => {
    const { ctor } = installNotification('granted');
    arm();
    act(() => notifyApprovalSpy?.(alertFx({ approvalID: '' })));
    expect(ctor).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('raises a silent persistent banner with the agent glyph title, pings, flags the OS and dedupes', () => {
    const { ctor, instances } = installNotification('granted');
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
    arm();
    act(() => {
      markUserActivity();
      notifyApprovalSpy?.(alertFx());
    });
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith(
      '✋ gg needs your approval',
      expect.objectContaining({ body: 'wants to run rm', silent: true, requireInteraction: true, icon: '/logo.svg' }),
    );
    expect(approvalChimeMock).toHaveBeenCalledTimes(1);
    expect(playMock).not.toHaveBeenCalled();
    expect(attentionMock).toHaveBeenCalledTimes(1);
    // Attentive device → desktop claims delivery (ack over the socket).
    expect(sendWSMock).toHaveBeenCalled();

    // Clicking focuses and deep-links; closing detaches the handlers.
    act(() => instances[0].onclick?.());
    expect(focusSpy).toHaveBeenCalled();
    act(() => instances[0].onclose?.());
    expect(instances[0].onclick).toBeNull();

    // Same approval again: deduped.
    act(() => notifyApprovalSpy?.(alertFx()));
    expect(ctor).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
  });

  it('omits the web icon under the desktop shell and skips the deep link when absent', () => {
    (window as Window & { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__ = true;
    const { ctor, instances } = installNotification('granted');
    arm({ sound: false });
    act(() => notifyApprovalSpy?.(alertFx({ deepLink: '', summary: '' })));
    const opts = ctor.mock.calls[0][1] as NotificationOptions;
    expect('icon' in opts).toBe(false);
    // Empty summary falls back to instructions.
    expect(opts.body).toBe('Open the conversation to decide.');
    expect(approvalChimeMock).not.toHaveBeenCalled();
    // Clicking without a deep link still focuses without navigating.
    act(() => instances[0].onclick?.());
  });

  it('hands the gate to the desktop shell with capped choices and skips the web banner', () => {
    const { ctor } = installNotification('granted');
    const shellNotify = vi.fn();
    (window as Window & { __EX_APPROVAL_NOTIFY__?: unknown }).__EX_APPROVAL_NOTIFY__ = shellNotify;
    arm();
    act(() =>
      notifyApprovalSpy?.(
        alertFx({ asksChoice: true, options: ['a', 'b', 'c', 'd', 'e'] }),
      ),
    );
    expect(shellNotify).toHaveBeenCalledWith({
      approvalID: 'ap-1',
      runID: 'run-1',
      title: '❓ gg needs your input',
      body: 'wants to run rm',
      choices: ['a', 'b', 'c', 'd'],
    });
    expect(ctor).not.toHaveBeenCalled();

    // A question without options sends no choices.
    act(() => notifyApprovalSpy?.(alertFx({ approvalID: 'ap-2', asksChoice: true })));
    expect(shellNotify).toHaveBeenLastCalledWith(expect.objectContaining({ choices: undefined }));
  });

  it('falls back to the web banner when the shell bridge throws', () => {
    const { ctor } = installNotification('granted');
    (window as Window & { __EX_APPROVAL_NOTIFY__?: unknown }).__EX_APPROVAL_NOTIFY__ = vi.fn(() => {
      throw new Error('bridge gone');
    });
    arm();
    act(() => notifyApprovalSpy?.(alertFx({ agentName: undefined, asksChoice: true, options: ['x'] })));
    expect(ctor).toHaveBeenCalledWith('❓ An agent needs your input', expect.anything());
  });

  it('falls back to a top notification toast when the constructor throws, and titles a generic gate', () => {
    installNotification('granted', { throws: true });
    arm();
    act(() => notifyApprovalSpy?.(alertFx({ agentName: undefined })));
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [body, variant, opts] = toastMock.mock.calls[0] as [string, string, { title: string; kind: string; onActivate: () => void }];
    expect(body).toBe('wants to run rm');
    expect(variant).toBe('success');
    expect(opts.title).toBe('✋ Approval needed');
    expect(opts.kind).toBe('notification');
    act(() => opts.onActivate());
    expect(approvalChimeMock).toHaveBeenCalled();
  });

  it('uses the toast when permission is missing and stays silent with browser alerts off', () => {
    installNotification('denied');
    arm();
    act(() => notifyApprovalSpy?.(alertFx()));
    expect(toastMock).toHaveBeenCalledTimes(1);

    toastMock.mockClear();
    act(() => setBrowserSpy?.(false));
    act(() => notifyApprovalSpy?.(alertFx({ approvalID: 'ap-3' })));
    expect(toastMock).not.toHaveBeenCalled();
    expect(attentionMock).toHaveBeenCalledTimes(1); // only the first alert
  });

  it('withholds the desktop delivery ack when nobody is at the device', () => {
    installNotification('granted');
    arm({ sound: false });
    act(() => {
      setHardAway('test', true);
      notifyApprovalSpy?.(alertFx());
    });
    expect(sendWSMock).not.toHaveBeenCalled();
  });

  it('POSTs the verdict when the shell relays a native decision, and tolerates failures', async () => {
    arm();
    act(() => {
      document.dispatchEvent(
        new CustomEvent('ex:approval-decision', {
          detail: { approvalID: 'ap-9', runID: 'run-9', approve: true, choice: 'staging' },
        }),
      );
    });
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/runs/run-9/approvals/ap-9',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: true, choice: 'staging' }) }),
      ),
    );

    // A rejected POST is swallowed (the event stream reconciles).
    apiFetchMock.mockImplementation(() => Promise.reject(new Error('expired')));
    act(() => {
      document.dispatchEvent(
        new CustomEvent('ex:approval-decision', { detail: { approvalID: 'ap-10', runID: 'run-10' } }),
      );
    });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));

    // Malformed payloads are ignored.
    act(() => {
      document.dispatchEvent(new CustomEvent('ex:approval-decision', { detail: { approvalID: 'only' } }));
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
