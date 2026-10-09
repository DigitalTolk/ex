import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AccountMenu } from './AccountMenu';

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

vi.mock('@/components/settings/SettingsDialog', () => ({
  SettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="settings-open" /> : null,
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

// The real UserStatusIndicator renders in these tests; its emoji map hook
// is react-query-backed, so stub it to an empty custom-emoji map.
vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

function renderMenu(ui?: ReactNode) {
  return render(<MemoryRouter>{ui ?? <AccountMenu />}</MemoryRouter>);
}

describe('AccountMenu', () => {
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
    renderMenu();
    // With user null, the initials helper hits its `?? "??"` fallback, the
    // presence check resolves to the `: false` offline branch, and the status
    // key collapses to empty strings — the bar still renders without throwing.
    expect(screen.getByTestId('account-menu-trigger')).toBeInTheDocument();
    expect(screen.getByText('??')).toBeInTheDocument();
  });

  it('renders the online presence dot and status emoji when the user is online with a status', () => {
    mockOnline = new Set<string>(['u-1']);
    mockUserStatus = { emoji: ':rocket:', text: 'Shipping' };
    renderMenu();
    // The account trigger renders with the online presence ring and
    // the user's status keyed in — exercising both the online and userStatus
    // branches without throwing.
    expect(screen.getByTestId('account-menu-trigger')).toBeInTheDocument();
  });

  it('shows a FILLED online dot on the mobile account button when online', () => {
    mockIsMobile = true;
    mockOnline = new Set<string>(['u-1']);
    renderMenu();
    const dot = screen.getByTestId('account-menu-trigger').querySelector('[data-presence]')!;
    expect(dot.getAttribute('data-presence')).toBe('online');
    expect(dot.className).toContain('bg-online');
    // Filled, not hollow: shape encodes the state for color-blind users.
    expect(dot.className).not.toContain('border-solid');
  });

  it('shows a HOLLOW ring on the mobile account button when offline', () => {
    mockIsMobile = true;
    mockOnline = new Set<string>();
    renderMenu();
    const dot = screen.getByTestId('account-menu-trigger').querySelector('[data-presence]')!;
    expect(dot.getAttribute('data-presence')).toBe('offline');
    // Hollow ring (border only, transparent center) — the colour-blind-safe
    // offline shape; the old solid muted dot differed from online by hue alone.
    expect(dot.className).toContain('border-solid');
    expect(dot.className).toContain('border-muted-foreground');
    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).not.toContain('bg-online');
  });


  it('shows initials when no avatar URL is set', () => {
    renderMenu();
    expect(screen.getByText('AW')).toBeInTheDocument();
  });

  it('opens the avatar dropdown to reveal the full user menu', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    expect(screen.getByTestId('user-menu-about')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-signout')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-admin')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-webhooks')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-invite')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
    // Theme switching lives in Settings → Appearance, not the dropdown.
    expect(screen.queryByTestId('user-menu-theme')).not.toBeInTheDocument();
  });

  it('hides admin-only items for non-admin users', () => {
    mockSystemRole = 'member';
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    expect(screen.queryByTestId('user-menu-admin')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-menu-webhooks')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-menu-invite')).not.toBeInTheDocument();
    // Non-admin members can still manage emojis.
    expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
  });

  it('hides Custom emojis for guests', () => {
    mockSystemRole = 'guest';
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    expect(screen.queryByTestId('user-menu-emojis')).not.toBeInTheDocument();
  });

  it('opens Settings from the menu', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    fireEvent.click(screen.getByText('Settings'));
    expect(screen.getByTestId('settings-open')).toBeInTheDocument();
  });

  it('opens the Invite dialog from the menu for admins', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    fireEvent.click(screen.getByTestId('user-menu-invite'));
    expect(screen.getByTestId('invite-open')).toBeInTheDocument();
  });

  it('opens the About dialog from the menu', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    fireEvent.click(screen.getByTestId('user-menu-about'));
    expect(screen.getByTestId('about-open')).toBeInTheDocument();
  });

  it('signs out via logout when Sign out is clicked', async () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    // Wrap the async click+resolve in act() so the post-logout
    // navigate (a state update) lands inside the act-scoped batch and
    // the console-gate doesn't catch a stray React warning.
    await act(async () => {
      fireEvent.click(screen.getByTestId('user-menu-signout'));
      await Promise.resolve();
    });
    expect(logout).toHaveBeenCalled();
  });

  describe('as the tab bar\'s You tab', () => {
    it('renders a You tab instead of the footer and opens the sheet, highlighted while open', () => {
      mockIsMobile = true;
      mockOnline = new Set<string>(['u-1']);
      renderMenu(<AccountMenu variant="tab" />);
      expect(screen.queryByTestId('sidebar-account')).not.toBeInTheDocument();
      const tab = screen.getByTestId('mobile-tab-you');
      expect(tab).toHaveClass('text-muted-foreground');
      fireEvent.click(tab);
      expect(screen.getByTestId('mobile-account-sheet')).toBeInTheDocument();
      expect(tab).toHaveClass('text-sidebar-foreground');
    });

    it('falls back to "??" with no signed-in user', () => {
      mockIsMobile = true;
      mockUserNull = true;
      renderMenu(<AccountMenu variant="tab" />);
      expect(within(screen.getByTestId('mobile-tab-you')).getByText('??')).toBeInTheDocument();
    });
  });

  describe('mobile account sheet', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('opens the full-screen mobile sheet when the avatar is tapped', () => {
      renderMenu();
      // Sheet starts closed.
      expect(screen.queryByTestId('mobile-account-sheet')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      // …and opens on tap, surfacing the user's name + every action.
      expect(screen.getByTestId('mobile-account-sheet')).toBeInTheDocument();
      expect(within(screen.getByTestId('mobile-account-sheet')).getByText('Alice Wonder')).toBeInTheDocument();
      expect(screen.getByText('u@x')).toBeInTheDocument();
      expect(screen.getByTestId('user-menu-about')).toBeInTheDocument();
      expect(screen.getByTestId('user-menu-signout')).toBeInTheDocument();
    });

    it('opens a dialog over the sheet, so closing it lands back on the sheet', () => {
      renderMenu();
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      fireEvent.click(screen.getByTestId('user-menu-about'));
      expect(screen.getByTestId('about-open')).toBeInTheDocument();
      expect(screen.getByTestId('mobile-account-sheet')).toBeInTheDocument();
    });

    it('closes the sheet when a menu item leaves it (navigation)', () => {
      renderMenu();
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      fireEvent.click(screen.getByTestId('user-menu-admin'));
      expect(screen.queryByTestId('mobile-account-sheet')).not.toBeInTheDocument();
    });

    it('omits admin-only entries for non-admin members in the sheet', () => {
      mockSystemRole = 'member';
      renderMenu();
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      expect(screen.queryByTestId('user-menu-admin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('user-menu-invite')).not.toBeInTheDocument();
      expect(screen.getByTestId('user-menu-emojis')).toBeInTheDocument();
    });

    it('omits Custom emojis for guests', () => {
      mockSystemRole = 'guest';
      renderMenu();
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      expect(screen.queryByTestId('user-menu-emojis')).not.toBeInTheDocument();
    });

    it('signs out from the sheet when Sign out is tapped', async () => {
      renderMenu();
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('user-menu-signout'));
        await Promise.resolve();
      });
      expect(logout).toHaveBeenCalled();
    });
  });
});

describe('AccountMenu own custom status', () => {
  beforeEach(() => {
    mockIsMobile = false;
    mockUserStatus = undefined;
  });

  it('shows the active custom status emoji right after the name (not on the avatar)', () => {
    mockUserStatus = { emoji: '🌴', text: 'On vacation' };
    renderMenu();
    const trigger = screen.getByTestId('account-menu-trigger');
    const badge = within(trigger).getByLabelText("On vacation, won't clear automatically");
    // Sits beside the name, not overlaid on the avatar (which only carries the presence dot).
    expect(badge.previousElementSibling?.textContent).toBe('Alice Wonder');
    expect(trigger.querySelector('[data-presence]')).not.toBeNull();
  });

  it('renders no status badge when the user has none', () => {
    renderMenu();
    expect(screen.queryByLabelText(/won't clear automatically|until /)).toBeNull();
  });

  it('shows the status on the mobile account button and inside the opened account sheet', () => {
    mockIsMobile = true;
    mockUserStatus = { emoji: '🌴', text: 'On vacation' };
    renderMenu();
    expect(within(screen.getByTestId('account-menu-trigger')).getByLabelText("On vacation, won't clear automatically")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    // The sheet header shows it next to the display name too.
    // …in the profile card and in the status row.
    expect(within(screen.getByTestId('mobile-account-sheet')).getAllByLabelText("On vacation, won't clear automatically")).toHaveLength(2);
  });
});
