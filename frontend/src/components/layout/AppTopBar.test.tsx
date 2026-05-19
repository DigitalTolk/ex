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

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { ...baseUser, systemRole: mockSystemRole }, logout }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false }),
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

vi.mock('@/components/EmojiManagerDialog', () => ({
  EmojiManagerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="emoji-manager-open" /> : null,
}));

vi.mock('@/lib/capacitor', () => ({
  getCapacitorPlugin: () => null,
  isNativePlatform: () => false,
}));

function renderTopBar(ui?: ReactNode) {
  return render(<MemoryRouter>{ui ?? <AppTopBar />}</MemoryRouter>);
}

describe('AppTopBar', () => {
  beforeEach(() => {
    mockSystemRole = 'admin';
    logout.mockClear();
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
    expect(screen.getByTestId('user-menu-invite')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
    // Theme switcher lives inside EditProfileDialog, not the dropdown.
    expect(screen.queryByTestId('user-menu-theme')).not.toBeInTheDocument();
  });

  it('hides admin-only items for non-admin users', () => {
    mockSystemRole = 'member';
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    expect(screen.queryByTestId('user-menu-admin')).not.toBeInTheDocument();
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

  it('marks the channels button hidden when channelsButtonHidden is true', () => {
    renderTopBar(<AppTopBar channelsButtonHidden />);
    const btn = screen.getByLabelText('Open channels');
    expect(btn).toHaveClass('invisible');
    expect(btn).toHaveAttribute('aria-hidden', 'true');
    expect(btn).toHaveAttribute('tabIndex', '-1');
  });
});
