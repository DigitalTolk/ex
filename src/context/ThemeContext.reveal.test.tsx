import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

// The theme switch plays the dancing gopher only when asked and only when
// the page actually changes between light and dark.

const revealTheme = vi.hoisted(() => vi.fn(async (apply: () => void) => {
  apply();
  return true;
}));
vi.mock('@/lib/theme-transition', () => ({ revealTheme }));

import { ThemeProvider, useTheme } from './ThemeContext';

function Switches() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme('dark', true)}>reveal dark</button>
      <button onClick={() => setTheme('light', true)}>reveal light</button>
      <button onClick={() => setTheme('system', true)}>reveal system</button>
      <button onClick={() => setTheme('dark')}>plain dark</button>
    </div>
  );
}

function setSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('dark') && dark,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  revealTheme.mockClear();
  localStorage.clear();
  localStorage.setItem('theme', 'light');
  document.documentElement.classList.remove('dark');
  setSystemDark(false);
});

describe('ThemeContext reveal', () => {
  it('plays the reveal from light to dark, and changes the theme in it', async () => {
    const { getByText, getByTestId } = render(
      <ThemeProvider>
        <Switches />
      </ThemeProvider>,
    );
    await act(async () => {
      fireEvent.click(getByText('reveal dark'));
    });
    expect(revealTheme).toHaveBeenCalledOnce();
    expect(getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('plays nothing when the look does not change (light to "Match system" on a light machine)', async () => {
    const { getByText, getByTestId } = render(
      <ThemeProvider>
        <Switches />
      </ThemeProvider>,
    );
    await act(async () => {
      fireEvent.click(getByText('reveal system'));
    });
    expect(revealTheme).not.toHaveBeenCalled();
    expect(getByTestId('theme').textContent).toBe('system');
  });

  it('plays it to "Match system" when that turns the page dark', async () => {
    setSystemDark(true);
    const { getByText } = render(
      <ThemeProvider>
        <Switches />
      </ThemeProvider>,
    );
    await act(async () => {
      fireEvent.click(getByText('reveal system'));
    });
    expect(revealTheme).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('plays nothing unless asked', async () => {
    const { getByText } = render(
      <ThemeProvider>
        <Switches />
      </ThemeProvider>,
    );
    await act(async () => {
      fireEvent.click(getByText('plain dark'));
    });
    expect(revealTheme).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
