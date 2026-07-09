import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyLayoutTierClasses,
  currentLayoutTier,
  deviceKind,
  isElectronMac,
  layoutTierFor,
  startLayoutTierTracking,
} from './device';

// The jsdom setup pins __EX_FORCE_DEVICE__='touch'; these tests exercise the
// real detection order, so they manage the flag themselves.

describe('deviceKind', () => {
  const originalForce = window.__EX_FORCE_DEVICE__;
  afterEach(() => {
    window.__EX_FORCE_DEVICE__ = originalForce;
    delete window.__EX_DESKTOP__;
    delete window.Capacitor;
  });

  it('honours the test force flag above everything', () => {
    window.__EX_FORCE_DEVICE__ = 'desktop';
    window.Capacitor = { isNativePlatform: () => true };
    expect(deviceKind()).toBe('desktop');
  });

  it('treats the Capacitor shell as touch', () => {
    window.__EX_FORCE_DEVICE__ = undefined;
    window.Capacitor = { isNativePlatform: () => true };
    expect(deviceKind()).toBe('touch');
  });

  it('treats the Electron shell as desktop', () => {
    window.__EX_FORCE_DEVICE__ = undefined;
    window.__EX_DESKTOP__ = true;
    expect(deviceKind()).toBe('desktop');
  });

  it('falls back to the coarse-pointer media query in plain browsers', () => {
    window.__EX_FORCE_DEVICE__ = undefined;
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as typeof window.matchMedia;
    try {
      expect(deviceKind()).toBe('touch');
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('layout tiers', () => {
  it('maps the width/device matrix', () => {
    expect(layoutTierFor(390, 'touch')).toBe('mobile');
    expect(layoutTierFor(390, 'desktop')).toBe('compact'); // half-screen desktop window
    expect(layoutTierFor(800, 'touch')).toBe('compact'); // tablet band
    expect(layoutTierFor(800, 'desktop')).toBe('compact');
    expect(layoutTierFor(1024, 'touch')).toBe('full');
    expect(layoutTierFor(1440, 'desktop')).toBe('full');
  });

  it('currentLayoutTier reads the live window width', () => {
    // jsdom default width is 1024 → full with the setup's touch device.
    expect(currentLayoutTier()).toBe('full');
  });
});

describe('applyLayoutTierClasses / startLayoutTierTracking', () => {
  const root = document.documentElement;
  beforeEach(() => {
    root.classList.remove('tier-mobile', 'tier-compact', 'tier-full', 'device-touch', 'electron-mac');
  });

  it('stamps exactly one tier class plus the device class', () => {
    const tier = applyLayoutTierClasses();
    expect(tier).toBe('full');
    expect(root.classList.contains('tier-full')).toBe(true);
    expect(root.classList.contains('tier-mobile')).toBe(false);
    expect(root.classList.contains('tier-compact')).toBe(false);
    // Setup pins the device to touch.
    expect(root.classList.contains('device-touch')).toBe(true);
  });

  it('stamps electron-mac on a frameless macOS surface so the topbar clears the traffic lights', () => {
    // The regression: a frameless macOS window (here the Electron flag; the
    // standalone-PWA / WCO paths are unit-tested on isElectronMac) draws the
    // traffic lights over the content, so the root MUST get `electron-mac` for
    // the [data-topbar-left] padding to inset the hamburger past them.
    const platformSpy = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    window.__EX_DESKTOP__ = true;
    try {
      applyLayoutTierClasses();
      expect(root.classList.contains('electron-mac')).toBe(true);
    } finally {
      delete window.__EX_DESKTOP__;
      platformSpy.mockRestore();
      applyLayoutTierClasses();
      expect(root.classList.contains('electron-mac')).toBe(false);
    }
  });

  it('tracks resizes and can be stopped', () => {
    const stop = startLayoutTierTracking();
    const originalWidth = window.innerWidth;
    // 800px is compact for BOTH device kinds (tablet band) — width alone
    // decides here, so the setup's pinned touch device doesn't matter.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));
    expect(root.classList.contains('tier-compact')).toBe(true);
    stop();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    window.dispatchEvent(new Event('resize'));
    // Stopped: the stale compact class stays because nothing listens.
    expect(root.classList.contains('tier-compact')).toBe(true);
    applyLayoutTierClasses();
    expect(root.classList.contains('tier-full')).toBe(true);
  });

  it('second start while tracking is a no-op stopper', () => {
    const stop1 = startLayoutTierTracking();
    const stop2 = startLayoutTierTracking();
    expect(() => stop2()).not.toThrow();
    stop1();
  });
});

describe('isElectronMac', () => {
  function setOverlay(visible: boolean) {
    Object.defineProperty(window.navigator, 'windowControlsOverlay', {
      configurable: true,
      value: { visible },
    });
  }
  function clearOverlay() {
    // Return the Navigator to its default (no WCO) between frameless-signal tests.
    Reflect.deleteProperty(window.navigator, 'windowControlsOverlay');
  }
  function stubDisplayMode(standalone: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: standalone && query === '(display-mode: standalone)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }

  afterEach(() => {
    delete window.__EX_DESKTOP__;
    clearOverlay();
    vi.restoreAllMocks();
  });

  it('is false outside the Electron shell', () => {
    expect(isElectronMac()).toBe(false);
  });

  it('is true for the Electron shell on a Mac platform', () => {
    window.__EX_DESKTOP__ = true;
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(isElectronMac()).toBe(true);
  });

  it('is false for the Electron shell elsewhere', () => {
    window.__EX_DESKTOP__ = true;
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
    expect(isElectronMac()).toBe(false);
  });

  // The traffic lights also overlay content WITHOUT the Electron flag: a Window-
  // Controls-Overlay window or an installed standalone PWA. Those are the cases
  // the old __EX_DESKTOP__-only check missed (the hamburger tucked under the
  // traffic lights in the dock-installed app).
  it('is true for a Window-Controls-Overlay window on Mac (no Electron flag)', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    setOverlay(true);
    expect(isElectronMac()).toBe(true);
  });

  it('is true for an installed standalone PWA on Mac (no Electron flag, no WCO)', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const restore = stubDisplayMode(true);
    try {
      expect(isElectronMac()).toBe(true);
    } finally {
      restore();
    }
  });

  it('is false for a framed browser tab on Mac (WCO hidden, not standalone)', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    setOverlay(false);
    const restore = stubDisplayMode(false);
    try {
      expect(isElectronMac()).toBe(false);
    } finally {
      restore();
    }
  });

  it('is false on Mac when matchMedia is unavailable (guards the ?? fallback)', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const original = window.matchMedia;
    // @ts-expect-error intentionally removing matchMedia to hit the ?? false arm
    delete window.matchMedia;
    try {
      expect(isElectronMac()).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('deviceKind fallback arms', () => {
  afterEach(() => {
    window.__EX_FORCE_DEVICE__ = 'touch';
  });

  it('defaults to desktop when matchMedia is unavailable', () => {
    window.__EX_FORCE_DEVICE__ = undefined;
    const original = window.matchMedia;
    // @ts-expect-error intentionally removing matchMedia to hit the guard
    delete window.matchMedia;
    try {
      expect(deviceKind()).toBe('desktop');
    } finally {
      window.matchMedia = original;
    }
  });

  it('a fine pointer reads as desktop', () => {
    window.__EX_FORCE_DEVICE__ = undefined;
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      expect(deviceKind()).toBe('desktop');
    } finally {
      window.matchMedia = original;
    }
  });

  it('isElectronMac resolves via the userAgent when platform is empty', () => {
    window.__EX_DESKTOP__ = true;
    const platformSpy = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('');
    const uaSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
    try {
      expect(isElectronMac()).toBe(true);
    } finally {
      platformSpy.mockRestore();
      uaSpy.mockRestore();
      delete window.__EX_DESKTOP__;
    }
  });
});
