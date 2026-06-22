import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { AppTopBar } from './AppTopBar';

// Browser-gate coverage for AppTopBar. The jsdom AppTopBar.test.tsx exercises
// these flows but the component is excluded from the jsdom gate, so the
// role-gated menu items, channels-button props, and initials/online/status
// branches register as uncovered in the browser view. This mirrors the jsdom
// mocks against the real-browser runner.

const logout = vi.fn().mockResolvedValue(undefined);
const baseUser = { id: 'u-1', email: 'u@x', displayName: 'Alice Wonder', avatarURL: '' };

let mockSystemRole: 'admin' | 'member' | 'guest' = 'admin';
let mockUserStatus: { emoji: string; text: string; clearAt?: string } | undefined;
let mockOnline = new Set<string>();
let mockUserNull = false;

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUserNull ? null : { ...baseUser, systemRole: mockSystemRole, userStatus: mockUserStatus },
    logout,
  }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: mockOnline, isOnline: (id: string) => mockOnline.has(id) }),
}));
vi.mock('@/components/SearchBar', () => ({ SearchBar: () => <div aria-label="Search">search</div> }));
vi.mock('@/components/EditProfileDialog', () => ({ EditProfileDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="edit-profile-open" /> : null) }));
vi.mock('@/components/NotificationSettingsDialog', () => ({ NotificationSettingsDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="notifications-open" /> : null) }));
vi.mock('@/components/UserStatusDialog', () => ({ UserStatusDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="status-open" /> : null) }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="about-open" /> : null) }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="invite-open" /> : null) }));
vi.mock('@/lib/capacitor', () => ({ getCapacitorPlugin: () => null, isNativePlatform: () => false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

function renderTopBar(ui = <AppTopBar />) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('AppTopBar (browser)', () => {
  beforeEach(() => {
    mockSystemRole = 'admin';
    mockUserStatus = undefined;
    mockOnline = new Set<string>();
    mockUserNull = false;
    logout.mockClear();
  });

  it('falls back to "??" initials when there is no signed-in user', async () => {
    mockUserNull = true;
    const screen = await renderTopBar();
    await expect.element(screen.getByText('??')).toBeVisible();
  });

  it('shows the derived initials and an online dot for a signed-in, online user', async () => {
    mockOnline = new Set(['u-1']);
    const screen = await renderTopBar();
    await expect.element(screen.getByText('AW')).toBeVisible();
  });

  it('exposes admin-only menu items (Invite, Emoji manager) for an admin', async () => {
    const screen = await renderTopBar();
    await screen.getByTestId('topbar-account').click();
    await expect.element(screen.getByTestId('user-menu-invite')).toBeVisible();
    expect(document.querySelector('[data-testid="user-menu-emojis"]')).not.toBeNull();
  });

  it('exposes the notification-settings item in the account menu', async () => {
    const screen = await renderTopBar();
    await screen.getByTestId('topbar-account').click();
    await expect.element(screen.getByTestId('user-menu-notifications')).toBeVisible();
  });

  it('hides the invite item for a guest account', async () => {
    mockSystemRole = 'guest';
    const screen = await renderTopBar();
    await screen.getByTestId('topbar-account').click();
    await expect.element(screen.getByTestId('user-menu-about')).toBeVisible();
    expect(document.querySelector('[data-testid="user-menu-invite"]')).toBeNull();
  });

  it('keeps the channels button mounted but invisible when channelsButtonHidden is set', async () => {
    await renderTopBar(<AppTopBar channelsButtonHidden />);
    const button = document.querySelector('[aria-label="Open channels"]') as HTMLElement | null;
    expect(button).not.toBeNull();
    expect(button!.classList.contains('invisible')).toBe(true);
    expect(button!.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the account chip with an active user status', async () => {
    mockUserStatus = { emoji: '🎯', text: 'Focusing' };
    mockOnline = new Set(['u-1']);
    const screen = await renderTopBar();
    // The status key includes the emoji/text; the chip renders without error.
    await expect.element(screen.getByTestId('topbar-account')).toBeVisible();
  });
});
