import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { ThemeProvider } from '@/context/ThemeContext';

let mockUser = {
  id: 'u-1',
  email: 'alice@x.com',
  displayName: 'Alice',
  avatarURL: 'https://x/a.png',
  systemRole: 'member' as const,
  status: 'active',
  authProvider: undefined as 'oidc' | 'guest' | undefined,
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    setAuth: vi.fn(),
  }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), getAccessToken: () => 'tok' }));

function renderDialog() {
  return render(
    <ThemeProvider>
      <EditProfileDialog open onOpenChange={vi.fn()} />
    </ThemeProvider>,
  );
}

describe('EditProfileDialog - SSO display name lock', () => {
  beforeEach(() => {
    mockUser = {
      id: 'u-1',
      email: 'alice@x.com',
      displayName: 'Alice',
      avatarURL: 'https://x/a.png',
      systemRole: 'member',
      status: 'active',
      authProvider: undefined,
    };
  });

  it('display name input is editable for non-SSO users', () => {
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it('display name input is disabled and read-only for SSO users', () => {
    mockUser.authProvider = 'oidc';
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
    expect(
      screen.getByText(/Display name is managed by your SSO provider/i),
    ).toBeInTheDocument();
  });

  it('does not show SSO hint for guest-provider users', () => {
    mockUser.authProvider = 'guest';
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });
});
