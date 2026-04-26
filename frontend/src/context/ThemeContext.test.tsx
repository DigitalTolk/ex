import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeContext';

function ThemeConsumer() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme('dark')}>set dark</button>
      <button onClick={() => setTheme('light')}>set light</button>
      <button onClick={() => setTheme('system')}>set system</button>
    </div>
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to system theme', () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(getByTestId('theme').textContent).toBe('system');
  });

  it('switches to dark and adds dark class', () => {
    const { getByText, getByTestId } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    fireEvent.click(getByText('set dark'));
    expect(getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('switches to light and removes dark class', () => {
    document.documentElement.classList.add('dark');
    const { getByText, getByTestId } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    fireEvent.click(getByText('set light'));
    expect(getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reads saved theme from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(getByTestId('theme').textContent).toBe('dark');
  });
});
