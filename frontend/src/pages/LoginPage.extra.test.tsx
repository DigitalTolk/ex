import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LoginPage from './LoginPage';

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
  apiFetch: vi.fn().mockResolvedValue({ id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' }),
}));

const originalFetch = globalThis.fetch;

function renderLoginPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <LoginPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

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

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'tok-123' }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows "Welcome back" heading', () => {
    renderLoginPage();
    expect(screen.getByText('Welcome back')).toBeInTheDocument();
  });

  it('shows SSO button', () => {
    renderLoginPage();
    expect(screen.getByLabelText('Sign in with Single Sign-On')).toBeInTheDocument();
  });

  it('shows email and password fields for guest login', () => {
    renderLoginPage();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('shows "Sign in" guest button', () => {
    renderLoginPage();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('shows "Or sign in as guest" separator', () => {
    renderLoginPage();
    expect(screen.getByText('Or sign in as guest')).toBeInTheDocument();
  });

  it('calls login() when SSO button is clicked', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    await user.click(screen.getByLabelText('Sign in with Single Sign-On'));
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('submits guest login form', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText('Email'), 'test@test.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByText('Sign in'));

    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows error on failed guest login', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Invalid credentials' }),
    } as Response);

    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText('Email'), 'test@test.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByText('Sign in'));

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials');
    });
  });
});

describe('LoginPage - invite mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'tok-inv' }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows "Accept Invitation" heading', () => {
    renderInvitePage();
    expect(screen.getByText('Accept Invitation')).toBeInTheDocument();
  });

  it('shows display name and password fields', () => {
    renderInvitePage();
    expect(screen.getByLabelText('Display Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('shows "Create Account" button', () => {
    renderInvitePage();
    expect(screen.getByText('Create Account')).toBeInTheDocument();
  });

  it('does not show SSO or guest login in invite mode', () => {
    renderInvitePage();
    expect(screen.queryByLabelText('Sign in with Single Sign-On')).not.toBeInTheDocument();
    expect(screen.queryByText('Or sign in as guest')).not.toBeInTheDocument();
  });
});
