import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AppTopBar } from './AppTopBar';

// Surfaces the active route so navigation actions can be asserted.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

const logout = vi.fn().mockResolvedValue(undefined);
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x', displayName: 'Alice', systemRole: 'admin', userStatus: undefined },
    logout,
  }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false }),
}));
vi.mock('@/components/SearchBar', () => ({ SearchBar: () => <div aria-label="Search" /> }));
vi.mock('@/components/EditProfileDialog', () => ({ EditProfileDialog: ({ open }: { open: boolean }) => open ? <div data-testid="edit-profile-open" /> : null }));
vi.mock('@/components/NotificationSettingsDialog', () => ({ NotificationSettingsDialog: ({ open }: { open: boolean }) => open ? <div data-testid="notifications-open" /> : null }));
vi.mock('@/components/UserStatusDialog', () => ({ UserStatusDialog: ({ open }: { open: boolean }) => open ? <div data-testid="status-open" /> : null }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: ({ open }: { open: boolean }) => open ? <div data-testid="about-open" /> : null }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: ({ open }: { open: boolean }) => open ? <div data-testid="invite-open" /> : null }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

let mockNative = false;
const resetServer = vi.fn();
// The real UserStatusIndicator renders when the mocked user has a status;
// its emoji-map hook is react-query-backed, so stub it (no provider here).
vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/lib/capacitor', () => ({
  isNativePlatform: () => mockNative,
  getCapacitorPlugin: (name: string) => (name === 'ServerNavigation' && mockNative ? { resetServer } : null),
}));

function renderTopBar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AppTopBar />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppTopBar menu actions', () => {
  beforeEach(() => {
    mockNative = false;
    logout.mockClear();
    resetServer.mockClear();
  });

  it('opens the status dialog from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByText('Set status'));
    expect(screen.getByTestId('status-open')).toBeInTheDocument();
  });

  it('opens the notification settings dialog from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-notifications'));
    expect(screen.getByTestId('notifications-open')).toBeInTheDocument();
  });

  it('navigates to the custom emoji page from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-emojis'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/emojis');
  });

  it('triggers admin navigation from the menu without crashing', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    expect(() => fireEvent.click(screen.getByTestId('user-menu-admin'))).not.toThrow();
  });

  it('navigates to the incoming-webhooks page from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-webhooks'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/webhooks');
  });

  it('navigates to the bots page from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-bots'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/bots');
  });

  it('shows the change-server item on native and resets the server on confirm', () => {
    mockNative = true;
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-change-server'));
    // ConfirmDialog (real) renders with confirmLabel "Change server".
    fireEvent.click(screen.getByRole('button', { name: 'Change server' }));
    expect(resetServer).toHaveBeenCalled();
  });
});
