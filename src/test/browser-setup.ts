import 'vitest-browser-react';
import '@vitest/browser/matchers';
import '../index.css';
import { APP_VERSION_META, BUILD_VERSION_META } from '@/lib/version-meta';
import './console-gate';
import { resetPresenceStoreForTests } from '@/stores/presence';
import { resetTypingStoreForTests } from '@/stores/typing';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetAllStores } from './store-reset';
import { parkMouse } from './hover';
import { resetAppStateForTests } from './app-state-reset';

// Every zustand store starts each test at its initial state (./store-reset).
vi.mock('zustand', async (importOriginal) => {
  const { withStoreResets } = await import('./store-reset');
  return withStoreResets(await importOriginal<typeof import('zustand')>());
});

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
  // A test that attaches a mouse/trackpad must not leak it into the next one.
  // (Set directly rather than through lib/device — see the import note above.)
  delete window.__EX_POINTER_DEVICE__;
});

// Everything else a test can leave for the next one, cleared before each
// test — not after: vitest-browser-react unmounts the previous test in its
// own beforeEach (registered first, by the import at the top), so by now the
// page is empty, where an afterEach still had the test's dialogs open (the
// mouse could not be moved past a modal backdrop). Every file in a browser
// project shares the page, so this also clears what the previous FILE left.
beforeEach(async () => {
  resetAllStores();
  localStorage.clear();
  sessionStorage.clear();
  await resetAppStateForTests();
  // The real mouse stays wherever a test left it, and this test's content
  // would render under it hovered (a hover-coloured button, a row's toolbar).
  await parkMouse();
});
