import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { SettingsDialog } from './SettingsDialog';

// A desktop window squeezed under 768px keeps desktop chrome everywhere else,
// but the Settings dialog switches to its phone layout: the section nav moves
// to a row of tabs above a single full-width page.
vi.mock('./ProfileSettings', () => ({ ProfileSettings: () => <p>profile-body</p> }));
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => <p>appearance-body</p> }));
vi.mock('./NotificationsSettings', () => ({ NotificationsSettings: () => <p>notifications-body</p> }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));

// Only the desktop project has a desktop-sized window to squeeze.
const isDesktopProject = window.__EX_FORCE_DEVICE__ === 'desktop';

function navDirection() {
  const nav = document.querySelector('nav[aria-label="Settings sections"]');
  return getComputedStyle(nav!.querySelector('div')!).flexDirection;
}

describe.runIf(isDesktopProject)('SettingsDialog in a narrow desktop window', () => {
  afterEach(async () => {
    cleanup();
    await page.viewport(1280, 900);
  });

  it('shows the section nav as a column at full width', async () => {
    const screen = await render(<SettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('profile-body')).toBeVisible();
    expect(navDirection()).toBe('column');
  });

  it('switches to tabs above the page under 768px', async () => {
    await page.viewport(500, 800);
    const screen = await render(<SettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('profile-body')).toBeVisible();
    expect(navDirection()).toBe('row');
    // The page spans the dialog's full width rather than sitting beside the nav.
    const dialog = screen.getByTestId('settings-dialog').element().getBoundingClientRect();
    const body = screen.getByTestId('settings-page-profile').element().getBoundingClientRect();
    expect(Math.round(body.width)).toBe(Math.round(dialog.width));
    // Still a desktop dialog: the X closes it (no phone "Done" bar).
    await expect.element(screen.getByRole('button', { name: 'Close' })).toBeVisible();
  });
});
