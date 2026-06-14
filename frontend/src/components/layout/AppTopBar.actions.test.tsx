import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppTopBar } from './AppTopBar';

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
vi.mock('@/components/UserStatusDialog', () => ({ UserStatusDialog: ({ open }: { open: boolean }) => open ? <div data-testid="status-open" /> : null }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: ({ open }: { open: boolean }) => open ? <div data-testid="about-open" /> : null }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: ({ open }: { open: boolean }) => open ? <div data-testid="invite-open" /> : null }));
vi.mock('@/components/EmojiManagerDialog', () => ({ EmojiManagerDialog: ({ open }: { open: boolean }) => open ? <div data-testid="emoji-manager-open" /> : null }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

let mockNative = false;
const resetServer = vi.fn();
vi.mock('@/lib/capacitor', () => ({
  isNativePlatform: () => mockNative,
  getCapacitorPlugin: (name: string) => (name === 'ServerNavigation' && mockNative ? { resetServer } : null),
}));

function renderTopBar() {
  return render(<MemoryRouter><AppTopBar /></MemoryRouter>);
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

  it('opens the emoji manager from the menu', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    fireEvent.click(screen.getByTestId('user-menu-emojis'));
    expect(screen.getByTestId('emoji-manager-open')).toBeInTheDocument();
  });

  it('triggers admin navigation from the menu without crashing', () => {
    renderTopBar();
    fireEvent.click(screen.getByTestId('topbar-account'));
    expect(() => fireEvent.click(screen.getByTestId('user-menu-admin'))).not.toThrow();
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
