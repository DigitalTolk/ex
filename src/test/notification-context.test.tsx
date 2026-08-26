import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, screen } from '@testing-library/react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
  type ApprovalAlert,
} from '@/context/NotificationContext';
import { resetNotificationDedup } from '@/lib/notification-dedup';
import { markUserActivity } from '@/lib/user-activity';

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

const toastMock = vi.fn();
vi.mock('@/lib/toast', () => ({
  showToast: (...args: unknown[]) => toastMock(...args),
}));

// Default payload is a DM message — DMs always notify, so this represents
// a "should fire" baseline. Channel-specific behavior is covered explicitly
// in dedicated tests below.
const samplePayload: NotificationPayload = {
  kind: 'message',
  title: 'Alice',
  body: 'hello there',
  deepLink: '/conversation/dm-1',
  parentID: 'dm-1',
  parentType: 'conversation',
  messageID: 'm-1',
  createdAt: new Date().toISOString(),
};

const channelMessagePayload: NotificationPayload = {
  kind: 'message',
  title: 'Alice in ~general',
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
let setSoundSpy: ((v: boolean) => void) | null = null;
let setBrowserSpy: ((v: boolean) => void) | null = null;
let permissionSpy: string | null = null;
let notifyApprovalSpy: ((a: ApprovalAlert) => void) | null = null;

function Probe() {
  const { dispatch, notifyApproval, setActiveParent, setCurrentUserID, setSoundEnabled, setBrowserEnabled, permission } = useNotifications();
  useEffect(() => {
    dispatchSpy = dispatch;
    notifyApprovalSpy = notifyApproval;
    setActiveSpy = setActiveParent;
    setUserSpy = setCurrentUserID;
    setSoundSpy = setSoundEnabled;
    setBrowserSpy = setBrowserEnabled;
    permissionSpy = permission;
  }, [dispatch, notifyApproval, setActiveParent, setCurrentUserID, setSoundEnabled, setBrowserEnabled, permission]);
  return <div data-testid="probe">{permission}</div>;
}

function renderProbe() {
  return render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
}

function installNotification(permission: NotificationPermission) {
  // Use a `function` (not arrow) so vi.fn().mockImplementation can act
  // as a constructor — `new Notification(...)` requires a [[Construct]]
  // slot, which arrow functions don't have.
  const ctor = vi.fn().mockImplementation(function NotificationStub() {
    return { onclick: null, close: () => {} };
  });
  Object.defineProperty(window, 'Notification', {
    value: Object.assign(ctor, {
      permission,
      requestPermission: vi.fn().mockResolvedValue(permission),
    }),
    configurable: true,
    writable: true,
  });
  return ctor;
}

describe('NotificationProvider', () => {
  let origNotification: typeof Notification | undefined;
  let notificationCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    playMock.mockReset();
    approvalChimeMock.mockReset();
    sendWSMock.mockReset();
    toastMock.mockReset();
    notifyApprovalSpy = null;
    resetNotificationDedup();
    dispatchSpy = null;
    setActiveSpy = null;
    setUserSpy = null;
    permissionSpy = null;
    localStorage.clear();
    sessionStorage.clear();
    origNotification = (window as unknown as { Notification?: typeof Notification }).Notification;
    notificationCtor = installNotification('granted');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  });

  afterEach(() => {
    delete (window as Window & { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
    delete window.__EX_DND__;
    delete window.Capacitor;
    if (origNotification) {
      Object.defineProperty(window, 'Notification', { value: origNotification, configurable: true });
    }
  });

  it('plays the custom ping alongside an always-silent browser notification', () => {
    // The app owns the notification sound everywhere: the custom ping plays
    // and the OS banner is ALWAYS silent so the two never double-sound. In a
    // plain browser (no shell DnD bridge) the ping deliberately ignores OS
    // Focus/DnD — the 2026-07-10 trade-off in favor of the brand sound;
    // DnD-correct gating happens only in the desktop shell via the bridge
    // (see the shell-bridge tests below).
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor.mock.calls[0][0]).toBe('Alice');
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.body).toBe('hello there');
    // No tag: Chrome silently swallows tag-replacements regardless of
    // renotify, which made a second message in the same channel never
    // banner. Each notification is now its own entry.
    expect(opts.tag).toBeUndefined();
    // App logo, not Chrome's default.
    expect(opts.icon).toBe('/logo.svg');
    // The custom ping is the sound source — the banner never doubles it.
    expect(opts.silent).toBe(true);
  });

  it('omits the web notification icon inside the desktop shell', () => {
    Object.defineProperty(window, '__EX_DESKTOP__', {
      value: true,
      configurable: true,
    });
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.icon).toBeUndefined();
  });

  it('keeps desktop notification behavior unchanged when the mobile OneSignal plugin exists', () => {
    Object.defineProperty(window, '__EX_DESKTOP__', {
      value: true,
      configurable: true,
    });
    window.Capacitor = {
      Plugins: {
        OneSignalCapacitor: {
          login: vi.fn().mockResolvedValue(undefined),
          addTags: vi.fn().mockResolvedValue(undefined),
          logout: vi.fn().mockResolvedValue(undefined),
          removeTags: vi.fn().mockResolvedValue(undefined),
        },
      },
    };

    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.icon).toBeUndefined();
    expect(window.Capacitor.Plugins?.OneSignalCapacitor?.login).not.toHaveBeenCalled();
  });

  it('suppresses conversation-message notifications when that DM is already on screen', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => {
      setActiveSpy!('dm-1');
      dispatchSpy!(samplePayload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('still fires conversation-message notifications for the active parent in a background tab', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderProbe();
    act(() => {
      setActiveSpy!('dm-1');
      dispatchSpy!(samplePayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  const dmPayload: NotificationPayload = { ...samplePayload, parentType: 'conversation', parentID: 'dm-1' };

  it('suppresses an on-screen DM only while the app window is focused', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => {
      setActiveSpy!('dm-1');
      dispatchSpy!(dmPayload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('still fires an on-screen DM when the app window is blurred (backgrounded desktop app)', () => {
    // Regression: a backgrounded-but-visible window kept visibilityState
    // 'visible', so a DM to the open conversation was wrongly silenced. The
    // alert must fire once the window loses focus.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => window.dispatchEvent(new Event('blur')));
    act(() => {
      setActiveSpy!('dm-1');
      dispatchSpy!(dmPayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('refocusing the window re-enables on-screen DM suppression', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => window.dispatchEvent(new Event('blur')));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => {
      setActiveSpy!('dm-1');
      dispatchSpy!(dmPayload);
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
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
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
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('still fires popups for mentions even when on the active parent', () => {
    // Mentions are personal — a user might be on the channel but scrolled
    // far away, or have it open in a background tab. They should always
    // hear/see a mention popup so the alert isn't silently dropped.
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!({ ...channelMessagePayload, kind: 'mention' });
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('still fires popups for thread replies even when on the active parent', () => {
    // Thread replies live in a side panel that may not be open. Suppressing
    // them just because the parent channel is on screen made replies
    // invisible — fire popups regardless of active parent.
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!({ ...channelMessagePayload, kind: 'thread_reply' });
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('fires a regular channel message when the backend published it (e.g. channel set to "all messages")', () => {
    // Regression: the client used to drop EVERY channel `message` payload by
    // kind/parentType, which silently swallowed notifications the user opted
    // into via a per-channel "all messages" override. The backend is the
    // source of truth for *whether* to notify; if a notification.new arrives
    // for a channel message and the user isn't looking at that channel, it
    // must ping + popup.
    renderProbe();
    act(() => {
      dispatchSpy!(channelMessagePayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses a channel message only while that channel is the active on-screen parent', () => {
    // The active-view guard is the one remaining client suppression for
    // channel messages: no need to ping the channel you're staring at.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!(channelMessagePayload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  // ---- agent approval gates (notifyApproval) ------------------------------
  // An approval BLOCKS the run until the invoker answers, so a swallowed alert
  // stalls the work indefinitely. These gates deliberately do NOT go through
  // `dispatch`: their identity is the approvalID, because every gate in a run
  // carries the same invoking messageID.
  const approval: ApprovalAlert = {
    approvalID: 'appr-1',
    parentID: 'ch-1',
    parentType: 'channel',
    agentName: 'gg',
    summary: 'Use the GitLab connector (gitlab) for this task',
    messageID: 'invoking-msg-1',
    deepLink: '/channel/sandbox',
  };

  it('fires a banner for a pending approval when the invoker is elsewhere', () => {
    renderProbe();
    act(() => notifyApprovalSpy!(approval));
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    // Visually distinct from every message alert, which never carries a glyph.
    expect(notificationCtor.mock.calls[0][0]).toBe('✋ gg needs your approval');
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.body).toBe('Use the GitLab connector (gitlab) for this task');
    // The custom ping is the only sound source, as for every other alert.
    expect(opts.silent).toBe(true);
    // Distinct from every other alert: its own chime, and a banner that asks
    // the platform not to auto-dismiss it.
    expect(opts.requireInteraction).toBe(true);
    expect(approvalChimeMock).toHaveBeenCalledTimes(1);
    expect(playMock).not.toHaveBeenCalled();
  });

  it('says "needs your input" when the agent offers choices', () => {
    renderProbe();
    act(() => notifyApprovalSpy!({ ...approval, asksChoice: true }));
    expect(notificationCtor.mock.calls[0][0]).toBe('❓ gg needs your input');
  });

  it('alerts even while the invoker is focused on that very channel', () => {
    // Unlike a message, a gate HALTS the run until answered, so it is never
    // suppressed for "you're already looking at it". This is the behaviour
    // approvals had before this path existed, and is deliberate.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      markUserActivity();
      notifyApprovalSpy!(approval);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(approvalChimeMock).toHaveBeenCalledTimes(1);
    // Surfaced on a device someone is demonstrably at → the deferred mobile
    // push stands down.
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'notification.ack', messageID: 'invoking-msg-1' });
  });

  it('still fires when that parent is on screen but the window is not focused', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      notifyApprovalSpy!(approval);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('fires for BOTH gates of one run (same invoking message, different approvals)', () => {
    // The regression that made this path necessary: a messageID-keyed dedup
    // collapsed every gate in a run into the first one's entry.
    renderProbe();
    act(() => notifyApprovalSpy!(approval));
    act(() => notifyApprovalSpy!({ ...approval, approvalID: 'appr-2', summary: 'Run a shell command' }));
    expect(notificationCtor).toHaveBeenCalledTimes(2);
  });

  it('fires even when the invoking message already produced its own alert', () => {
    // A colleague writes "@alice @gg can you look at this?": the mention alert
    // records that messageID, and the approval must not collide with it.
    renderProbe();
    act(() => dispatchSpy!({ ...channelMessagePayload, kind: 'mention', messageID: 'invoking-msg-1' }));
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    act(() => notifyApprovalSpy!(approval));
    expect(notificationCtor).toHaveBeenCalledTimes(2);
  });

  it('dedupes a redelivered copy of the SAME approval', () => {
    renderProbe();
    act(() => notifyApprovalSpy!(approval));
    act(() => notifyApprovalSpy!(approval));
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('falls back to an in-app toast when no OS banner is possible', () => {
    // A blocking gate must never be invisible, so a denied/absent permission
    // still surfaces something the user can act on.
    notificationCtor = installNotification('denied');
    renderProbe();
    act(() => notifyApprovalSpy!(approval));
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(approvalChimeMock).toHaveBeenCalledTimes(1);
  });

  it('asks the desktop shell to flag the app (dock bounce) for an approval', () => {
    const attention = vi.fn();
    Object.defineProperty(window, '__EX_ATTENTION__', { value: attention, configurable: true });
    renderProbe();
    act(() => notifyApprovalSpy!(approval));
    expect(attention).toHaveBeenCalledTimes(1);
    delete (window as Window & { __EX_ATTENTION__?: () => void }).__EX_ATTENTION__;
  });

  it('never flags the app for an ordinary message', () => {
    // The signal only keeps meaning "something is waiting on you" if nothing
    // else uses it.
    const attention = vi.fn();
    Object.defineProperty(window, '__EX_ATTENTION__', { value: attention, configurable: true });
    renderProbe();
    act(() => dispatchSpy!(samplePayload));
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(attention).not.toHaveBeenCalled();
    delete (window as Window & { __EX_ATTENTION__?: () => void }).__EX_ATTENTION__;
  });

  it('does not flag the app when nothing was surfaced', () => {
    // Popups off → nothing surfaced → no dock bounce either. (When a banner or
    // toast DOES surface, the shell still skips the bounce if its window is
    // focused, so an app you are using never bounces its own dock.)
    const attention = vi.fn();
    Object.defineProperty(window, '__EX_ATTENTION__', { value: attention, configurable: true });
    renderProbe();
    act(() => setBrowserSpy!(false));
    act(() => notifyApprovalSpy!(approval));
    expect(attention).not.toHaveBeenCalled();
    delete (window as Window & { __EX_ATTENTION__?: () => void }).__EX_ATTENTION__;
  });

  it('stays silent when the user turned browser popups off', () => {
    renderProbe();
    act(() => setBrowserSpy!(false));
    act(() => notifyApprovalSpy!(approval));
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('still fires for channel mentions when no other suppression applies', () => {
    renderProbe();
    act(() => {
      dispatchSpy!({ ...channelMessagePayload, kind: 'mention' });
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('still fires for channel thread replies (you are already a participant)', () => {
    // Backend filters thread_reply notifications to thread participants,
    // so receiving one means you've replied in the thread already.
    renderProbe();
    act(() => {
      dispatchSpy!({ ...channelMessagePayload, kind: 'thread_reply' });
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('navigates to the deep link via SPA history (no full page reload) when clicked', () => {
    // The click handler must focus the tab and route to the message via
    // history.pushState + popstate so React Router takes over without
    // reloading the page. Setting window.location.href would discard
    // the user's loaded message history and leave a deep-link landing
    // showing only the around-window plus one page on each side.
    let clickHandler: (() => void) | null = null;
    const closeMock = vi.fn();
    notificationCtor.mockImplementation(function NotificationCtor() {
      return {
        close: closeMock,
        set onclick(h: () => void) {
          clickHandler = h;
        },
        get onclick() {
          return clickHandler!;
        },
      };
    });
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const popStateSpy = vi.fn();
    window.addEventListener('popstate', popStateSpy);

    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    act(() => {
      clickHandler!();
    });
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    expect(pushStateSpy.mock.calls[0][2]).toBe('/conversation/dm-1');
    expect(popStateSpy).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);

    focusSpy.mockRestore();
    pushStateSpy.mockRestore();
    window.removeEventListener('popstate', popStateSpy);
  });

  it('does not fire an OS notification when permission is "default" (never granted)', () => {
    // Sound still plays; the OS popup is gated behind explicit permission.
    installNotification('default');
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    // The freshly installed ctor for this test isn't the same reference,
    // so re-read it from window to assert.
    const ctor = (window as unknown as { Notification: ReturnType<typeof vi.fn> }).Notification;
    expect(ctor).not.toHaveBeenCalled();
  });

  it('does not fire an OS notification when permission is "denied"', () => {
    installNotification('denied');
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    const ctor = (window as unknown as { Notification: ReturnType<typeof vi.fn> }).Notification;
    expect(ctor).not.toHaveBeenCalled();
  });

  it('does not fire an OS notification when browserEnabled is false', () => {
    // User can mute popups in-app even with OS permission granted.
    localStorage.setItem(
      'ex.notifications.prefs.v1',
      JSON.stringify({ soundEnabled: true, browserEnabled: false }),
    );
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('keeps browser notifications silent when only in-app sound is disabled', () => {
    localStorage.setItem(
      'ex.notifications.prefs.v1',
      JSON.stringify({ soundEnabled: false, browserEnabled: true }),
    );
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.silent).toBe(true);
  });

  it('reports permission=unsupported when window.Notification is missing', () => {
    delete (window as unknown as { Notification?: unknown }).Notification;
    renderProbe();
    expect(screen.getByTestId('probe').textContent).toBe('unsupported');
  });

  it('does not throw when dispatch fires on a browser without Notification API', () => {
    delete (window as unknown as { Notification?: unknown }).Notification;
    renderProbe();
    expect(() => act(() => dispatchSpy!(samplePayload))).not.toThrow();
    // Sound still played even without a Notification API.
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the Notification constructor itself throws (embedded webview)', () => {
    notificationCtor.mockImplementation(function ThrowingNotification() {
      throw new Error('Notification not allowed in this context');
    });
    renderProbe();
    expect(() => act(() => dispatchSpy!(samplePayload))).not.toThrow();
    // With no OS banner surfaced, the in-page ping is the fallback alert.
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('shell DnD bridge, Focus off: banner is forced silent and the custom ping plays', async () => {
    // With the desktop shell's native Focus bridge the app owns the sound
    // (Slack/Mattermost parity): custom ping + always-silent banner, so the
    // two never double-sound.
    window.__EX_DND__ = () => Promise.resolve(false);
    renderProbe();
    await act(async () => {
      dispatchSpy!(samplePayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.silent).toBe(true);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('shell DnD bridge, Focus ON: the custom ping stays quiet', async () => {
    window.__EX_DND__ = () => Promise.resolve(true);
    renderProbe();
    await act(async () => {
      dispatchSpy!(samplePayload);
    });
    // Banner still handed to the OS (which suppresses it under Focus) — the
    // alert counts as delivered; only the ping is gated.
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).not.toHaveBeenCalled();
  });

  it('shell DnD bridge with popups disabled: the standalone ping obeys Focus', async () => {
    window.__EX_DND__ = () => Promise.resolve(true);
    localStorage.setItem(
      'ex.notifications.prefs.v1',
      JSON.stringify({ soundEnabled: true, browserEnabled: false }),
    );
    renderProbe();
    await act(async () => {
      dispatchSpy!(samplePayload);
    });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });

  it('a broken shell bridge fails toward the audible ping', async () => {
    window.__EX_DND__ = () => Promise.reject(new Error('ipc dead'));
    localStorage.setItem(
      'ex.notifications.prefs.v1',
      JSON.stringify({ soundEnabled: true, browserEnabled: false }),
    );
    renderProbe();
    await act(async () => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing constructor with sound off surfaces nothing, so a retry still alerts', () => {
    // The catch fallback only pings when sound is enabled; with sound off
    // nothing surfaced, so the messageID must stay unrecorded — a later
    // redelivery (once the popup works again) must still alert.
    localStorage.setItem(
      'ex.notifications.prefs.v1',
      JSON.stringify({ soundEnabled: false, browserEnabled: true }),
    );
    notificationCtor.mockImplementation(function ThrowingNotification() {
      throw new Error('Notification not allowed in this context');
    });
    renderProbe();
    const payload = { ...samplePayload, messageID: 'm-throw-quiet' };
    act(() => {
      dispatchSpy!(payload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(sendWSMock).not.toHaveBeenCalled();
    // Popup works again → the same messageID must not be deduped away.
    notificationCtor.mockImplementation(function NotificationStub() {
      return { onclick: null, close: () => {} };
    });
    act(() => {
      dispatchSpy!(payload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(2); // first call threw, second surfaced
  });

  it('shows a message only once when the same notification arrives twice (multi-session fan-out)', () => {
    // The broker fans the same alert out to every WebSocket session a user
    // has, and reconnect replay can re-deliver it. Each copy carries a fresh
    // event-frame id but the same messageID — dedup must collapse them to a
    // single banner (and a single ping), not one per copy.
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
      dispatchSpy!(samplePayload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('fires separately for distinct messages', () => {
    renderProbe();
    act(() => {
      dispatchSpy!({ ...samplePayload, messageID: 'm-1' });
      dispatchSpy!({ ...samplePayload, messageID: 'm-2' });
    });
    expect(notificationCtor).toHaveBeenCalledTimes(2);
    expect(playMock).toHaveBeenCalledTimes(2);
  });

  it('does not dedup notifications that carry no messageID', () => {
    // Defensive: a payload without a messageID can't be deduped, so it must
    // always fire rather than being silently swallowed.
    const noID: NotificationPayload = { ...samplePayload, messageID: undefined };
    renderProbe();
    act(() => {
      dispatchSpy!(noID);
      dispatchSpy!(noID);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(2);
  });

  it('acks desktop delivery when an alert is surfaced (so the backend cancels the mobile push)', () => {
    // The ack requires an ACTIVE desktop: visible page + recent input (an
    // earlier test in this file leaves visibilityState at 'hidden').
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    markUserActivity();
    renderProbe();
    act(() => {
      dispatchSpy!({ ...samplePayload, messageID: 'm-ack' });
    });
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'notification.ack', messageID: 'm-ack' });
  });

  it('does NOT ack a surfaced alert while the user is idle (mobile fallback must fire)', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    markUserActivity(Date.now() - 25 * 60_000); // user left the desk 25 min ago (past the 20min active window)
    renderProbe();
    act(() => {
      dispatchSpy!({ ...samplePayload, messageID: 'm-idle-jsdom' });
    });
    // Popup surfaced on the (abandoned) desktop…
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    // …but the phone must still get the deferred push: no ack.
    expect(sendWSMock).not.toHaveBeenCalledWith({ type: 'notification.ack', messageID: 'm-idle-jsdom' });
    markUserActivity();
  });

  it('acks when suppressed because the user is already viewing the channel', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    act(() => {
      setActiveSpy!('ch-1');
      dispatchSpy!({ ...channelMessagePayload, messageID: 'm-view' });
    });
    expect(notificationCtor).not.toHaveBeenCalled();
    // They saw it on desktop → ack so the mobile fallback stands down.
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'notification.ack', messageID: 'm-view' });
  });

  it('does NOT ack when nothing was surfaced (so the mobile fallback still fires)', () => {
    renderProbe();
    act(() => {
      setSoundSpy!(false);
      setBrowserSpy!(false);
    });
    act(() => {
      dispatchSpy!({ ...samplePayload, messageID: 'm-silent' });
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(sendWSMock).not.toHaveBeenCalled();
  });

  it('a copy suppressed because you were viewing the channel does not dedup a later deliverable copy', () => {
    // Incident-critical: the per-message dedup must record a messageID as
    // "alerted" only when it actually surfaces an alert — NOT when a copy is
    // merely suppressed. Otherwise the first (suppressed) copy poisons the
    // dedup set and a later copy that should alert is silently swallowed.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    renderProbe();
    const payload = { ...channelMessagePayload, messageID: 'm-incident' };
    act(() => {
      setActiveSpy!('ch-1'); // looking right at the channel → first copy suppressed
      dispatchSpy!(payload);
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
    act(() => {
      setActiveSpy!(null); // looked away → a later copy must still alert
      dispatchSpy!(payload);
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('a copy that surfaces nothing (sound+browser off) is not deduped, so a retry still alerts', () => {
    // Covers the `delivered === false` path: when neither sound nor a popup
    // fired, the messageID is left unrecorded so re-enabling alerts and
    // re-dispatching the same message still surfaces it.
    renderProbe();
    const payload = { ...samplePayload, messageID: 'm-quiet' };
    // Separate act() blocks so each pref change re-renders and reaches the
    // dispatch refs before the next dispatch.
    act(() => {
      setSoundSpy!(false);
      setBrowserSpy!(false);
    });
    act(() => {
      dispatchSpy!(payload); // surfaces nothing → not recorded as seen
    });
    expect(playMock).not.toHaveBeenCalled();
    expect(notificationCtor).not.toHaveBeenCalled();
    act(() => {
      setSoundSpy!(true); // alerts back on
    });
    act(() => {
      dispatchSpy!(payload); // same messageID — must NOT be deduped away
    });
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to no-op when used outside the provider', () => {
    // Render Probe without NotificationProvider — useNotifications returns
    // safe defaults so unrelated tests don't have to set up the context.
    render(<Probe />);
    expect(() => dispatchSpy!(samplePayload)).not.toThrow();
    expect(playMock).not.toHaveBeenCalled();
  });
});

// ————— C1 multi-tab regression (real tab-leader module, inert = single-tab) —————
describe('duplicate-copy ack gating', () => {
  let notificationCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    playMock.mockReset();
    sendWSMock.mockReset();
    resetNotificationDedup();
    localStorage.clear();
    notificationCtor = installNotification('granted');
  });

  it('a duplicate while the user is away must NOT ack — the mobile fallback stays armed', () => {
    // Two tabs, user away: tab A surfaces (idle → no ack); tab B's copy hits
    // the cross-tab dedup. That dedup-hit used to ack UNCONDITIONALLY,
    // deterministically cancelling the deferred mobile push for anyone with
    // two tabs open. Away = hidden page (and/or stale input).
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    markUserActivity(Date.now() - 25 * 60_000);
    renderProbe();
    const payload = { ...samplePayload, messageID: 'm-away-dup' };
    act(() => {
      dispatchSpy!(payload); // surfaces (hidden tabs may banner), idle → no ack
      dispatchSpy!(payload); // duplicate → dedup-hit, still away → no ack
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(sendWSMock).not.toHaveBeenCalled();
    markUserActivity();
  });

  it('a duplicate while the user IS at the device acks (desktop truly delivered)', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    markUserActivity();
    renderProbe();
    const payload = { ...samplePayload, messageID: 'm-present-dup' };
    act(() => {
      dispatchSpy!(payload);
      dispatchSpy!(payload);
    });
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'notification.ack', messageID: 'm-present-dup' });
  });
});
