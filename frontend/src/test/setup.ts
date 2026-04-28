import '@testing-library/jest-dom/vitest';
import { APP_VERSION_META } from '@/lib/version-meta';

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
