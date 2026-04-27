import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OIDCCallbackPage from './OIDCCallbackPage';

const mockNavigate = vi.fn();
const mockSetAuth = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams()],
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

vi.mock('@/lib/api', () => ({
  setAccessToken: vi.fn(),
  apiFetch: vi.fn().mockResolvedValue({ id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' }),
}));

const originalFetch = globalThis.fetch;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OIDCCallbackPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OIDCCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows "Completing sign in..." text', () => {
    renderPage();
    expect(screen.getByText('Completing sign in...')).toBeInTheDocument();
  });

  it('navigates to /login when no token is found and refresh fails', async () => {
    renderPage();
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
  });

  it('navigates to /channel/general when token refresh succeeds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'tok-abc' }),
    } as Response);

    renderPage();

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/channel/general', { replace: true });
    });
  });
});
