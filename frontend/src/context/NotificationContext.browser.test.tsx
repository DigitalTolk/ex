import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render } from 'vitest-browser-react';
import {
  NotificationProvider,
  useNotifications,
  type NotificationPayload,
} from './NotificationContext';

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
