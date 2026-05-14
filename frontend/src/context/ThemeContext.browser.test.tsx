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
});
