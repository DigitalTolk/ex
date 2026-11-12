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

// numberedShortcutLabel is the hint beside the first nine options of a
// dropdown: ⌘1 to ⌘9 on Apple platforms, Ctrl 1 to Ctrl 9 elsewhere.
export function numberedShortcutLabel(n: number, userAgent: string): string {
  return isApplePlatform(userAgent) ? `⌘${n}` : `Ctrl ${n}`;
}

// numberedShortcut reads ⌘1 to ⌘9 (Ctrl 1 to Ctrl 9 elsewhere, the same chord
// as the search's ⌘K) off a keydown: the option number it picks, or null.
type ChordEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function numberedShortcut(e: ChordEvent, userAgent: string): number | null {
  const apple = isApplePlatform(userAgent);
  const chord = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!chord || e.shiftKey || e.altKey) return null;
  return /^[1-9]$/.test(e.key) ? Number(e.key) : null;
}
