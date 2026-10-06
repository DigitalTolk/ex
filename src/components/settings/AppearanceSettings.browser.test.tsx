import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { AppearanceSettings } from './AppearanceSettings';

const themeRef = vi.hoisted(() => ({ value: 'system' as 'light' | 'dark' | 'system' }));
const setTheme = vi.hoisted(() => vi.fn());
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme }),
}));

const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileRef.value }));

const panel = vi.hoisted(() => ({ customized: true, reset: vi.fn() }));
vi.mock('@/lib/panel-width', () => ({
  hasCustomPanelWidths: () => panel.customized,
  resetPanelWidths: panel.reset,
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

describe('AppearanceSettings', () => {
  beforeEach(() => {
    themeRef.value = 'system';
    isMobileRef.value = false;
    panel.customized = true;
    panel.reset.mockClear();
    setTheme.mockClear();
    showToast.mockClear();
  });
  afterEach(() => cleanup());

  it.each(['light', 'dark', 'system'] as const)('marks the current theme (%s) as selected', async (theme) => {
    themeRef.value = theme;
    const screen = await render(<AppearanceSettings />);
    for (const t of ['light', 'dark', 'system']) {
      await expect.element(screen.getByTestId(`theme-option-${t}`)).toHaveAttribute('aria-checked', String(t === theme));
    }
  });

  it('picking a theme card sets the theme', async () => {
    const screen = await render(<AppearanceSettings />);
    await screen.getByRole('radio', { name: 'Dark theme' }).click();
    expect(setTheme).toHaveBeenCalledWith('dark');
    await screen.getByRole('radio', { name: 'Light theme' }).click();
    expect(setTheme).toHaveBeenCalledWith('light');
    await screen.getByRole('radio', { name: 'Match system theme' }).click();
    expect(setTheme).toHaveBeenCalledWith('system');
  });

  it('resets panel widths, then disables the button and confirms', async () => {
    const screen = await render(<AppearanceSettings />);
    const reset = screen.getByTestId('reset-panel-widths');
    await expect.element(reset).toBeEnabled();
    await reset.click();
    expect(panel.reset).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Panel widths reset', 'success');
    await expect.element(reset).toBeDisabled();
  });

  it('disables Reset when nothing was customized', async () => {
    panel.customized = false;
    const screen = await render(<AppearanceSettings />);
    await expect.element(screen.getByTestId('reset-panel-widths')).toBeDisabled();
  });

  it('hides the Layout section on mobile', async () => {
    isMobileRef.value = true;
    const screen = await render(<AppearanceSettings />);
    await expect.element(screen.getByText('Theme')).toBeVisible();
    expect(screen.getByText('Layout').query()).toBeNull();
  });
});
