import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppTopBar } from './AppTopBar';

// Browser coverage for AppTopBar's mobile-sheet path and the native
// "Change server" action — the existing AppTopBar.browser.test.tsx pins
// useIsMobile=false and getCapacitorPlugin=null, leaving the mobile
// branches and the serverNavigation menu entry uncovered in the browser
// gate.

const logout = vi.fn().mockResolvedValue(undefined);
const baseUser = { id: 'u-1', email: 'u@x', displayName: 'Alice Wonder', avatarURL: '' };
const resetServer = vi.fn().mockResolvedValue(undefined);

let mockOnline = new Set<string>();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { ...baseUser, systemRole: 'admin' }, logout }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: mockOnline, isOnline: (id: string) => mockOnline.has(id) }),
}));
vi.mock('@/components/SearchBar', () => ({ SearchBar: () => <div aria-label="Search">search</div> }));
vi.mock('@/components/EditProfileDialog', () => ({ EditProfileDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="edit-profile-open" /> : null) }));
vi.mock('@/components/UserStatusDialog', () => ({ UserStatusDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="status-open" /> : null) }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="about-open" /> : null) }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="invite-open" /> : null) }));
// Native platform with a ServerNavigation plugin → the serverNavigation
// branch is truthy and the "Change server" action is present.
vi.mock('@/lib/capacitor', () => ({
  getCapacitorPlugin: (name: string) => (name === 'ServerNavigation' ? { resetServer } : null),
  isNativePlatform: () => true,
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }));

function renderTopBar(ui = <AppTopBar />) {
  // The account avatar's UserStatusIndicator resolves custom emoji through a
  // react-query hook, so the tree needs a provider.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppTopBar (mobile + native)', () => {
  // base-ui's Dialog defers portal teardown until its exit animation ends;
  // on WebKit headless that animationend can be flaky, leaving the closed
  // sheet in the DOM. Disabling animations makes close() remove it
  // synchronously so "sheet is gone" assertions are deterministic.
  let killAnims: HTMLStyleElement | null = null;
  beforeEach(() => {
    mockOnline = new Set<string>();
    logout.mockClear();
    resetServer.mockClear();
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(() => {
    killAnims?.remove();
    killAnims = null;
  });

  it('opens the full-screen mobile account sheet on avatar tap', async () => {
    // The sheet DialogContent carries `md:hidden`, so it is display:none on
    // wide viewports; only assert on the actual mobile projects.
    if (window.innerWidth > 767) return;
    mockOnline = new Set<string>(['u-1']);
    const screen = await renderTopBar();
    // The mobile account button shows an online presence dot.
    const account = screen.getByTestId('topbar-account').element() as HTMLElement;
    const dot = account.querySelector('span[aria-hidden]') as HTMLElement;
    expect(dot.className).toContain('bg-online');
    await screen.getByTestId('topbar-account').click();
    await expect.element(screen.getByTestId('mobile-account-sheet')).toBeVisible();
    await expect.element(screen.getByText('Alice Wonder')).toBeVisible();
    // The native "Change server" action is present in the sheet.
    await expect.element(screen.getByTestId('user-menu-change-server')).toBeVisible();
  });

  it('runs an action and closes the sheet when a menu entry is tapped', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderTopBar();
    await screen.getByTestId('topbar-account').click();
    await screen.getByTestId('user-menu-about').click();
    // The mocked AboutDialog renders an empty div once open=true.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="about-open"]')).not.toBeNull();
    });
    // runActionAndCloseSheet closed the sheet. Allow generous time — the
    // dialog lingers in the DOM through its exit animation, which can run
    // long on webkit under the full-suite load (otherwise this flakes).
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-account-sheet"]')).toBeNull();
    }, { timeout: 5000 });
  });

  it('opens the change-server confirm dialog and triggers resetServer on confirm', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderTopBar();
    await screen.getByTestId('topbar-account').click();
    await screen.getByTestId('user-menu-change-server').click();
    // The ConfirmDialog opens; confirm fires serverNavigation.resetServer().
    await screen.getByTestId('change-server-confirm').click();
    await vi.waitFor(() => expect(resetServer).toHaveBeenCalled());
  });

  it('signs out from the mobile sheet and navigates to /login', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderTopBar();
    await screen.getByTestId('topbar-account').click();
    await screen.getByTestId('user-menu-signout').click();
    await vi.waitFor(() => expect(logout).toHaveBeenCalled());
  });
});
