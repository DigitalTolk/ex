import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
const mockSetAuth = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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
const mockRefresh = vi.fn();
vi.mock('@/lib/api', () => ({
  refreshAccessToken: () => mockRefresh(),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const originalLocation = window.location;

import OIDCCallbackPage from './OIDCCallbackPage';

function renderPage(entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <OIDCCallbackPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Behaviour change (login CSRF): the page used to sign in with a token from
// its URL (#token, #access_token, ?token, ?access_token) and to forward
// ?desktop_code= to /auth/desktop/complete — so a crafted link could sign the
// clicker into the attacker's account. Every one of those is now ignored:
// the refresh cookie is the only way in.
describe('OIDCCallbackPage - URL credentials are ignored', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({ id: 'u-1', displayName: 'T', email: 't@t.com', systemRole: 'member', status: 'active' });
    mockRefresh.mockResolvedValue(null);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it.each([
    ['#token=attacker', '/oidc/callback'],
    ['#access_token=attacker', '/oidc/callback'],
    ['', '/oidc/callback?token=attacker'],
    ['', '/oidc/callback?access_token=attacker'],
    ['', '/oidc/callback?desktop_code=attacker-code'],
  ])('hash %j / url %j does not sign in', async (hash, entry) => {
    const replaceMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hash, replace: replaceMock },
    });

    renderPage(entry);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockSetAuth).not.toHaveBeenCalled();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('a URL token never overrides the session the cookie holds', async () => {
    mockRefresh.mockResolvedValue('cookie-token');
    renderPage('/oidc/callback?token=attacker');
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
    expect(mockSetAuth).toHaveBeenCalledWith('cookie-token', expect.objectContaining({ id: 'u-1' }));
  });

  it('redirects to /login when /api/v1/users/me fails after refreshing', async () => {
    mockRefresh.mockResolvedValue('cookie-token');
    mockApiFetch.mockRejectedValue(new Error('me failed'));
    renderPage('/oidc/callback');
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
    expect(mockSetAuth).not.toHaveBeenCalled();
  });

  it('redirects to /login when the refresh itself fails', async () => {
    mockRefresh.mockRejectedValue(new Error('network'));
    renderPage('/oidc/callback');
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
  });
});
