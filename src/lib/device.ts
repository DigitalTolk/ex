import { isNativePlatform } from '@/lib/capacitor';

// Device kind is about INPUT, not viewport: a phone/tablet is 'touch', a
// desktop browser or the Electron shell is 'desktop' — even when its window
// is squeezed to phone width (Slack-next-to-ex half-screen). The layout tier
// combines this with the viewport width:
//
//   tier      width      device    UI
//   mobile    <768       touch     mobile-native (drawer, sheets, gestures)
//   compact   <1024      desktop   desktop chrome, toggleable overlay sidebar
//   compact   768-1023   touch     same compact treatment (tablet portrait)
//   full      >=1024     any       persistent (resizable) sidebar
//
// Tests pin the kind via window.__EX_FORCE_DEVICE__ (set in the jsdom and
// browser setups to mirror the historical width-only behavior) so every
// existing width-driven test keeps meaning what it meant.

export type DeviceKind = 'touch' | 'desktop';

export function deviceKind(): DeviceKind {
  if (window.__EX_FORCE_DEVICE__) return window.__EX_FORCE_DEVICE__;
  // The Capacitor shell is always a touch device; the Electron shell never is.
  if (isNativePlatform()) return 'touch';
  if (window.__EX_DESKTOP__) return 'desktop';
  if (typeof window.matchMedia !== 'function') return 'desktop';
  return window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop';
}

export type LayoutTier = 'mobile' | 'compact' | 'full';

export function layoutTierFor(width: number, kind: DeviceKind): LayoutTier {
  if (width >= 1024) return 'full';
  if (width < 768 && kind === 'touch') return 'mobile';
  return 'compact';
}

export function currentLayoutTier(): LayoutTier {
  return layoutTierFor(window.innerWidth, deviceKind());
}

// isElectronMac reports the one chrome-collision case the web app must
// compensate for: a FRAMELESS macOS window draws the traffic lights over the
// top-left of the web content, so the compact tier's sidebar toggle must be
// inset past them. This is NOT Electron-specific — it happens for the Electron
// shell (titleBarStyle:hiddenInset, which sets __EX_DESKTOP__), a Window-
// Controls-Overlay window, AND an installed standalone PWA (dock/Launchpad),
// none of which the old __EX_DESKTOP__-only check caught. A normal browser TAB
// is framed — the traffic lights belong to the browser, not the content — so it
// hits none of these signals and stays un-padded.
export function isElectronMac(): boolean {
  const isMac =
    /Mac/i.test(window.navigator.platform) || /Macintosh/i.test(window.navigator.userAgent);
  if (!isMac) return false;
  if (window.__EX_DESKTOP__) return true;
  if (window.navigator.windowControlsOverlay?.visible) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

const TIER_CLASSES: Record<LayoutTier, string> = {
  mobile: 'tier-mobile',
  compact: 'tier-compact',
  full: 'tier-full',
};

// applyLayoutTierClasses stamps the current tier (and device kind) onto
// <html> so Tailwind variants (`mobile:` / `compact:`) share the EXACT same
// predicate as the JS hooks — the audit showed every past regression in this
// area came from CSS and JS disagreeing about what "mobile" means.
export function applyLayoutTierClasses(): LayoutTier {
  const root = document.documentElement;
  const tier = currentLayoutTier();
  for (const cls of Object.values(TIER_CLASSES)) root.classList.remove(cls);
  root.classList.add(TIER_CLASSES[tier]);
  root.classList.toggle('device-touch', deviceKind() === 'touch');
  root.classList.toggle('electron-mac', isElectronMac());
  return tier;
}

// startLayoutTierTracking keeps the root classes in sync with window
// resizes. Idempotent; returns a stop function (tests).
let tracking = false;
export function startLayoutTierTracking(): () => void {
  applyLayoutTierClasses();
  if (tracking) return () => undefined;
  tracking = true;
  const onResize = () => applyLayoutTierClasses();
  window.addEventListener('resize', onResize);
  return () => {
    tracking = false;
    window.removeEventListener('resize', onResize);
  };
}
