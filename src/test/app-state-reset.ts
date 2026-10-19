// State the app keeps at module level, outside React and the zustand stores
// (./store-reset) — the activity clock, the thread scope, the tab election,
// the notification trace — back to its start after every test, so a test
// cannot pass or fail on what the one before it left behind (a test that
// marked the user away left the next one's notification unsuppressed).
//
// Imported lazily, after the test: a setup-time import would load the real
// modules before a test file's vi.mock could replace them. A module a test
// mocked may have no reset, and reading a missing export from a vitest mock
// throws, so each reset is looked up defensively.

type Module = Record<string, unknown>;

async function callReset(load: () => Promise<Module>, name: string): Promise<void> {
  let reset: unknown;
  try {
    reset = (await load())[name];
  } catch {
    return; // mocked without it
  }
  if (typeof reset === 'function') await (reset as () => unknown)();
}

export async function resetAppStateForTests(): Promise<void> {
  await Promise.all([
    callReset(() => import('@/lib/tab-leader'), 'resetTabCoordinatorForTests'),
    callReset(() => import('@/lib/user-activity'), 'resetUserActivityForTests'),
    callReset(() => import('@/lib/desktop-presence'), 'resetDesktopPresenceForTests'),
    callReset(() => import('@/lib/thread-scope'), 'resetThreadScopeForTests'),
    callReset(() => import('@/lib/notification-trace'), 'resetNotificationTraceForTests'),
    callReset(() => import('@/lib/input-modality'), 'resetInputModalityForTests'),
    callReset(() => import('@/hooks/useMobileBackClose'), 'resetMobileBackCloseForTests'),
    callReset(() => import('@/stores/reaction-flash'), 'resetReactionFlashForTests'),
  ]);
}
