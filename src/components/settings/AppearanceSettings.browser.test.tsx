import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { AppearanceSettings } from './AppearanceSettings';
import { SIDEBAR_THEME_STORAGE_KEY, useSidebarThemeStore } from '@/stores/sidebar-theme';

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

  // The sidebar's own colours: dark by default, in the light theme too.
  it('offers a dark or a light sidebar, dark to start with', async () => {
    const screen = await render(<AppearanceSettings />);
    const group = screen.getByRole('radiogroup', { name: 'Sidebar' });
    await expect.element(group.getByRole('radio', { name: 'Dark sidebar' })).toHaveAttribute('aria-checked', 'true');
    await expect.element(group.getByRole('radio', { name: 'Light sidebar' })).toHaveAttribute('aria-checked', 'false');
    expect(group.getByRole('radio').elements()).toHaveLength(2);
    await expect
      .element(screen.getByText('Dark keeps the sidebar dark in the light theme too. In the dark theme it is always dark.'))
      .toBeVisible();
  });

  it('picking a sidebar card sets the sidebar theme, keeps it for the next visit, and leaves the app theme alone', async () => {
    const screen = await render(<AppearanceSettings />);
    const dark = screen.getByTestId('sidebar-theme-option-dark');
    const light = screen.getByTestId('sidebar-theme-option-light');

    await light.click();
    await expect.element(light).toHaveAttribute('aria-checked', 'true');
    await expect.element(dark).toHaveAttribute('aria-checked', 'false');
    expect(useSidebarThemeStore.getState().theme).toBe('light');
    expect(localStorage.getItem(SIDEBAR_THEME_STORAGE_KEY)).toContain('"theme":"light"');

    await dark.click();
    await expect.element(dark).toHaveAttribute('aria-checked', 'true');
    await expect.element(light).toHaveAttribute('aria-checked', 'false');
    expect(useSidebarThemeStore.getState().theme).toBe('dark');
    expect(localStorage.getItem(SIDEBAR_THEME_STORAGE_KEY)).toContain('"theme":"dark"');

    expect(setTheme).not.toHaveBeenCalled();
  });

  it('marks the sidebar theme already chosen on this device', async () => {
    useSidebarThemeStore.setState({ theme: 'light' });
    const screen = await render(<AppearanceSettings />);
    await expect.element(screen.getByTestId('sidebar-theme-option-light')).toHaveAttribute('aria-checked', 'true');
    await expect.element(screen.getByTestId('sidebar-theme-option-dark')).toHaveAttribute('aria-checked', 'false');
  });

  // Each card previews its choice beside a light page, whichever is active.
  it('previews a dark sidebar on the Dark card and a light one on the Light card', async () => {
    const screen = await render(<AppearanceSettings />);
    await expect.element(screen.getByTestId('sidebar-theme-option-dark')).toBeVisible();
    const [darkSide, darkPage] = Array.from(
      screen.getByTestId('sidebar-theme-option-dark').element().querySelectorAll<HTMLElement>('.grid > div'),
    );
    const [lightSide, lightPage] = Array.from(
      screen.getByTestId('sidebar-theme-option-light').element().querySelectorAll<HTMLElement>('.grid > div'),
    );
    expect(getComputedStyle(darkSide).backgroundColor).toBe('rgb(29, 29, 29)');
    expect(getComputedStyle(lightSide).backgroundColor).toBe('rgb(249, 249, 247)');
    expect(getComputedStyle(darkPage).backgroundColor).toBe('rgb(252, 252, 251)');
    expect(getComputedStyle(lightPage).backgroundColor).toBe('rgb(252, 252, 251)');
  });

  it('hides the Sidebar section on phones, where the list follows the theme', async () => {
    isMobileRef.value = true;
    const screen = await render(<AppearanceSettings />);
    await expect.element(screen.getByTestId('theme-option-dark')).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Sidebar' }).query()).toBeNull();
    expect(screen.getByTestId('sidebar-theme-option-dark').query()).toBeNull();
    expect(screen.getByTestId('sidebar-theme-option-light').query()).toBeNull();
  });
});
