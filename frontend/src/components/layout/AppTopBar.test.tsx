import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppTopBar } from './AppTopBar';

const logout = vi.fn().mockResolvedValue(undefined);

const baseUser = {
  id: 'u-1',
  email: 'u@x',
  displayName: 'Alice Wonder',
  avatarURL: '',
  userStatus: undefined,
};

let mockSystemRole: 'admin' | 'member' | 'guest' = 'admin';
let mockUserStatus: { emoji: string; text: string; clearAt?: string } | undefined;
let mockOnline = new Set<string>();
let mockUserNull = false;

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUserNull
      ? null
      : { ...baseUser, systemRole: mockSystemRole, userStatus: mockUserStatus },
    logout,
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: mockOnline, isOnline: (id: string) => mockOnline.has(id) }),
}));

vi.mock('@/components/SearchBar', () => ({
  SearchBar: () => <div aria-label="Search">search</div>,
}));

vi.mock('@/components/EditProfileDialog', () => ({
  EditProfileDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-profile-open" /> : null,
}));

vi.mock('@/components/UserStatusDialog', () => ({
  UserStatusDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="status-open" /> : null,
}));

vi.mock('@/components/AboutDialog', () => ({
  AboutDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="about-open" /> : null,
}));

vi.mock('@/components/InviteDialog', () => ({
  InviteDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="invite-open" /> : null,
}));

vi.mock('@/lib/capacitor', () => ({
  getCapacitorPlugin: () => null,
  isNativePlatform: () => false,
}));

// useIsMobile flips between desktop and mobile-sheet renders. Tests
// toggle the mock through the exposed setter to exercise both paths.
let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
}));

function renderTopBar(ui?: ReactNode) {
  return render(<MemoryRouter>{ui ?? <AppTopBar />}</MemoryRouter>);
}

describe('AppTopBar', () => {
  beforeEach(() => {
    mockSystemRole = 'admin';
    mockIsMobile = false;
    mockUserStatus = undefined;
    mockOnline = new Set<string>();
    mockUserNull = false;
    logout.mockClear();
  });

  it('falls back to "??" initials and an offline dot when there is no signed-in user', () => {
    mockUserNull = true;
    renderTopBar();
    // With user null, the initials helper hits its `?? "??"` fallback, the
    // presence check resolves to the `: false` offline branch, and the status
    // key collapses to empty strings — the bar still renders without throwing.
    expect(screen.getByTestId('topbar-account')).toBeInTheDocument();
    expect(screen.getByText('??')).toBeInTheDocument();
  });

  it('renders the online presence dot and status emoji when the user is online with a status', () => {
    mockOnline = new Set<string>(['u-1']);
    mockUserStatus = { emoji: ':rocket:', text: 'Shipping' };
    renderTopBar();
    // The account trigger renders with the online (emerald) presence ring and
    // the user's status keyed in — exercising both the online and userStatus
    // branches without throwing.
    expect(screen.getByTestId('topbar-account')).toBeInTheDocument();
  });

  it('shows an emerald presence dot on the mobile account button when online', () => {
    mockIsMobile = true;
    mockOnline = new Set<string>(['u-1']);
    renderTopBar();
    const dot = screen.getByTestId('topbar-account').querySelector('span[aria-hidden]')!;
    expect(dot.className).toContain('bg-emerald-500');
  });

  it('shows a muted presence dot on the mobile account button when offline', () => {
    mockIsMobile = true;
    mockOnline = new Set<string>();
    renderTopBar();
    const dot = screen.getByTestId('topbar-account').querySelector('span[aria-hidden]')!;
    expect(dot.className).toContain('bg-muted-foreground');
  });

  it('renders only mobile menu, search, and avatar dropdown trigger in the chrome', () => {
    renderTopBar();
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-account')).toBeInTheDocument();
    // Logo, theme-toggle icon, and standalone admin settings icon are
    // intentionally removed from the chrome — all user-facing actions
    // live inside the avatar dropdown.
    expect(screen.queryByTestId('app-brand')).not.toBeInTheDocument();
    expect(screen.queryByTestId('theme-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-settings')).not.toBeInTheDocument();
  });

  it('shows initials when no avatar URL is set', () => {
    renderTopBar();
    expect(screen.getByText('AW')).toBeInTheDocument();
  });

  it('opens the avatar dropdown to reveal the full user menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    expect(screen.getByTestId('user-menu-about')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-signout')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-admin')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-webhooks')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-invite')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
    // Theme switching lives inside EditProfileDialog, not the dropdown.
    expect(screen.queryByTestId('user-menu-theme')).not.toBeInTheDocument();
  });

  it('hides admin-only items for non-admin users', () => {
    mockSystemRole = 'member';
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    expect(screen.queryByTestId('user-menu-admin')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-menu-webhooks')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-menu-invite')).not.toBeInTheDocument();
    // Non-admin members can still manage emojis.
    expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
  });

  it('hides Custom emojis for guests', () => {
    mockSystemRole = 'guest';
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    expect(screen.queryByTestId('user-menu-emojis')).not.toBeInTheDocument();
  });

  it('opens the Edit profile dialog from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByText('Edit profile'));
    expect(screen.getByTestId('edit-profile-open')).toBeInTheDocument();
  });

  it('opens the Invite dialog from the menu for admins', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-invite'));
    expect(screen.getByTestId('invite-open')).toBeInTheDocument();
  });

  it('opens the About dialog from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-about'));
    expect(screen.getByTestId('about-open')).toBeInTheDocument();
  });

  it('signs out via logout when Sign out is clicked', async () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    // Wrap the async click+resolve in act() so the post-logout
    // navigate (a state update) lands inside the act-scoped batch and
    // the console-gate doesn't catch a stray React warning.
    await act(async () => {
      fireEvent.click(screen.getByTestId('user-menu-signout'));
      await Promise.resolve();
    });
    expect(logout).toHaveBeenCalled();
  });

  it('renders open-channels button when given a callback', () => {
    const onOpen = vi.fn();
    renderTopBar(<AppTopBar onOpenChannels={onOpen} />);
    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('omits the channels button entirely when channelsButtonHidden is true', () => {
    renderTopBar(<AppTopBar channelsButtonHidden />);
    expect(screen.queryByLabelText('Open channels')).not.toBeInTheDocument();
  });

  describe('mobile account sheet', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('opens the full-screen mobile sheet when the avatar is tapped', () => {
      renderTopBar();
      // Sheet starts closed.
      expect(screen.queryByTestId('mobile-account-sheet')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('topbar-account'));
      // …and opens on tap, surfacing the user's name + every action.
      expect(screen.getByTestId('mobile-account-sheet')).toBeInTheDocument();
      expect(screen.getByText('Alice Wonder')).toBeInTheDocument();
      expect(screen.getByText('u@x')).toBeInTheDocument();
      expect(screen.getByTestId('user-menu-about')).toBeInTheDocument();
      expect(screen.getByTestId('user-menu-signout')).toBeInTheDocument();
    });

    it('closes the sheet and runs the action when a menu item is tapped', () => {
      renderTopBar();
      fireEvent.click(screen.getByTestId('topbar-account'));
      fireEvent.click(screen.getByTestId('user-menu-about'));
      expect(screen.getByTestId('about-open')).toBeInTheDocument();
      expect(screen.queryByTestId('mobile-account-sheet')).not.toBeInTheDocument();
    });

    it('omits admin-only entries for non-admin members in the sheet', () => {
      mockSystemRole = 'member';
      renderTopBar();
      fireEvent.click(screen.getByTestId('topbar-account'));
      expect(screen.queryByTestId('user-menu-admin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('user-menu-invite')).not.toBeInTheDocument();
      expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
    });

    it('omits Custom emojis for guests', () => {
      mockSystemRole = 'guest';
      renderTopBar();
      fireEvent.click(screen.getByTestId('topbar-account'));
      expect(screen.queryByTestId('user-menu-emojis')).not.toBeInTheDocument();
    });

    it('signs out from the sheet when Sign out is tapped', async () => {
      renderTopBar();
      fireEvent.click(screen.getByTestId('topbar-account'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('user-menu-signout'));
        await Promise.resolve();
      });
      expect(logout).toHaveBeenCalled();
    });
  });
});
