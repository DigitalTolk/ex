import { vi } from 'vitest';

// jsdom has no Navigation API; a stand-in reports what the browser would and
// records the traversals asked of it. Install it per test and remove it after
// (uninstallNavigation) — nothing may carry over to the next test.
export class FakeNavigation extends EventTarget {
  canGoBack = false;
  canGoForward = false;
  // How the next traversal settles: a real one rejects both promises when it
  // is refused or overtaken by another navigation.
  outcome: 'commit' | 'reject' = 'commit';
  back = vi.fn(() => this.result());
  forward = vi.fn(() => this.result());

  // Where history can go now, announced the way the browser does.
  move(back: boolean, forward: boolean) {
    this.canGoBack = back;
    this.canGoForward = forward;
    this.dispatchEvent(new Event('currententrychange'));
  }

  private result(): NavigationResult {
    if (this.outcome === 'reject') {
      const aborted = new DOMException('The navigation was aborted', 'AbortError');
      return { committed: Promise.reject(aborted), finished: Promise.reject(aborted) };
    }
    const entry = {} as NavigationHistoryEntry;
    return { committed: Promise.resolve(entry), finished: Promise.resolve(entry) };
  }
}

export function installNavigation(): FakeNavigation {
  const nav = new FakeNavigation();
  Object.defineProperty(window, 'navigation', { value: nav, configurable: true });
  return nav;
}

export function uninstallNavigation(): void {
  Reflect.deleteProperty(window, 'navigation');
}
