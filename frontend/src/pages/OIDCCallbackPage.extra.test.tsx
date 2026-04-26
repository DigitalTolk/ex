import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
const mockSetAuth = vi.fn();

let mockSearchParams = new URLSearchParams();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [mockSearchParams],
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
const mockSetAccessToken = vi.fn();
vi.mock('@/lib/api', () => ({
  setAccessToken: (...args: unknown[]) => mockSetAccessToken(...args),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const originalFetch = globalThis.fetch;
const originalLocation = window.location;

import OIDCCallbackPage from './OIDCCallbackPage';

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

describe('OIDCCallbackPage - extra coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockApiFetch.mockResolvedValue({ id: 'u-1', displayName: 'T', email: 't@t.com', systemRole: 'member', status: 'active' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('reads token from URL hash fragment', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hash: '#token=hashtok' },
    });

    renderPage();

    await vi.waitFor(() => {
      expect(mockSetAccessToken).toHaveBeenCalledWith('hashtok');
      expect(mockNavigate).toHaveBeenCalledWith('/channel/general', { replace: true });
    });
  });

  it('reads access_token from URL hash fragment as fallback', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hash: '#access_token=at-123' },
    });

    renderPage();

    await vi.waitFor(() => {
      expect(mockSetAccessToken).toHaveBeenCalledWith('at-123');
    });
  });

  it('reads token from URL search params', async () => {
    mockSearchParams = new URLSearchParams('token=qstok');

    renderPage();

    await vi.waitFor(() => {
      expect(mockSetAccessToken).toHaveBeenCalledWith('qstok');
    });
  });

  it('redirects to /login when /api/v1/users/me throws after token is set', async () => {
    mockSearchParams = new URLSearchParams('token=abc');
    mockApiFetch.mockRejectedValue(new Error('me failed'));

    renderPage();

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
  });

  it('redirects to /login when refresh fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));

    renderPage();

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
  });

  it('shows the "Completing sign in..." spinner text', () => {
    renderPage();
    expect(screen.getByText('Completing sign in...')).toBeInTheDocument();
  });
});
