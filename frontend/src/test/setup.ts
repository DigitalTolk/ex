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
