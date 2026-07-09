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

  it('display name input is editable for guest users', () => {
    mockUser.authProvider = 'guest';
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it('legacy users (authProvider unset) are treated as SSO and locked', () => {
    // Pre-feature accounts have no authProvider field on the JSON. They
    // were created via OIDC, so the safest default is the locked state.
    mockUser.authProvider = undefined;
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it('does not render the SSO email caption anymore', () => {
    renderDialog();
    expect(
      screen.queryByText(/Email comes from your SSO provider/i),
    ).toBeNull();
  });

  it('display name input is disabled and read-only for SSO users', () => {
    mockUser.authProvider = 'oidc';
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
    // The "managed by your SSO provider" caption was removed — disabled
    // state of the input is the only signal, kept terse on purpose.
    expect(
      screen.queryByText(/Display name is managed by your SSO provider/i),
    ).toBeNull();
  });

  it('does not show SSO hint for guest-provider users', () => {
    mockUser.authProvider = 'guest';
    renderDialog();
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });
});
