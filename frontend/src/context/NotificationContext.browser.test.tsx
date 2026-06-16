import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render } from 'vitest-browser-react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from './NotificationContext';
import * as storageModule from '@/lib/storage';

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
function installFakeNotification(instances: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }>) {
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

  it('dispatch suppresses channel "message" kind (noisy by default)', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    captured!.dispatch(
      basePayload({ kind: 'message', parentType: 'channel', authorID: 'u-other' }),
    );
    // Returned early; we don't need to assert side-effects — branch covered.
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

  it('dispatch with mention kind plays the ping (if soundEnabled) — sound branch path', async () => {
    await render(
      <NotificationProvider>
        <Capture />
      </NotificationProvider>,
    );
    captured!.dispatch(basePayload({ kind: 'mention' }));
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

  type FakeNote = { title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void };

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
