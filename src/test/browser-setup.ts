import 'vitest-browser-react';
import '@vitest/browser/matchers';
import '../index.css';
import { APP_VERSION_META, BUILD_VERSION_META } from '@/lib/version-meta';
import './console-gate';
import { resetPresenceStoreForTests } from '@/stores/presence';
import { resetTypingStoreForTests } from '@/stores/typing';
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  if (!document.querySelector(`meta[name="${APP_VERSION_META}"]`)) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', APP_VERSION_META);
    meta.setAttribute('content', 'browser-test');
    document.head.appendChild(meta);
  }
  if (!document.querySelector(`meta[name="${BUILD_VERSION_META}"]`)) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', BUILD_VERSION_META);
    meta.setAttribute('content', 'browser-release-test');
    document.head.appendChild(meta);
  }
}

// Device pinning for the browser projects: the mobile-viewport projects are
// "touch" devices, the desktop project is a "desktop" device — mirroring what
// each project's tests have always meant. Compact-tier tests resize the
// viewport within the desktop project; the tier classes track live.
//
// Deliberately INLINED instead of importing lib/device: a setup-time import
// would load the real @/lib/capacitor into the module graph before test
// files' vi.mock('@/lib/capacitor') can substitute it (this broke the
// haptics + AppTopBar native mocks). The logic mirrors lib/device.ts
// layoutTierFor(), which device.test.ts pins.
window.__EX_FORCE_DEVICE__ = window.innerWidth < 768 ? 'touch' : 'desktop';
function stampTierClasses() {
  const touch = window.__EX_FORCE_DEVICE__ === 'touch';
  const w = window.innerWidth;
  const tier = w >= 1024 ? 'tier-full' : w < 768 && touch ? 'tier-mobile' : 'tier-compact';
  const root = document.documentElement;
  root.classList.remove('tier-mobile', 'tier-compact', 'tier-full');
  root.classList.add(tier);
  root.classList.toggle('device-touch', touch);
}
stampTierClasses();
window.addEventListener('resize', stampTierClasses);

// The presence/typing zustand stores are module-global (per-user/-bucket
// selector subscriptions for hot paths) — without a reset, one test's
// state leaks into the next test in the same file. Reset after every
// test so suites keep the isolation they had with provider-local state.
afterEach(() => {
  resetPresenceStoreForTests();
  resetTypingStoreForTests();
});
