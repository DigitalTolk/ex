import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockSetAuth = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: mockSetAuth,
  }),
}));

const mockApiFetch = vi.fn();
const mockSetAccessToken = vi.fn();
vi.mock('@/lib/api', () => ({
  setAccessToken: (...args: unknown[]) => mockSetAccessToken(...args),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import LoginPage from './LoginPage';

const originalFetch = globalThis.fetch;

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <LoginPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function renderInvite(token = 'inv-1') {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({ id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('LoginPage flows - success paths', () => {
  it('completes guest login: setAccessToken, fetch /me, setAuth, navigate', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'tok-1' }),
    } as Response);

    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'a@a.com');
    await user.type(screen.getByLabelText('Password'), 'pw12345678');
    await user.click(screen.getByText('Sign in'));

    await waitFor(() => {
      expect(mockSetAccessToken).toHaveBeenCalledWith('tok-1');
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users/me');
      expect(mockSetAuth).toHaveBeenCalledWith('tok-1', expect.objectContaining({ id: 'u-1' }));
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows generic error when login response JSON parse fails (line 34)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error('parse')),
    } as Response);

    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'a@a.com');
    await user.type(screen.getByLabelText('Password'), 'pw12345678');
    await user.click(screen.getByText('Sign in'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Login failed/i);
  });

  it('falls back to error string when error.message is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'plain string error' }),
    } as Response);

    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'a@a.com');
    await user.type(screen.getByLabelText('Password'), 'pw12345678');
    await user.click(screen.getByText('Sign in'));

    expect(await screen.findByRole('alert')).toHaveTextContent('plain string error');
  });

  it('completes invite acceptance: setAccessToken, fetch /me, setAuth, navigate', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'tok-inv' }),
    } as Response);

    const user = userEvent.setup();
    renderInvite();

    await user.type(screen.getByLabelText('Display Name'), 'Newbie');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    await user.click(screen.getByText('Create Account'));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/auth/invite/accept',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mockSetAccessToken).toHaveBeenCalledWith('tok-inv');
      expect(mockSetAuth).toHaveBeenCalledWith('tok-inv', expect.any(Object));
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows error on failed invite acceptance', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Invalid invite' }),
    } as Response);

    const user = userEvent.setup();
    renderInvite();

    await user.type(screen.getByLabelText('Display Name'), 'X');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    await user.click(screen.getByText('Create Account'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid invite');
  });

  it('shows fallback error when invite acceptance JSON parse fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error('bad json')),
    } as Response);

    const user = userEvent.setup();
    renderInvite();

    await user.type(screen.getByLabelText('Display Name'), 'X');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    await user.click(screen.getByText('Create Account'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Invite acceptance failed/i);
  });

  it('handles non-Error thrown from invite handler gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('plain reject');

    const user = userEvent.setup();
    renderInvite();

    await user.type(screen.getByLabelText('Display Name'), 'X');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    await user.click(screen.getByText('Create Account'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Invite acceptance failed/i);
  });
});
