import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LoginPage from '@/pages/LoginPage';

const mockLogin = vi.fn();
const mockSetAuth = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: mockLogin,
    logout: vi.fn(),
    setAuth: mockSetAuth,
  }),
}));

vi.mock('@/lib/api', () => ({
  setAccessToken: vi.fn(),
  apiFetch: vi.fn().mockResolvedValue({ id: 'u-1', displayName: 'Invited User', email: 'inv@test.com', systemRole: 'guest', status: 'active' }),
}));

const originalFetch = globalThis.fetch;

function renderInvitePage(token = 'invite-abc') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/invite/${token}`]}>
        <Routes>
          <Route path="/invite/:token" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoginPage - invite accept flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'tok-inv-123' }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows invite mode fields', () => {
    renderInvitePage();
    expect(screen.getByText('Accept Invitation')).toBeInTheDocument();
    expect(screen.getByLabelText('Display Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText('Create Account')).toBeInTheDocument();
  });

  it('submits invite accept form', async () => {
    const user = userEvent.setup();
    renderInvitePage();

    await user.type(screen.getByLabelText('Display Name'), 'John Doe');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByText('Create Account'));

    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/auth/invite/accept',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows error on failed invite accept', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Invalid invite token' }),
    } as Response);

    const user = userEvent.setup();
    renderInvitePage();

    await user.type(screen.getByLabelText('Display Name'), 'John Doe');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByText('Create Account'));

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid invite token');
    });
  });

  it('shows error with fallback message when json parsing fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error('json parse error')),
    } as unknown as Response);

    const user = userEvent.setup();
    renderInvitePage();

    await user.type(screen.getByLabelText('Display Name'), 'John Doe');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByText('Create Account'));

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invite acceptance failed');
    });
  });

  it('does not show SSO button in invite mode', () => {
    renderInvitePage();
    expect(screen.queryByLabelText('Sign in with Single Sign-On')).not.toBeInTheDocument();
  });

  it('shows setup text in invite mode', () => {
    renderInvitePage();
    expect(screen.getByText('Set up your account to get started')).toBeInTheDocument();
  });
});
