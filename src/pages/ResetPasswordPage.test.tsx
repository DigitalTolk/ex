import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ResetPasswordPage from './ResetPasswordPage';

const originalFetch = globalThis.fetch;

function renderPage(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/forgot-password" element={<ResetPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/login" element={<div>Sign in page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// The page renders UpdateBanner, which polls /api/v1/version through the same
// mock — always select the call under test by URL, never by index.
function callTo(fetchMock: ReturnType<typeof mockFetch>, path: string) {
  const call = fetchMock.mock.calls.find(([url]) => url === path);
  if (!call) throw new Error(`no fetch call to ${path}`);
  return call;
}

function mockFetch(impl: (url: string, init?: RequestInit) => Partial<Response>) {
  const fn = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: () => Promise.resolve({}),
      ...impl(url, init),
    } as Response),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    mockFetch(() => ({}));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('request mode (/forgot-password)', () => {
    it('posts the address and confirms without revealing whether it exists', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch(() => ({}));
      renderPage('/forgot-password');

      await user.type(await screen.findByLabelText(/email/i), 'guest@example.com');
      await user.click(screen.getByRole('button', { name: /email me a reset link/i }));

      await waitFor(() => expect(callTo(fetchMock, '/auth/password/forgot')).toBeDefined());
      const [, init] = callTo(fetchMock, '/auth/password/forgot');
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'guest@example.com' });

      // Deliberately non-committal: confirming the address exists here would
      // hand an attacker an account-enumeration oracle.
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(/if that address belongs to a guest account/i);
      expect(status).not.toHaveTextContent(/guest@example\.com/);
    });

    it('tells SSO users their password lives elsewhere', async () => {
      renderPage('/forgot-password');
      expect(
        await screen.findByText(/managed by your identity provider/i),
      ).toBeInTheDocument();
    });

    it('surfaces a server error', async () => {
      const user = userEvent.setup();
      mockFetch(() => ({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: { message: 'password reset is not available' } }),
      }));
      renderPage('/forgot-password');

      await user.type(await screen.findByLabelText(/email/i), 'guest@example.com');
      await user.click(screen.getByRole('button', { name: /email me a reset link/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not available/i);
    });

    it('surfaces a non-Error rejection', async () => {
      const user = userEvent.setup();
      globalThis.fetch = vi.fn().mockRejectedValue('offline') as unknown as typeof fetch;
      renderPage('/forgot-password');

      await user.type(await screen.findByLabelText(/email/i), 'guest@example.com');
      await user.click(screen.getByRole('button', { name: /email me a reset link/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    });
  });

  describe('redeem mode (/reset-password/:token)', () => {
    it('sends the token with the new password and confirms the sign-out', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch(() => ({}));
      renderPage('/reset-password/tok-123');

      await user.type(await screen.findByLabelText(/new password/i), 'brand-new-password');
      await user.type(screen.getByLabelText(/confirm password/i), 'brand-new-password');
      await user.click(screen.getByRole('button', { name: /set new password/i }));

      await waitFor(() => expect(callTo(fetchMock, '/auth/password/reset')).toBeDefined());
      const [, init] = callTo(fetchMock, '/auth/password/reset');
      expect(JSON.parse(String(init?.body))).toEqual({
        token: 'tok-123',
        password: 'brand-new-password',
      });

      expect(await screen.findByRole('status')).toHaveTextContent(
        /signed out everywhere else/i,
      );
    });

    it('refuses mismatched passwords without calling the server', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch(() => ({}));
      renderPage('/reset-password/tok-123');

      await user.type(await screen.findByLabelText(/new password/i), 'brand-new-password');
      await user.type(screen.getByLabelText(/confirm password/i), 'something-else');
      await user.click(screen.getByRole('button', { name: /set new password/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces an expired or already-used link', async () => {
      const user = userEvent.setup();
      mockFetch(() => ({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: { message: 'this password reset link is invalid or has expired' },
          }),
      }));
      renderPage('/reset-password/tok-123');

      await user.type(await screen.findByLabelText(/new password/i), 'brand-new-password');
      await user.type(screen.getByLabelText(/confirm password/i), 'brand-new-password');
      await user.click(screen.getByRole('button', { name: /set new password/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/i);
    });

    it('falls back to a generic message when the error body is unreadable', async () => {
      const user = userEvent.setup();
      mockFetch(() => ({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      }));
      renderPage('/reset-password/tok-123');

      await user.type(await screen.findByLabelText(/new password/i), 'brand-new-password');
      await user.type(screen.getByLabelText(/confirm password/i), 'brand-new-password');
      await user.click(screen.getByRole('button', { name: /set new password/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    });

    it('surfaces a plain string error payload', async () => {
      const user = userEvent.setup();
      mockFetch(() => ({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'token and password are required' }),
      }));
      renderPage('/reset-password/tok-123');

      await user.type(await screen.findByLabelText(/new password/i), 'brand-new-password');
      await user.type(screen.getByLabelText(/confirm password/i), 'brand-new-password');
      await user.click(screen.getByRole('button', { name: /set new password/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/token and password are required/i);
    });

    it('surfaces a non-Error rejection', async () => {
      const user = userEvent.setup();
      globalThis.fetch = vi.fn().mockRejectedValue('offline') as unknown as typeof fetch;
      renderPage('/reset-password/tok-123');

      await user.type(await screen.findByLabelText(/new password/i), 'brand-new-password');
      await user.type(screen.getByLabelText(/confirm password/i), 'brand-new-password');
      await user.click(screen.getByRole('button', { name: /set new password/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    });
  });

  it('offers a way back to sign in before and after completing', async () => {
    const user = userEvent.setup();
    renderPage('/forgot-password');

    expect(await screen.findByRole('link', { name: /back to sign in/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/email/i), 'guest@example.com');
    await user.click(screen.getByRole('button', { name: /email me a reset link/i }));

    const back = await screen.findByRole('link', { name: /back to sign in/i });
    await user.click(back);
    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
  });
});
