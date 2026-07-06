import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, screen } from '@testing-library/react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from '@/context/NotificationContext';
import { resetNotificationDedup } from '@/lib/notification-dedup';
import { markUserActivity } from '@/lib/user-activity';

const playMock = vi.fn();
vi.mock('@/lib/notification-sound', () => ({
  playNotificationPing: () => playMock(),
}));

const sendWSMock = vi.fn();
vi.mock('@/lib/ws-sender', () => ({
  sendWS: (payload: unknown) => sendWSMock(payload),
  setWSSender: vi.fn(),
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

function Probe() {
  const { dispatch, setActiveParent, setCurrentUserID, setSoundEnabled, setBrowserEnabled, permission } = useNotifications();
  useEffect(() => {
    dispatchSpy = dispatch;
    setActiveSpy = setActiveParent;
    setUserSpy = setCurrentUserID;
    setSoundSpy = setSoundEnabled;
    setBrowserSpy = setBrowserEnabled;
    permissionSpy = permission;
  }, [dispatch, setActiveParent, setCurrentUserID, setSoundEnabled, setBrowserEnabled, permission]);
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
    sendWSMock.mockReset();
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
    delete window.Capacitor;
    if (origNotification) {
      Object.defineProperty(window, 'Notification', { value: origNotification, configurable: true });
    }
  });

  it('plays sound and creates a native browser notification on dispatch', () => {
    renderProbe();
    act(() => {
      dispatchSpy!(samplePayload);
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor.mock.calls[0][0]).toBe('Alice');
    const opts = notificationCtor.mock.calls[0][1] as NotificationOptions;
    expect(opts.body).toBe('hello there');
    // No tag: Chrome silently swallows tag-replacements regardless of
    // renotify, which made a second message in the same channel never
    // banner. Each notification is now its own entry.
    expect(opts.tag).toBeUndefined();
    // App logo, not Chrome's default.
    expect(opts.icon).toBe('/logo.svg');
    expect(opts.silent).toBe(false);
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
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
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
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
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
      dispatchSpy!({ ...channelMessagePayload, kind: 'mention' });
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
      dispatchSpy!({ ...channelMessagePayload, kind: 'thread_reply' });
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
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
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
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

  it('still fires for channel mentions when no other suppression applies', () => {
    renderProbe();
    act(() => {
      dispatchSpy!({ ...channelMessagePayload, kind: 'mention' });
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('still fires for channel thread replies (you are already a participant)', () => {
    // Backend filters thread_reply notifications to thread participants,
    // so receiving one means you've replied in the thread already.
    renderProbe();
    act(() => {
      dispatchSpy!({ ...channelMessagePayload, kind: 'thread_reply' });
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
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
    expect(playMock).toHaveBeenCalledTimes(1);
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
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it('fires separately for distinct messages', () => {
    renderProbe();
    act(() => {
      dispatchSpy!({ ...samplePayload, messageID: 'm-1' });
      dispatchSpy!({ ...samplePayload, messageID: 'm-2' });
    });
    expect(playMock).toHaveBeenCalledTimes(2);
    expect(notificationCtor).toHaveBeenCalledTimes(2);
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
    markUserActivity(Date.now() - 10 * 60_000); // user left the desk 10 min ago
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
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledTimes(1);
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
