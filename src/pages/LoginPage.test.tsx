import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders SSO button', async () => {
    renderLoginPage();
    expect(
      await screen.findByRole('button', { name: /sign in with single sign-on/i }),
    ).toBeInTheDocument();
  });

  it('renders guest login form with email and password fields', async () => {
    renderLoginPage();
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign in$/i }),
    ).toBeInTheDocument();
  });

  // Typing a password lights the submit button up in the brand pink.
  it('turns Sign in pink once a password is typed, and back when cleared', async () => {
    renderLoginPage();
    const password = await screen.findByLabelText(/password/i);
    const signIn = screen.getByRole('button', { name: /sign in$/i });
    expect(signIn).not.toHaveClass('bg-brand');
    expect(signIn).not.toHaveAttribute('data-ready');
    fireEvent.change(password, { target: { value: 'x' } });
    expect(signIn).toHaveClass('bg-brand');
    expect(signIn).toHaveAttribute('data-ready', 'true');
    fireEvent.change(password, { target: { value: '' } });
    expect(signIn).not.toHaveClass('bg-brand');
  });

  it('turns Create Account pink once a password is typed on an invite', async () => {
    renderLoginPage('/invite/abc123');
    const create = await screen.findByRole('button', { name: /create account/i });
    expect(create).not.toHaveClass('bg-brand');
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'secret' } });
    expect(create).toHaveClass('bg-brand');
  });

  it('shows invite form when token param is present', async () => {
    renderLoginPage('/invite/abc123');
    expect(
      await screen.findByText(/accept invitation/i),
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

  it('links to password recovery from the guest form', async () => {
    renderLoginPage();
    const link = await screen.findByRole('link', { name: /forgot your password/i });
    expect(link).toHaveAttribute('href', '/forgot-password');
  });

  // Recovery is a guest-only concept: an invitee is choosing their FIRST
  // password, so offering "forgot yours?" there would be nonsense.
  it('does not offer password recovery in invite mode', async () => {
    renderLoginPage('/invite/abc123');
    await screen.findByText(/accept invitation/i);
    expect(
      screen.queryByRole('link', { name: /forgot your password/i }),
    ).not.toBeInTheDocument();
  });
});
