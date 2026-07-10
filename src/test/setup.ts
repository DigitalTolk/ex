import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { APP_VERSION_META, BUILD_VERSION_META } from '@/lib/version-meta';
import './console-gate';
import { resetPresenceStoreForTests } from '@/stores/presence';
import { resetTypingStoreForTests } from '@/stores/typing';

// @base-ui/react/scroll-area uses ResizeObserver inside Root and emits
// async state updates that show up in tests as "An update to
// ScrollAreaRoot inside a test was not wrapped in act(...)". The
// scrollbar logic is non-functional in jsdom (no layout), so the
// pragmatic fix is to swap each subcomponent for a passthrough <div>.
vi.mock('@base-ui/react/scroll-area', () => {
  const passthrough = (props: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('div', props, props.children);
  return {
    ScrollArea: {
      Root: passthrough,
      Viewport: passthrough,
      Scrollbar: passthrough,
      Thumb: passthrough,
      Corner: passthrough,
    },
  };
});

// Seed the version meta tag so useServerVersion's BUILD_VERSION resolves
// to a stable, non-dev value across the suite. The hook reads this once
// on module load — vitest setupFiles run before module imports.
if (typeof document !== 'undefined') {
  if (!document.querySelector(`meta[name="${APP_VERSION_META}"]`)) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', APP_VERSION_META);
    meta.setAttribute('content', 'test');
    document.head.appendChild(meta);
  }
  if (!document.querySelector(`meta[name="${BUILD_VERSION_META}"]`)) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', BUILD_VERSION_META);
    meta.setAttribute('content', 'release-test');
    document.head.appendChild(meta);
  }
}

// Lexical's TypeaheadMenuPlugin and react-virtuoso both depend on
// ResizeObserver. jsdom doesn't ship it; install a polyfill that
// fires its callback once on observe() with a non-zero rect so
// Virtuoso sees a viewport and proceeds to render rows. Lexical
// only uses the observer for size tracking, so an extra synchronous
// fire is harmless there.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.callback = cb;
    }
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 1024, height: 768 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Virtuoso reads offsetHeight/offsetWidth on items + scroller to
// decide which rows to render. jsdom returns 0 for both, which makes
// Virtuoso bail out and render nothing. Stub fixed non-zero sizes
// so the viewport (clientHeight) is comfortably larger than each
// item (offsetHeight) and Virtuoso renders enough rows to test.
if (typeof HTMLElement !== 'undefined') {
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return 50; },
    });
  }
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return 1024; },
    });
  }
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return 768; },
    });
  }
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return 1024; },
    });
  }
}

// jsdom doesn't ship DragEvent / ClipboardEvent. Paste/drag handling in the
// composer and drop zones constructs and discriminates these events, which
// throws a ReferenceError without the globals. Polyfill with named subclasses
// so any constructor.name-based discrimination still works as intended.
if (typeof globalThis.DragEvent === 'undefined') {
  class DragEvent extends Event {
    dataTransfer: DataTransfer | null;
    constructor(type: string, init?: DragEventInit) {
      super(type, init);
      this.dataTransfer = init?.dataTransfer ?? null;
    }
  }
  globalThis.DragEvent = DragEvent as unknown as typeof globalThis.DragEvent;
}
if (typeof globalThis.ClipboardEvent === 'undefined') {
  class ClipboardEvent extends Event {
    clipboardData: DataTransfer | null;
    constructor(type: string, init?: ClipboardEventInit) {
      super(type, init);
      this.clipboardData = init?.clipboardData ?? null;
    }
  }
  globalThis.ClipboardEvent = ClipboardEvent as unknown as typeof globalThis.ClipboardEvent;
}

// Lexical / ProseMirror call coordsAtPos → singleRect → getClientRects on
// DOM nodes during routine selection updates. jsdom doesn't compute
// layout so the prototype methods are missing — installing zero-rect
// stubs keeps the editor functional in tests (we don't assert geometry).
if (typeof Element !== 'undefined') {
  if (!Element.prototype.getClientRects) {
    Element.prototype.getClientRects = function getClientRects() {
      return [] as unknown as DOMRectList;
    };
  }
  if (!Element.prototype.getBoundingClientRect) {
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
}
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  };
}
// ProseMirror's posAtCoords / mousedown handler calls
// document.elementFromPoint, which jsdom doesn't ship. Tests don't
// assert hit-testing behaviour, so a fixed null is a safe stub.
if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
  (document as Document & { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => null;
}

// Historical test compatibility: "mobile" used to be width-only. The device
// split (touch vs desktop, lib/device.ts) defaults tests to a TOUCH device so
// every width-driven mobile test keeps its meaning; compact-tier tests
// override this to 'desktop' explicitly.
if (typeof window !== 'undefined') {
  window.__EX_FORCE_DEVICE__ = 'touch';
}

// jsdom doesn't ship matchMedia, but Sonner (and other libs that adapt to
// the user's color-scheme preference) read it during render. A null-safe
// polyfill keeps test renders from blowing up; tests that care about
// media-query behavior override it on a per-test basis.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// The presence/typing zustand stores are module-global (per-user/-bucket
// selector subscriptions for hot paths) — without a reset, one test's
// state leaks into the next test in the same file. Reset after every
// test so suites keep the isolation they had with provider-local state.
afterEach(() => {
  resetPresenceStoreForTests();
  resetTypingStoreForTests();
});
