// Platform helpers kept as PURE functions of the user-agent string so both
// branches are deterministically unit-testable (navigator can't be varied per
// test). This is a browser-only SPA, so callers pass `navigator.userAgent`
// directly — no SSR guard needed.

// isApplePlatform reports whether the UA looks like macOS / iOS / iPadOS.
export function isApplePlatform(userAgent: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(userAgent);
}

// searchShortcutLabel is the visible keyboard hint for the global search
// shortcut: ⌘K on Apple platforms, Ctrl K on Windows/Linux. The keydown handler
// itself accepts either modifier; this only drives the on-screen label.
export function searchShortcutLabel(userAgent: string): string {
  return isApplePlatform(userAgent) ? '⌘K' : 'Ctrl K';
}
