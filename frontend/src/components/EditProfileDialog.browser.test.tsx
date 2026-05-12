import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditProfileDialog } from './EditProfileDialog';

// Browser coverage for EditProfileDialog — mounts the dialog open/closed
// and verifies the form renders + cancel/close path.

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    id: 'u-1',
    email: 'a@x.com',
    displayName: 'Alice Renamed',
    systemRole: 'admin',
    status: 'active',
  }),
  getAccessToken: () => 'token',
}));

const authState = {
  user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', authProvider: 'local' as const },
  isAuthenticated: true,
  isLoading: false,
  setAuth: vi.fn(),
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
  useOptionalAuth: () => authState,
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EditProfileDialog browser', () => {
  it('does not render when closed', async () => {
    const onOpenChange = vi.fn();
    await render(
      <Wrap>
        <EditProfileDialog open={false} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    expect(document.body.textContent).not.toContain('Edit profile');
  });

  it('renders the form when open with the current display name prefilled', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EditProfileDialog open={true} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    await expect.element(screen.getByText('Edit profile')).toBeVisible();
    const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement
      ?? document.querySelector('input:not([type])') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('Alice');
  });
});
