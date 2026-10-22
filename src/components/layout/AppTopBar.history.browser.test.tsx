import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { BrowserRouter, Link, useLocation } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { SIDEBAR_WIDTH } from '@/lib/panel-width';

// Back and Forward in the top bar, Slack-style: through the tab's real
// history, beside the sidebar, with the search field still centred.

vi.mock('@/components/activity/ActivityModeSwitch', () => ({
  ActivityModeSwitch: () => <div data-testid="sidebar-mode-switch" />,
}));
vi.mock('./MobileTabBar', () => ({ MobileTabBar: () => <nav data-testid="mobile-tab-bar" /> }));
vi.mock('@/components/activity/ActivityPanel', () => ({
  ActivityPanel: () => <div data-testid="activity-panel" />,
}));
// w-full mirrors the real SearchBar root, which fills the centre column.
vi.mock('@/components/SearchBar', () => ({ SearchBar: () => <input aria-label="Search" className="w-full" /> }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Tess', email: 't@x.io', authProvider: 'oidc', systemRole: 2 },
    patchUser: vi.fn(),
  }),
}));
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('./Sidebar', () => ({ Sidebar: () => <nav data-testid="sidebar-body">channels</nav> }));
vi.mock('./AccountMenu', () => ({ AccountMenu: () => <div data-testid="sidebar-account" /> }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));
vi.mock('./LoadingBar', () => ({ LoadingBar: () => null }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/hooks/useServerVersion', () => ({
  BUILD_DISPLAY_VERSION: 'browser-test',
  BUILD_VERSION: 'browser-test',
  setServerVersion: vi.fn(),
  resetServerVersionForTests: vi.fn(),
  useServerVersion: () => ({ outdated: false }),
}));

const isDesktopProject = window.innerWidth >= 1024;

function Page() {
  const { pathname } = useLocation();
  return (
    <div>
      <p data-testid="path">{pathname}</p>
      <Link to="/channel/b">to b</Link>
    </div>
  );
}

let active: { unmount: () => Promise<void> } | null = null;
let start = '';

beforeEach(() => {
  start = window.location.pathname + window.location.search;
  // A fresh entry on top: nothing to go forward to.
  window.history.pushState(null, '', '/channel/a');
});

afterEach(async () => {
  if (active) await active.unmount();
  active = null;
  window.history.replaceState(null, '', start);
  document.documentElement.classList.remove('electron-mac');
  if (isDesktopProject) await page.viewport(1280, 900);
});

async function renderLayout() {
  active = await render(
    <BrowserRouter>
      <AppLayout>
        <Page />
      </AppLayout>
    </BrowserRouter>,
  );
}

const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
const centre = (r: DOMRect) => (r.left + r.right) / 2;

describe('Back and Forward in the top bar', () => {
  it('go back and forward through the visited pages', async () => {
    if (!isDesktopProject) return;
    await renderLayout();
    const back = page.getByRole('button', { name: 'Back' });
    const forward = page.getByRole('button', { name: 'Forward' });
    const path = page.getByTestId('path');
    await expect.element(path).toHaveTextContent('/channel/a');
    await expect.element(forward).toBeDisabled();

    await page.getByRole('link', { name: 'to b' }).click();
    await expect.element(path).toHaveTextContent('/channel/b');
    await expect.element(back).toBeEnabled();
    await expect.element(forward).toBeDisabled();

    await back.click();
    await expect.element(path).toHaveTextContent('/channel/a');
    await expect.element(forward).toBeEnabled();

    await forward.click();
    await expect.element(path).toHaveTextContent('/channel/b');
    await expect.element(forward).toBeDisabled();
  });

  // A notification click pushes its page itself, outside the router.
  it('go back from a page a notification opened', async () => {
    if (!isDesktopProject) return;
    await renderLayout();
    const path = page.getByTestId('path');
    window.history.pushState(null, '', '/channel/c');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await expect.element(path).toHaveTextContent('/channel/c');
    await expect.element(page.getByRole('button', { name: 'Forward' })).toBeDisabled();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect.element(path).toHaveTextContent('/channel/a');
    await expect.element(page.getByRole('button', { name: 'Forward' })).toBeEnabled();
  });

  it('sit beside the sidebar, with the search centred in the bar', async () => {
    if (!isDesktopProject) return;
    await renderLayout();
    await expect.element(page.getByRole('button', { name: 'Back' })).toBeVisible();
    const sidebar = rect('[data-testid="app-sidebar"]');
    const bar = rect('[data-testid="app-shell-header"]');
    const back = rect('[data-testid="history-back"]');
    const forward = rect('[data-testid="history-forward"]');
    const search = rect('input[aria-label="Search"]');
    expect(back.left - sidebar.right).toBeGreaterThanOrEqual(0);
    expect(back.left - sidebar.right).toBeLessThanOrEqual(12);
    expect(forward.left).toBeGreaterThan(back.right);
    expect(Math.abs(centre(search) - centre(bar))).toBeLessThanOrEqual(1);
    // The search keeps its full width when there is room for it.
    expect(search.width).toBe(576);
  });

  // The narrowest full-tier bar: a 1024px window with the widest sidebar.
  it('keep the search centred and clear of them in the narrowest bar', async () => {
    if (!isDesktopProject) return;
    localStorage.setItem(SIDEBAR_WIDTH.key, String(SIDEBAR_WIDTH.max));
    await page.viewport(1024, 800);
    await expect.poll(() => window.innerWidth, { timeout: 5_000 }).toBe(1024);
    await renderLayout();
    await expect.element(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await expect.poll(() => rect('[data-testid="app-sidebar"]').width).toBe(SIDEBAR_WIDTH.max);
    const bar = rect('[data-testid="app-shell-header"]');
    const forward = rect('[data-testid="history-forward"]');
    const search = rect('input[aria-label="Search"]');
    expect(Math.abs(centre(search) - centre(bar))).toBeLessThanOrEqual(1);
    expect(search.left).toBeGreaterThan(forward.right);
  });

  // The traffic lights sit over the sidebar on this tier, not over the bar.
  it('stay beside the sidebar in the macOS app', async () => {
    if (!isDesktopProject) return;
    document.documentElement.classList.add('electron-mac');
    await renderLayout();
    await expect.element(page.getByRole('button', { name: 'Back' })).toBeVisible();
    const sidebar = rect('[data-testid="app-sidebar"]');
    const bar = rect('[data-testid="app-shell-header"]');
    const search = rect('input[aria-label="Search"]');
    expect(rect('[data-testid="history-back"]').left - sidebar.right).toBeLessThanOrEqual(12);
    expect(Math.abs(centre(search) - centre(bar))).toBeLessThanOrEqual(1);
  });

  it('are not on a phone', async () => {
    if (isDesktopProject) return;
    await renderLayout();
    await expect.element(page.getByTestId('path')).toHaveTextContent('/channel/a');
    expect(document.querySelector('[data-testid="history-back"]')).toBeNull();
    expect(document.querySelector('[data-testid="history-forward"]')).toBeNull();
  });
});
