import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { apiFetch } from '@/lib/api';
import { AccountMenu } from './AccountMenu';

// The account menu's status row: while a custom status is active it sits at
// the top of the menu (desktop dropdown and mobile sheet) — click to edit,
// ✕ to clear in place — and replaces the "Set status" entry.

const tokenRef = vi.hoisted(() => ({ value: 'token' as string | null }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => tokenRef.value,
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

const setAuth = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  status: undefined as { emoji: string; text: string; clearAt?: string } | undefined,
  mobile: false,
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'u@x', displayName: 'Alice Wonder', systemRole: 'member', userStatus: state.status },
    logout: vi.fn(),
    setAuth,
  }),
}));
vi.mock('@/context/PresenceContext', () => ({ usePresence: () => ({ online: new Set<string>() }) }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/lib/capacitor', () => ({ getCapacitorPlugin: () => null, isNativePlatform: () => false }));
vi.mock('@/components/settings/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/emoji/CustomEmojiDialog', () => ({ CustomEmojiDialog: () => null }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: () => null }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: () => null }));
vi.mock('@/components/UserStatusDialog', () => ({
  UserStatusDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="status-open" /> : null),
}));

function renderMenu() {
  return render(
    <MemoryRouter>
      <AccountMenu />
    </MemoryRouter>,
  );
}

function deleteCalls() {
  return vi.mocked(apiFetch).mock.calls.filter(
    (c: unknown[]) => c[0] === '/api/v1/users/me/status' && (c[1] as RequestInit).method === 'DELETE',
  );
}

const MEETING = { emoji: '📅', text: 'In a meeting' };

describe('AccountMenu status row', () => {
  beforeEach(() => {
    state.status = undefined;
    state.mobile = false;
    tokenRef.value = 'token';
    setAuth.mockClear();
    showToast.mockClear();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ id: 'u-1', userStatus: undefined } as never);
  });
  afterEach(() => cleanup());

  it('shows "Set status" (and no status row) while no status is set', async () => {
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    await expect.element(screen.getByTestId('user-menu-set-status')).toBeVisible();
    expect(document.querySelector('[data-testid="user-menu-status-row"]')).toBeNull();
  });

  it('hovering the status emoji next to the name shows the status card', async () => {
    state.status = { ...MEETING };
    const screen = await renderMenu();
    await userEvent.hover(screen.getByTestId('account-menu-trigger').getByLabelText(/In a meeting/));
    await vi.waitFor(() => {
      const card = document.querySelector('[data-slot="tooltip-content"]');
      expect(card?.textContent).toContain('In a meeting');
      expect(card?.textContent).toMatch(/won't clear automatically/);
    });
  });

  it('puts the active status at the top of the menu with its clear time, replacing "Set status"', async () => {
    const clearAt = new Date();
    clearAt.setHours(23, 30, 0, 0);
    state.status = { ...MEETING, clearAt: clearAt.toISOString() };
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    const row = screen.getByTestId('user-menu-status');
    await expect.element(row).toMatchTextContent(/In a meeting/);
    await expect.element(row).toMatchTextContent(/Until \d{1,2}:30/);
    expect(document.querySelector('[data-testid="user-menu-set-status"]')).toBeNull();
  });

  it('clicking the status text opens the status dialog', async () => {
    state.status = { ...MEETING };
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    await screen.getByTestId('user-menu-status').click();
    await expect.element(screen.getByTestId('status-open')).toBeInTheDocument();
  });

  it('the ✕ clears the status in place without opening the dialog', async () => {
    state.status = { ...MEETING };
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    await screen.getByRole('menuitem', { name: 'Clear status' }).click();
    await vi.waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(JSON.parse(String((deleteCalls()[0][1] as RequestInit).body))).toHaveProperty('timeZone');
    await vi.waitFor(() => expect(setAuth).toHaveBeenCalledWith('token', expect.objectContaining({ id: 'u-1' })));
    expect(document.querySelector('[data-testid="status-open"]')).toBeNull();
  });

  it('skips setAuth when there is no access token', async () => {
    state.status = { ...MEETING };
    tokenRef.value = null;
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    await screen.getByTestId('user-menu-clear-status').click();
    await vi.waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(setAuth).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('offline'), 'offline'],
    ['weird', 'Failed to clear status'],
  ])('reports a failed clear (%s)', async (rejection, message) => {
    state.status = { ...MEETING };
    vi.mocked(apiFetch).mockRejectedValueOnce(rejection);
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    await screen.getByTestId('user-menu-clear-status').click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 'error'));
    expect(setAuth).not.toHaveBeenCalled();
  });

  it('mobile: the sheet shows the status row — tap to edit, ✕ to clear', async () => {
    // The sheet is phone-only chrome (hidden at desktop widths).
    if (window.innerWidth > 767) return;
    state.mobile = true;
    state.status = { ...MEETING };
    const screen = await renderMenu();
    await screen.getByTestId('account-menu-trigger').click();
    await expect.element(screen.getByTestId('mobile-status')).toMatchTextContent(/In a meeting.*Doesn.t clear/);
    expect(document.querySelector('[data-testid="mobile-account-sheet"] [data-testid="user-menu-set-status"]')).toBeNull();
    await screen.getByTestId('mobile-clear-status').click();
    await vi.waitFor(() => expect(deleteCalls()).toHaveLength(1));
    await screen.getByTestId('mobile-status').click();
    await expect.element(screen.getByTestId('status-open')).toBeInTheDocument();
  });
});
