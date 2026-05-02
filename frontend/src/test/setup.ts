import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { APP_VERSION_META } from '@/lib/version-meta';

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
}

// The Lexical typeahead plugins (@-mentions, ~-channels, :-emojis)
// each call React Query data hooks. Tests that mount UI containing the
// composer (ChannelView, ConversationView, MessageInput, etc.) but
// don't exercise typeahead behaviour would otherwise need to mock all
// three data sources — that's repetitive scaffolding. Replace the
// plugins with no-ops globally; suites that DO test the popups
// (WysiwygEditor.test.tsx) override these mocks with their own factory.
vi.mock('@/components/chat/lexical/plugins/UserMentionsPlugin', () => ({
  UserMentionsPlugin: () => null,
}));
vi.mock('@/components/chat/lexical/plugins/ChannelMentionsPlugin', () => ({
  ChannelMentionsPlugin: () => null,
}));
vi.mock('@/components/chat/lexical/plugins/EmojiShortcutsPlugin', () => ({
  EmojiShortcutsPlugin: () => null,
}));

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

// jsdom doesn't ship DragEvent / ClipboardEvent. @lexical/rich-text's
// PASTE_COMMAND handler runs eventFiles(event), which uses
// objectKlassEquals(event, DragEvent | ClipboardEvent) to discriminate
// drag-and-drop from paste. Without the globals defined, that throws
// a ReferenceError; with anonymous polyfills, every event collides
// because objectKlassEquals matches on constructor.name (== '' on
// both sides). Polyfill with named subclasses so the discriminator
// works as intended.
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

// @lexical/code-core warns "Using CodeNode without CodeExtension is
// deprecated" the first time it has to fall back to the legacy
// in-place exit logic in CodeNode.insertNewAfter. CodeExtension is
// only registerable via LexicalBuilder (LexicalExtensionComposer);
// our editor uses LexicalComposer with `nodes:`, which can't host
// extensions yet. The legacy path is functionally identical to the
// extension's command, so suppress this specific message — leaving
// every other deprecation / warning untouched.
const originalConsoleWarn = console.warn;
console.warn = (...args: Parameters<Console['warn']>) => {
  // startsWith — not strict equality — so a future Lexical patch
  // version that appends to the message (e.g. "...; use CodeExtension
  // instead") still gets suppressed without re-breaking the gate.
  const first = args[0];
  if (typeof first === 'string' && first.startsWith('Using CodeNode without CodeExtension')) return;
  originalConsoleWarn(...args);
};

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
