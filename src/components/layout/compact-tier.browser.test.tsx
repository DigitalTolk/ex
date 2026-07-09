import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

// Pixel tests for the compact tier: a REAL 700px-wide desktop window (the
// Slack-next-to-ex case) must keep desktop chrome — working sidebar toggle,
// centered dialogs, desktop-sized controls — and the Electron-on-macOS
// traffic-light inset must clear the sidebar toggle.

vi.mock('./Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose: () => void }) => (
    <nav data-testid="sidebar-body">
      <button type="button" data-testid="sidebar-nav-item" onClick={onClose}>
        general
      </button>
    </nav>
  ),
}));
// w-full mirrors the real SearchBar root so geometry assertions measure the
// field the user actually sees filling the centre grid column.
vi.mock('@/components/SearchBar', () => ({ SearchBar: () => <input aria-label="Search" className="w-full" /> }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Tess', email: 't@x.io', systemRole: 2 },
    logout: vi.fn(),
  }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/hooks/useServerVersion', () => ({
  BUILD_DISPLAY_VERSION: 'browser-test',
  BUILD_VERSION: 'browser-test',
  setServerVersion: vi.fn(),
  resetServerVersionForTests: vi.fn(),
  useServerVersion: () => ({ outdated: false }),
}));

let active: { unmount: () => Promise<void> } | null = null;

const isDesktopProject = window.innerWidth >= 1024;

beforeEach(async () => {
  if (!isDesktopProject) return;
  await page.viewport(700, 800);
});

afterEach(async () => {
  if (active) await active.unmount();
  active = null;
  document.documentElement.classList.remove('electron-mac');
  if (isDesktopProject) await page.viewport(1280, 900);
});

async function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = await render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/general']}>
        <AppLayout>
          <div data-testid="page-main">main</div>
        </AppLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  active = result;
  return result;
}

describe('compact tier at a real 700px desktop viewport', () => {
  it('stamps the compact tier class and shows a WORKING sidebar toggle', async () => {
    if (!isDesktopProject) return;
    await renderLayout();
    expect(document.documentElement.classList.contains('tier-compact')).toBe(true);
    expect(document.documentElement.classList.contains('device-touch')).toBe(false);

    const toggle = document.querySelector('[aria-label="Open channels"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    // Visible and clickable (the pre-tier bug: visible but opened nothing).
    expect(toggle.getBoundingClientRect().width).toBeGreaterThan(0);
    toggle.click();

    await expect.poll(() => document.querySelector('[data-testid="compact-sidebar"]')).not.toBeNull();
    const rect = (document.querySelector('[data-testid="compact-sidebar"]') as HTMLElement).getBoundingClientRect();
    // Desktop-styled overlay panel: fixed 288px column pinned to the left,
    // NOT a full-width mobile sheet.
    expect(rect.width).toBe(288);
    expect(rect.left).toBe(0);
    expect(rect.width).toBeLessThan(window.innerWidth);

    // Backdrop click closes.
    (document.querySelector('[data-testid="compact-sidebar-backdrop"]') as HTMLElement).click();
    await expect.poll(() => document.querySelector('[data-testid="compact-sidebar"]')).toBeNull();

    // Reopen: unrelated keys keep it open, Escape dismisses.
    toggle.click();
    await expect.poll(() => document.querySelector('[data-testid="compact-sidebar"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.querySelector('[data-testid="compact-sidebar"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect.poll(() => document.querySelector('[data-testid="compact-sidebar"]')).toBeNull();

    // Reopen and close through the sidebar's own navigation callback.
    toggle.click();
    await expect.poll(() => document.querySelector('[data-testid="compact-sidebar"]')).not.toBeNull();
    (document.querySelector('[data-testid="compact-sidebar"] [data-testid="sidebar-nav-item"]') as HTMLElement).click();
    await expect.poll(() => document.querySelector('[data-testid="compact-sidebar"]')).toBeNull();

    // The persistent (lg+) aside wires a noop close — clicking its nav is
    // inert and resurrects nothing.
    (document.querySelector('[data-testid="app-sidebar"] [data-testid="sidebar-nav-item"]') as HTMLElement).click();
    expect(document.querySelector('[data-testid="compact-sidebar"]')).toBeNull();
  });

  it('keeps dialogs centered desktop windows, not full-screen sheets', async () => {
    if (!isDesktopProject) return;
    const result = await render(
      <ConfirmDialog
        open
        title="Delete message?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => undefined}
        onOpenChange={() => undefined}
      />,
    );
    active = result;
    const content = document.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement;
    expect(content).not.toBeNull();
    const rect = content.getBoundingClientRect();
    // The mobile: full-screen sheet must NOT apply on a desktop device at
    // 700px: the dialog floats (inset from every edge).
    expect(rect.top).toBeGreaterThan(8);
    expect(rect.width).toBeLessThan(window.innerWidth - 16);
    expect(rect.height).toBeLessThan(window.innerHeight - 16);
  });

  it('keeps desktop-sized controls (no touch inflation) at 700px', async () => {
    if (!isDesktopProject) return;
    const result = await render(
      <div>
        <Button size="sm">Act</Button>
        <Input placeholder="type" />
      </div>,
    );
    active = result;
    const btn = document.querySelector('button') as HTMLElement;
    // mobile:h-11 (44px) must not fire on a fine-pointer window; the sm
    // button keeps its 32px desktop height.
    expect(btn.getBoundingClientRect().height).toBeLessThanOrEqual(36);
    // Inputs keep the 14px design font and 32px height too — 16px is only
    // the iOS zoom guard on touch devices.
    const input = document.querySelector('input') as HTMLElement;
    expect(input.getBoundingClientRect().height).toBeLessThanOrEqual(36);
    expect(getComputedStyle(input).fontSize).toBe('14px');
  });

  it('centres the search field and docks the hamburger against its left edge, clear of the window corner', async () => {
    if (!isDesktopProject) return;
    await renderLayout();
    const toggle = document.querySelector('[aria-label="Open channels"]') as HTMLElement;
    const search = document.querySelector('input[aria-label="Search"]') as HTMLElement;
    const toggleRect = toggle.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    // The field is centred in the viewport (equal 1fr side columns) — the
    // regression was a compact `auto` first column that left it hugging the
    // hamburger at the window's left edge.
    const searchCentre = (searchRect.left + searchRect.right) / 2;
    expect(Math.abs(searchCentre - window.innerWidth / 2)).toBeLessThanOrEqual(1);
    // Capped well below the roomy full-desktop 36rem so the hamburger fits
    // in the side column to its LEFT.
    expect(searchRect.width).toBeLessThan(320);
    // The hamburger docks against the field (justify-end + the 8px grid
    // gap), NOT at the window's left edge — so a frameless window's traffic
    // lights can never cover it even when .electron-mac detection misses.
    const gapToSearch = searchRect.left - toggleRect.right;
    expect(gapToSearch).toBeGreaterThanOrEqual(0);
    expect(gapToSearch).toBeLessThanOrEqual(16);
    // Structurally clear of the traffic-light cluster (~80px) with no
    // electron-mac class applied at all.
    expect(toggleRect.left).toBeGreaterThanOrEqual(88);
  });

  it('insets the top-bar left column past macOS traffic lights while the search stays centred', async () => {
    if (!isDesktopProject) return;
    document.documentElement.classList.add('electron-mac');
    try {
      await renderLayout();
      const left = document.querySelector('[data-topbar-left="true"]') as HTMLElement;
      expect(left).not.toBeNull();
      // 5.5rem = 88px clears the hiddenInset traffic-light cluster with margin.
      expect(getComputedStyle(left).paddingLeft).toBe('88px');
      const toggle = document.querySelector('[aria-label="Open channels"]') as HTMLElement;
      const search = document.querySelector('input[aria-label="Search"]') as HTMLElement;
      const toggleRect = toggle.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      // The hamburger clears the traffic lights…
      expect(toggleRect.left).toBeGreaterThanOrEqual(88);
      // …stays docked against the search field's left edge…
      const gapToSearch = searchRect.left - toggleRect.right;
      expect(gapToSearch).toBeGreaterThanOrEqual(0);
      expect(gapToSearch).toBeLessThanOrEqual(16);
      // …and the field keeps its centred position (at 700px the padded side
      // column has room to spare, so the traffic-light inset must not shove
      // the field off-centre or bury the toggle).
      const searchCentre = (searchRect.left + searchRect.right) / 2;
      expect(Math.abs(searchCentre - window.innerWidth / 2)).toBeLessThanOrEqual(1);
      expect(searchRect.width).toBeLessThan(320);
    } finally {
      document.documentElement.classList.remove('electron-mac');
    }
  });
});

describe('mobile tier is untouched (mobile projects)', () => {
  it('a touch viewport still stamps tier-mobile and keeps the drawer', async () => {
    if (isDesktopProject) return;
    await renderLayout();
    expect(document.documentElement.classList.contains('tier-mobile')).toBe(true);
    expect(document.querySelector('[data-testid="mobile-channel-sidebar"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="compact-sidebar"]')).toBeNull();
  });
});
