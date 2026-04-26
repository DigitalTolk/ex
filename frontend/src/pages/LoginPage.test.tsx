import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import LoginPage from './LoginPage';

const originalFetch = globalThis.fetch;

function renderLoginPage(route = '/login') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/invite/:token" element={<LoginPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    // Mock fetch so AuthProvider's tryRestore doesn't fail
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders SSO button', () => {
    renderLoginPage();
    expect(
      screen.getByRole('button', { name: /sign in with single sign-on/i }),
    ).toBeInTheDocument();
  });

  it('renders guest login form with email and password fields', () => {
    renderLoginPage();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign in$/i }),
    ).toBeInTheDocument();
  });

  it('shows invite form when token param is present', () => {
    renderLoginPage('/invite/abc123');
    expect(
      screen.getByText(/accept invitation/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /create account/i }),
    ).toBeInTheDocument();
    // SSO button should NOT be present in invite mode
    expect(
      screen.queryByRole('button', { name: /sign in with single sign-on/i }),
    ).not.toBeInTheDocument();
  });
});
