import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render } from 'vitest-browser-react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from './NotificationContext';
import * as storageModule from '@/lib/storage';
import { resetNotificationDedup } from '@/lib/notification-dedup';
import { markUserActivity } from '@/lib/user-activity';

const sendWSMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ws-sender', () => ({
  sendWS: (...args: unknown[]) => sendWSMock(...args),
  setWSSender: vi.fn(),
}));

// Browser coverage for NotificationContext — exercises dispatch
// suppression rules, sound/browser prefs, and the noop fallback when
// used outside the provider.

vi.mock('@/lib/notification-sound', () => ({
  playNotificationPing: vi.fn(),
}));

vi.mock('@/lib/storage', () => {
  let stored: Record<string, unknown> = {};
  return {
    readJSON: (key: string, def: unknown) => (key in stored ? stored[key] : def),
    writeJSON: (key: string, value: unknown) => {
      stored[key] = value;
    },
    __reset: () => {
      stored = {};
    },
  };
});

let captured: ReturnType<typeof useNotifications> | null = null;
function Capture() {
  const ctx = useNotifications();
  useEffect(() => {
    captured = ctx;
  }, [ctx]);
  return null;
}

beforeEach(() => {
  captured = null;
  // The storage mock persists across tests; reset it so one test's pref
  // changes don't leak into the next (e.g. a disabled browserEnabled).
  (storageModule as unknown as { __reset: () => void }).__reset();
  // The cross-tab dedup store is backed by real localStorage — clear it (and the
  // module's latch) so a messageID alerted in one test isn't deduped in the next.
  resetNotificationDedup();
  try { localStorage.removeItem('ex.notif.seen.v1'); } catch { /* ignore */ }
  // Reset Notification permission baseline.
  if ('Notification' in window) {
    try {
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => 'default' as NotificationPermission,
      });
    } catch { /* noop */ }
  }
});

// Replace the read-only `Notification` global with a granted-permission fake
// that records constructed instances. Returns a restore function.
function installFakeNotification(instances: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; onclose: (() => void) | null; close: () => void }>) {
  class FakeNotification {
    static permission = 'granted';
    static requestPermission = vi.fn().mockResolvedValue('granted');
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public title: string, public options: NotificationOptions) { instances.push(this as never); }
    close() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, writable: true, value: FakeNotification });
  return () => {
    if (original) Object.defineProperty(globalThis, 'Notification', original);
  };
}

type FakeNote = { title: string; options: NotificationOptions; onclick: (() => void) | null; onclose: (() => void) | null; close: () => void };

// Granted-permission Notification whose constructor throws — the embedded-
// webview failure mode the dispatch catch-fallback exists for.
function installThrowingNotification() {
  class ThrowingNotification {
    static permission = 'granted';
    static requestPermission = vi.fn().mockResolvedValue('granted');
    constructor() {
      throw new Error('Notification not allowed in this context');
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, writable: true, value: ThrowingNotification });
  return () => {
    if (original) Object.defineProperty(globalThis, 'Notification', original);
  };
}

function basePayload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    kind: 'mention',
    title: 'Alice',
    body: 'hey there',
    deepLink: '/channel/general',
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-alice',
    createdAt: '2026-05-10T12:00:00Z',
    ...over,
  };
}

describe('NotificationContext browser', () => {
  it('exposes default prefs and permission via useNotifications', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    expect(captured!.prefs.soundEnabled).toBe(true);
    expect(captured!.prefs.browserEnabled).toBe(true);
    expect(['default', 'granted', 'denied', 'unsupported']).toContain(captured!.permission);
  });

  it('setSoundEnabled and setBrowserEnabled persist updates', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    captured!.setSoundEnabled(false);
    captured!.setBrowserEnabled(false);
    await vi.waitFor(() => {
      expect(captured!.prefs.soundEnabled).toBe(false);
      expect(captured!.prefs.browserEnabled).toBe(false);
    });
  });

  it('dispatch suppresses echoes from the current user', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    captured!.setCurrentUserID('u-me');
    // Author matches current user — suppressed (no throw, no sound).
    captured!.dispatch(basePayload({ authorID: 'u-me' }));
  });

  it('dispatch banners a channel "message" kind — the backend already decided it should notify', async () => {
    // Regression: the client used to drop every channel `message` payload,
    // which silently swallowed notifications the user opted into via a
    // per-channel "all messages" override. The backend is the source of truth;
    // if it published one for a channel we're not actively viewing, it banners.
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.setCurrentUserID('u-me');
      captured!.dispatch(
        basePayload({ kind: 'message', parentType: 'channel', authorID: 'u-other' }),
      );
      await vi.waitFor(() => expect(instances.length).toBe(1));
    } finally {
      restore();
    }
  });

  it('does NOT suppress a webhook channel "message" (integration alerts always banner, even from your own webhook)', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.setCurrentUserID('u-me');
      // An own-author message is normally suppressed (echo of your own send).
      // The webhook flag bypasses that guard so the alert still banners —
      // authorID is the webhook's creator (u-me), who wired it up and wants it.
      captured!.dispatch(
        basePayload({ kind: 'message', parentType: 'channel', authorID: 'u-me', webhook: true }),
      );
      await vi.waitFor(() => expect(instances.length).toBe(1));
    } finally {
      restore();
    }
  });

  it('dispatch suppresses DM "message" kind when active parent matches and tab is visible', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    captured!.setActiveParent('conv-1');
    captured!.dispatch(
      basePayload({ kind: 'message', parentType: 'conversation', parentID: 'conv-1', authorID: 'u-other' }),
    );
  });

  it('dispatch still fires an on-screen DM when the window is blurred (backgrounded app)', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      // Window loses focus → app no longer active even though still visible.
      window.dispatchEvent(new Event('blur'));
      captured!.setActiveParent('conv-1');
      captured!.dispatch(
        basePayload({ kind: 'message', parentType: 'conversation', parentID: 'conv-1', authorID: 'u-other' }),
      );
      await vi.waitFor(() => expect(instances.length).toBe(1));
    } finally {
      restore();
      // Restore focus so later tests see an active window.
      window.dispatchEvent(new Event('focus'));
    }
  });

  it('withholds the desktop ack while the user is idle so the mobile fallback fires', async () => {
    // Slack behavior: an open-but-abandoned laptop still shows the popup but
    // must NOT claim the alert — no ack → the backend's deferred mobile push
    // reaches the phone.
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      sendWSMock.mockClear();

      markUserActivity(Date.now() - 25 * 60_000); // last input 25 minutes ago (past the 20min active window)
      captured!.dispatch(basePayload({ messageID: 'm-idle' }));
      await vi.waitFor(() => expect(instances.length).toBe(1)); // popup still surfaced
      expect(sendWSMock).not.toHaveBeenCalled();

      markUserActivity(); // user is back at the keyboard
      captured!.dispatch(basePayload({ messageID: 'm-active' }));
      await vi.waitFor(() => {
        expect(sendWSMock).toHaveBeenCalledWith(
          { type: 'notification.ack', messageID: 'm-active' },
          expect.objectContaining({ buffer: true }),
        );
      });
    } finally {
      restore();
      markUserActivity();
    }
  });

  it('an idle viewer of the active conversation is NOT treated as seeing it: popup fires, no ack', async () => {
    // “Actively viewing this parent” requires recent input — a focused window
    // on an empty desk suppressing the popup AND acking would silently kill
    // both the desktop banner and the mobile push.
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      sendWSMock.mockClear();
      markUserActivity(Date.now() - 25 * 60_000);
      captured!.setActiveParent('conv-idle');
      captured!.dispatch(
        basePayload({ kind: 'message', parentType: 'conversation', parentID: 'conv-idle', authorID: 'u-other', messageID: 'm-conv-idle' }),
      );
      await vi.waitFor(() => expect(instances.length).toBe(1));
      expect(sendWSMock).not.toHaveBeenCalled();
    } finally {
      restore();
      markUserActivity();
    }
  });

  it('dispatch with mention kind plays the ping (if soundEnabled) — sound branch path', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    captured!.dispatch(basePayload({ kind: 'mention' }));
  });

  it('requestPermission reports unsupported when the Notification API is missing', async () => {
    const orig = window.Notification;
    // Simulate an environment without web notifications (older webviews).
    delete (window as { Notification?: unknown }).Notification;
    try {
      await render(
        <NotificationProvider>
          <Capture />
        </NotificationProvider>,
      );
      await vi.waitFor(() => expect(captured).not.toBeNull());
      expect(await captured!.requestPermission()).toBe('unsupported');
    } finally {
      (window as { Notification?: unknown }).Notification = orig;
    }
  });

  it('requestPermission resolves to current permission value', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    const result = await captured!.requestPermission();
    expect(['default', 'denied', 'granted', 'unsupported']).toContain(result);
  });

  it('creates a browser notification and navigates in-app on click when permission is granted', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      // A DM mention (not suppressed) with browser + permission → an OS banner.
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', deepLink: '/channel/general' }));
      await vi.waitFor(() => expect(instances.length).toBe(1));
      // Non-desktop build attaches the logo icon.
      expect(instances[0].options.icon).toBe('/logo.svg');
      window.history.pushState({}, '', '/start');
      instances[0].onclick!();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/channel/general'));
      // OS dismissal drops the handler refs so the click closure can be GC'd.
      instances[0].onclose!();
      expect(instances[0].onclick).toBeNull();
      expect(instances[0].onclose).toBeNull();
    } finally {
      restore();
    }
  });

  it('omits the icon for the desktop build', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    const realDesktop = (window as { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
    (window as { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__ = true;
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other' }));
      await vi.waitFor(() => expect(instances.length).toBe(1));
      expect(instances[0].options.icon).toBeUndefined();
    } finally {
      restore();
      (window as { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__ = realDesktop;
    }
  });

  it('does not create a banner when browser notifications are disabled', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.setBrowserEnabled(false);
      await vi.waitFor(() => expect(captured!.prefs.browserEnabled).toBe(false));
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other' }));
      await new Promise((r) => setTimeout(r, 30));
      expect(instances.length).toBe(0);
    } finally {
      restore();
    }
  });

  it('still posts a silent banner when sound is disabled (no ping)', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.setSoundEnabled(false);
      await vi.waitFor(() => expect(captured!.prefs.soundEnabled).toBe(false));
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other' }));
      await vi.waitFor(() => expect(instances.length).toBe(1));
      // soundEnabled=false → no ping, and the banner is marked silent.
      expect(playNotificationPing).not.toHaveBeenCalled();
      expect(instances[0].options.silent).toBe(true);
    } finally {
      restore();
    }
  });

  it('plain browser: the custom ping plays and the banner is always silent (DnD trade-off)', async () => {
    // Without a shell bridge there is no way to query OS Focus — the
    // deliberate 2026-07-10 trade-off keeps the brand ping in browsers even
    // though it bypasses DnD. The banner stays silent so ping + OS sound
    // never double up.
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-browser-ping' }));
      await vi.waitFor(() => expect(instances.length).toBe(1));
      expect(instances[0].options.silent).toBe(true);
      await vi.waitFor(() => expect(playNotificationPing).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });

  it('shell DnD bridge, Focus off: the banner is silent and the custom ping plays', async () => {
    // With a native bridge the APP owns the sound (Slack/Mattermost parity):
    // the OS banner is forced silent so banner + custom ping never
    // double-sound, and the ping plays because Focus is off.
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    window.__EX_DND__ = () => Promise.resolve(false);
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-dnd-off' }));
      await vi.waitFor(() => expect(instances.length).toBe(1));
      expect(instances[0].options.silent).toBe(true);
      await vi.waitFor(() => expect(playNotificationPing).toHaveBeenCalledTimes(1));
    } finally {
      restore();
      delete window.__EX_DND__;
    }
  });

  it('shell DnD bridge, Focus ON: no custom ping (the alert still counts as delivered)', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    window.__EX_DND__ = () => Promise.resolve(true);
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-dnd-on' }));
      // The (OS-suppressed) banner is still created; the ping must stay quiet.
      await vi.waitFor(() => expect(instances.length).toBe(1));
      await new Promise((r) => setTimeout(r, 30));
      expect(playNotificationPing).not.toHaveBeenCalled();
    } finally {
      restore();
      delete window.__EX_DND__;
    }
  });

  it('shell DnD bridge with popups disabled: the standalone ping obeys Focus too', async () => {
    // The residual case the OS can never cover — sound on, popups off — goes
    // quiet under Focus once the shell bridge exists.
    window.__EX_DND__ = () => Promise.resolve(true);
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.setBrowserEnabled(false);
      await vi.waitFor(() => expect(captured!.prefs.browserEnabled).toBe(false));
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-dnd-noPopup' }));
      await new Promise((r) => setTimeout(r, 30));
      expect(playNotificationPing).not.toHaveBeenCalled();
      // Focus lifts → the same path pings again.
      window.__EX_DND__ = () => Promise.resolve(false);
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-dnd-noPopup-2' }));
      await vi.waitFor(() => expect(playNotificationPing).toHaveBeenCalledTimes(1));
    } finally {
      delete window.__EX_DND__;
    }
  });

  it('falls back to the in-page ping when the Notification constructor throws (sound on)', async () => {
    // Some embedded webviews throw on `new Notification` even with permission
    // granted. The OS-delegated sound (the DnD-correct default) never fired,
    // so the in-page ping is the fallback alert.
    const restore = installThrowingNotification();
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-throw-ping' }));
      await vi.waitFor(() => expect(playNotificationPing).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });

  it('a throwing constructor with sound off surfaces nothing (no ping, no ack)', async () => {
    const restore = installThrowingNotification();
    const { playNotificationPing } = await import('@/lib/notification-sound');
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      (playNotificationPing as ReturnType<typeof vi.fn>).mockClear();
      captured!.setSoundEnabled(false);
      await vi.waitFor(() => expect(captured!.prefs.soundEnabled).toBe(false));
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-throw-quiet' }));
      await new Promise((r) => setTimeout(r, 30));
      // Nothing surfaced → no ping, and no ack either (the mobile fallback
      // must remain the delivery path). sendWSMock is not cleared per test,
      // so check for THIS message's ack specifically.
      expect(playNotificationPing).not.toHaveBeenCalled();
      const acked = sendWSMock.mock.calls.some(
        (c) => (c[0] as { messageID?: string } | undefined)?.messageID === 'm-throw-quiet',
      );
      expect(acked).toBe(false);
    } finally {
      restore();
    }
  });

  it('clicking a banner with no deepLink focuses without navigating', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      // Empty deepLink → the `if (n.deepLink)` false arm in onclick.
      captured!.dispatch(basePayload({ kind: 'mention', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', deepLink: '' }));
      await vi.waitFor(() => expect(instances.length).toBe(1));
      window.history.pushState({}, '', '/stay-here');
      instances[0].onclick!();
      await new Promise((r) => setTimeout(r, 20));
      // No navigation occurred — we stayed on the pushed path.
      expect(window.location.pathname).toBe('/stay-here');
    } finally {
      restore();
    }
  });

  it('dispatch dedupes repeats of the same message and fires once per distinct messageID', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      const dup = basePayload({ kind: 'mention', authorID: 'u-other', messageID: 'm-1' });
      captured!.dispatch(dup);
      captured!.dispatch(dup); // same messageID → collapsed
      captured!.dispatch(basePayload({ kind: 'mention', authorID: 'u-other', messageID: 'm-2' }));
      await vi.waitFor(() => expect(instances.length).toBe(2));
    } finally {
      restore();
    }
  });

  it('dispatch does not dedupe notifications that carry no messageID', async () => {
    const instances: FakeNote[] = [];
    const restore = installFakeNotification(instances);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      const noID = basePayload({ kind: 'mention', authorID: 'u-other', messageID: undefined });
      captured!.dispatch(noID);
      captured!.dispatch(noID);
      await vi.waitFor(() => expect(instances.length).toBe(2));
    } finally {
      restore();
    }
  });

  // Webview fallback: Capacitor's WKWebView has no Notification API, so the
  // in-app TOAST is the popup surface — it must fire (and count as delivery)
  // or a foregrounded native user with sound off gets no in-app alert at all.
  function removeNotificationAPI() {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
    delete (globalThis as { Notification?: unknown }).Notification;
    return () => {
      if (original) Object.defineProperty(globalThis, 'Notification', original);
    };
  }

  it('webview (no Notification API): surfaces an in-app toast whose tap deep-links', async () => {
    const restore = removeNotificationAPI();
    const toasts: Array<{ message: string; title?: string; kind?: string; onActivate?: () => void }> = [];
    const onToast = (e: Event) => {
      toasts.push((e as CustomEvent<{ message: string; title?: string; kind?: string; onActivate?: () => void }>).detail);
    };
    window.addEventListener('app:toast', onToast);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.setSoundEnabled(false);
      await vi.waitFor(() => expect(captured!.prefs.soundEnabled).toBe(false));
      captured!.dispatch(basePayload({ parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-webview-1' }));
      await vi.waitFor(() => expect(toasts.length).toBe(1));
      expect(toasts[0].title).toBe('Alice');
      expect(toasts[0].message).toBe('hey there');
      // Notification deliveries render as the top inverted banner, not a
      // regular bottom toast (they must not blend into the app).
      expect(toasts[0].kind).toBe('notification');
      // The toast counts as delivery → a duplicate of the same message is deduped.
      captured!.dispatch(basePayload({ parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-webview-1' }));
      await new Promise((r) => setTimeout(r, 30));
      expect(toasts.length).toBe(1);
      // Tapping the toast deep-links like a popup click would.
      const before = window.location.pathname;
      toasts[0].onActivate?.();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/channel/general'));
      window.history.replaceState(null, '', before);
    } finally {
      window.removeEventListener('app:toast', onToast);
      restore();
    }
  });

  it('webview toast falls back to the title as body and skips navigation without a deepLink', async () => {
    const restore = removeNotificationAPI();
    const toasts: Array<{ message: string; title?: string; onActivate?: () => void }> = [];
    const onToast = (e: Event) => {
      toasts.push((e as CustomEvent<{ message: string; title?: string; onActivate?: () => void }>).detail);
    };
    window.addEventListener('app:toast', onToast);
    try {
      await render(<NotificationProvider><Capture /></NotificationProvider>);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.dispatch(basePayload({ body: '', deepLink: '', parentType: 'conversation', parentID: 'conv-9', authorID: 'u-other', messageID: 'm-webview-2' }));
      await vi.waitFor(() => expect(toasts.length).toBe(1));
      // Empty body → the title IS the message line, with no separate title.
      expect(toasts[0].message).toBe('Alice');
      expect(toasts[0].title).toBeUndefined();
      const before = window.location.pathname;
      toasts[0].onActivate?.();
      await new Promise((r) => setTimeout(r, 30));
      expect(window.location.pathname).toBe(before);
    } finally {
      window.removeEventListener('app:toast', onToast);
      restore();
    }
  });

  it('useNotifications returns the noop value outside a provider', async () => {
    let api: ReturnType<typeof useNotifications> | null = null;
    function Inner() {
      const ctx = useNotifications();
      useEffect(() => {
        api = ctx;
      }, [ctx]);
      return null;
    }
    await render(<Inner />);
    expect(api).not.toBeNull();
    api!.setSoundEnabled(true);
    api!.setBrowserEnabled(true);
    api!.dispatch(basePayload());
    api!.setActiveParent('x');
    api!.setCurrentUserID('y');
    const r = await api!.requestPermission();
    expect(r).toBe('unsupported');
  });
});
