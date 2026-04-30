import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationPermissionBanner } from './NotificationPermissionBanner';

const useAuthMock = vi.fn();
const useNotificationsMock = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => useNotificationsMock(),
}));

function setup({
  authenticated = true,
  permission = 'default',
  browserEnabled = true,
  requestPermission = vi.fn().mockResolvedValue('granted'),
}: {
  authenticated?: boolean;
  permission?: 'granted' | 'denied' | 'default' | 'unsupported';
  browserEnabled?: boolean;
  requestPermission?: ReturnType<typeof vi.fn>;
} = {}) {
  useAuthMock.mockReturnValue({ isAuthenticated: authenticated });
  useNotificationsMock.mockReturnValue({
    permission,
    requestPermission,
    prefs: { soundEnabled: true, browserEnabled },
  });
  return { requestPermission };
}

describe('NotificationPermissionBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthMock.mockReset();
    useNotificationsMock.mockReset();
  });

  it('renders when authenticated, permission is default, and not dismissed', () => {
    setup();
    render(<NotificationPermissionBanner />);
    expect(screen.getByTestId('notification-permission-banner')).toBeInTheDocument();
    expect(screen.getByTestId('notification-permission-enable')).toBeInTheDocument();
  });

  it('does not render when the user is unauthenticated', () => {
    setup({ authenticated: false });
    render(<NotificationPermissionBanner />);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
  });

  it('does not render when permission has already been granted', () => {
    setup({ permission: 'granted' });
    render(<NotificationPermissionBanner />);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
  });

  it('does not render when permission has been denied', () => {
    // Browsers gate re-prompts behind site settings, so re-asking is futile.
    setup({ permission: 'denied' });
    render(<NotificationPermissionBanner />);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
  });

  it('does not render when the browser does not support Notification', () => {
    setup({ permission: 'unsupported' });
    render(<NotificationPermissionBanner />);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
  });

  it('does not render when the user has muted browser notifications in prefs', () => {
    setup({ browserEnabled: false });
    render(<NotificationPermissionBanner />);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
  });

  it('does not render when the user previously dismissed the banner', () => {
    setup();
    localStorage.setItem('ex.notifications.banner.dismissed.v1', '1');
    render(<NotificationPermissionBanner />);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
  });

  it('calls requestPermission when Enable is clicked and hides on a non-default result', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    setup({ requestPermission });
    render(<NotificationPermissionBanner />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('notification-permission-enable'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
    expect(localStorage.getItem('ex.notifications.banner.dismissed.v1')).toBe('1');
  });

  it('keeps the banner visible if the user dismisses the OS prompt without choosing', async () => {
    // Some browsers return "default" if the user closes the prompt without
    // a choice — keep nagging in that case (it's cheap and accurate).
    const requestPermission = vi.fn().mockResolvedValue('default');
    setup({ requestPermission });
    render(<NotificationPermissionBanner />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('notification-permission-enable'));
    expect(screen.getByTestId('notification-permission-banner')).toBeInTheDocument();
    expect(localStorage.getItem('ex.notifications.banner.dismissed.v1')).toBeNull();
  });

  it('hides and persists dismissal when the close button is clicked', async () => {
    setup();
    render(<NotificationPermissionBanner />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('notification-permission-dismiss'));
    expect(screen.queryByTestId('notification-permission-banner')).not.toBeInTheDocument();
    expect(localStorage.getItem('ex.notifications.banner.dismissed.v1')).toBe('1');
  });

  it('marks the Enable button as busy while the request is in flight', async () => {
    let resolve: ((v: NotificationPermission) => void) | null = null;
    const requestPermission = vi.fn(
      () => new Promise<NotificationPermission>((r) => { resolve = r; }),
    );
    setup({ requestPermission });
    render(<NotificationPermissionBanner />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('notification-permission-enable'));
    expect(screen.getByTestId('notification-permission-enable')).toHaveTextContent(/asking/i);
    await act(async () => {
      resolve!('granted');
    });
  });
});
