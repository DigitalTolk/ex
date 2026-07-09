import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('dark mode', () => {
  let matchMediaListeners: Array<(e: { matches: boolean }) => void>;

  beforeEach(() => {
    matchMediaListeners = [];
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  function simulateMatchMedia(prefersDark: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
        media: query,
        addEventListener: (_event: string, cb: (e: { matches: boolean }) => void) => {
          matchMediaListeners.push(cb);
        },
        removeEventListener: () => {},
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  function runDarkModeScript() {
    // Replicate the inline script from index.html
    const d = document.documentElement;
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      d.classList.add('dark');
    } else {
      d.classList.remove('dark');
    }
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e: { matches: boolean }) => {
        d.classList.toggle('dark', e.matches);
      });
  }

  it('adds .dark class when system prefers dark', () => {
    simulateMatchMedia(true);
    runDarkModeScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not add .dark class when system prefers light', () => {
    simulateMatchMedia(false);
    runDarkModeScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggles .dark class when system preference changes', () => {
    simulateMatchMedia(false);
    runDarkModeScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Simulate system switching to dark
    for (const listener of matchMediaListeners) {
      listener({ matches: true });
    }
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Simulate system switching back to light
    for (const listener of matchMediaListeners) {
      listener({ matches: false });
    }
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
