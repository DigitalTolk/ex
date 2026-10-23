import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OIDCCallbackPage from './OIDCCallbackPage';
import { rememberReturnTo } from '@/lib/return-to';

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

const mockRefresh = vi.fn();
const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  refreshAccessToken: () => mockRefresh(),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const me = { id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' };

function renderPage(entry = '/oidc/callback') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <OIDCCallbackPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OIDCCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefresh.mockResolvedValue(null);
    mockApiFetch.mockResolvedValue(me);
  });

  it('shows "Completing sign in..." text', async () => {
    renderPage();
    expect(screen.getByText('Completing sign in...')).toBeInTheDocument();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });

  it('navigates to /login when there is no session cookie', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
    expect(mockSetAuth).not.toHaveBeenCalled();
  });

  it('signs in from the refresh cookie and navigates home', async () => {
    mockRefresh.mockResolvedValue('tok-abc');
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users/me');
    expect(mockSetAuth).toHaveBeenCalledWith('tok-abc', me);
  });

  it('returns to the page that sent the visitor to sign in', async () => {
    mockRefresh.mockResolvedValue('tok-abc');
    rememberReturnTo('/runner/connect?port=43123');
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/runner/connect?port=43123', { replace: true });
    });
  });
});
