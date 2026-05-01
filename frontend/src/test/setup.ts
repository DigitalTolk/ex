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

// Lexical's TypeaheadMenuPlugin uses ResizeObserver to track the
// trigger anchor's size — jsdom doesn't ship it, so install a no-op
// implementation. The mocked-out plugins in the global setup above
// don't trigger this path; the dedicated typeahead test suites do.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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
