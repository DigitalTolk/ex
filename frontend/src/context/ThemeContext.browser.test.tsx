import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ThemeProvider, useTheme } from './ThemeContext';

beforeEach(() => {
  window.localStorage.removeItem('theme');
  document.documentElement.classList.remove('dark');
});

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button data-testid="set-light" onClick={() => setTheme('light')}>light</button>
      <button data-testid="set-dark" onClick={() => setTheme('dark')}>dark</button>
      <button data-testid="set-system" onClick={() => setTheme('system')}>system</button>
    </div>
  );
}

describe('ThemeContext', () => {
  it('reads the initial theme from localStorage when present', async () => {
    window.localStorage.setItem('theme', 'dark');
    const screen = await render(
      <ThemeProvider><Probe /></ThemeProvider>,
    );
    expect(screen.getByTestId('theme').element().textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to "system" when no stored preference', async () => {
    const screen = await render(
      <ThemeProvider><Probe /></ThemeProvider>,
    );
    expect(screen.getByTestId('theme').element().textContent).toBe('system');
  });

  it('setTheme("light") removes the dark class and persists', async () => {
    document.documentElement.classList.add('dark');
    const screen = await render(
      <ThemeProvider><Probe /></ThemeProvider>,
    );
    (screen.getByTestId('set-light').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem('theme')).toBe('light');
  });

  it('setTheme("dark") adds the dark class and persists', async () => {
    const screen = await render(
      <ThemeProvider><Probe /></ThemeProvider>,
    );
    (screen.getByTestId('set-dark').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });

  it('setTheme("system") consults prefers-color-scheme', async () => {
    const screen = await render(
      <ThemeProvider><Probe /></ThemeProvider>,
    );
    (screen.getByTestId('set-system').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(window.localStorage.getItem('theme')).toBe('system');
    // Either dark or light is correct depending on the runner OS;
    // we just confirm the class state reflects what matchMedia reports.
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    expect(document.documentElement.classList.contains('dark')).toBe(dark);
  });

  it('re-applies the system theme when prefers-color-scheme changes', async () => {
    const cap: { handler: (() => void) | null; matches: boolean } = { handler: null, matches: false };
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() { return cap.matches; },
      media: query,
      onchange: null,
      addEventListener: (_: string, h: () => void) => { cap.handler = h; },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      document.documentElement.classList.remove('dark');
      const screen = await render(<ThemeProvider><Probe /></ThemeProvider>);
      (screen.getByTestId('set-system').element() as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      // Flip the OS preference and fire the matchMedia change → onChange
      // re-applies 'system' (the theme === 'system' guard branch).
      cap.matches = true;
      cap.handler?.();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it('uses the read-only fallback (reflecting the dark class) outside a provider', async () => {
    document.documentElement.classList.add('dark');
    const screen = await render(<Probe />);
    // No provider → useTheme returns the fallback, whose getter reads the
    // documentElement class.
    expect(screen.getByTestId('theme').element().textContent).toBe('dark');
    // setTheme is a no-op in the fallback.
    (screen.getByTestId('set-light').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('fallback reports "light" when the dark class is absent', async () => {
    document.documentElement.classList.remove('dark');
    const screen = await render(<Probe />);
    expect(screen.getByTestId('theme').element().textContent).toBe('light');
  });

  it('applies "system" without crashing when matchMedia is unavailable (defaults to light)', async () => {
    // Drop matchMedia entirely so both applyTheme's `typeof matchMedia
    // === "function"` guard (→ dark=false) and the effect's early-return
    // guard (no listener registered) take their false arms.
    const realMatchMedia = window.matchMedia;
    document.documentElement.classList.add('dark');
    // @ts-expect-error — intentionally remove the API for this scenario.
    delete window.matchMedia;
    try {
      const screen = await render(<ThemeProvider><Probe /></ThemeProvider>);
      (screen.getByTestId('set-system').element() as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      // With no matchMedia, system resolves to light → dark class removed.
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it('ignores prefers-color-scheme changes while the active theme is not "system"', async () => {
    const cap: { handler: (() => void) | null; matches: boolean } = { handler: null, matches: false };
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() { return cap.matches; },
      media: query,
      onchange: null,
      addEventListener: (_: string, h: () => void) => { cap.handler = h; },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      document.documentElement.classList.remove('dark');
      const screen = await render(<ThemeProvider><Probe /></ThemeProvider>);
      // Explicit light theme — the onChange handler's `theme === "system"`
      // guard is now false, so an OS flip must NOT toggle the class.
      (screen.getByTestId('set-light').element() as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      cap.matches = true;
      cap.handler?.();
      await new Promise((r) => setTimeout(r, 20));
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});
