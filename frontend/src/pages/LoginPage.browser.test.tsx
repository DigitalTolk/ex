import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LoginPage from './LoginPage';

const apiFetchMock = vi.hoisted(() => vi.fn());
const captureServerVersionMock = vi.hoisted(() => vi.fn());
const setAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  captureServerVersion: (...args: unknown[]) => captureServerVersionMock(...args),
  setAccessToken: (...args: unknown[]) => setAccessTokenMock(...args),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const loginMock = vi.hoisted(() => vi.fn());
const setAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/context/AuthContext', () => {
  const auth = {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: loginMock,
    logout: vi.fn(),
    setAuth: setAuthMock,
  };
  return {
    useAuth: () => auth,
    useOptionalAuth: () => auth,
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/hooks/useDocumentTitle', () => ({
  useDocumentTitle: () => undefined,
}));

vi.mock('@/components/UpdateBanner', () => ({
  UpdateBanner: () => null,
}));

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' });
  captureServerVersionMock.mockReset();
  setAccessTokenMock.mockReset();
  loginMock.mockReset();
  setAuthMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/invite/:token" element={<LoginPage />} />
        <Route path="/channel/:slug" element={<div data-testid="channel-landing" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

describe('LoginPage (browser)', () => {
  it('renders the default sign-in mode with both SSO and guest forms', async () => {
    const screen = await mount('/');
    await expect.element(screen.getByText('Welcome back')).toBeVisible();
    expect(document.body.textContent).toContain('Sign in with SSO');
    expect(document.body.textContent).toContain('Or sign in as guest');
  });

  it('renders the invite-acceptance mode when a token is in the URL', async () => {
    const screen = await mount('/invite/tok-123');
    await expect.element(screen.getByText('Accept Invitation')).toBeVisible();
    expect(document.body.textContent).toContain('Display Name');
  });

  it('clicking the SSO button calls the auth login flow', async () => {
    const screen = await mount('/');
    await screen.getByLabelText('Sign in with Single Sign-On').click();
    expect(loginMock).toHaveBeenCalled();
  });

  it('successful guest login posts the credentials, captures server version, and navigates to general', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: 'abc' }));
    const screen = await mount('/');
    const email = screen.getByLabelText('Email').element() as HTMLInputElement;
    const password = screen.getByLabelText('Password').element() as HTMLInputElement;
    setReactInputValue(email, 'a@a.com');
    setReactInputValue(password, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/auth/login', expect.objectContaining({ method: 'POST' }));
    });
    await vi.waitFor(() => {
      expect(setAccessTokenMock).toHaveBeenCalledWith('abc');
      expect(setAuthMock).toHaveBeenCalled();
    });
    expect(captureServerVersionMock).toHaveBeenCalled();
  });

  it('renders the server error message on a 401 guest login', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Bad password' } }, false, 401));
    const screen = await mount('/');
    setReactInputValue(screen.getByLabelText('Email').element() as HTMLInputElement, 'a@a.com');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Bad password');
    });
    expect(setAccessTokenMock).not.toHaveBeenCalled();
  });

  it('falls back to a default error message when the server returns no error body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse')),
    } as Response);
    const screen = await mount('/');
    setReactInputValue(screen.getByLabelText('Email').element() as HTMLInputElement, 'a@a.com');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Login failed');
    });
  });

  it('renders the JS Error message when fetch itself rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network gone'));
    const screen = await mount('/');
    setReactInputValue(screen.getByLabelText('Email').element() as HTMLInputElement, 'a@a.com');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('network gone');
    });
  });

  it('successful invite acceptance redirects to the general channel', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: 'tk' }));
    const screen = await mount('/invite/tok-xyz');
    setReactInputValue(screen.getByLabelText('Display Name').element() as HTMLInputElement, 'Newbie');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pwpwpwpw');
    await screen.getByRole('button', { name: 'Create Account' }).click();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/auth/invite/accept', expect.objectContaining({ method: 'POST' }));
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="channel-landing"]')).not.toBeNull();
    });
  });

  it('shows the server error on a 400 invite acceptance', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Invite expired' }, false, 400));
    const screen = await mount('/invite/tok-old');
    setReactInputValue(screen.getByLabelText('Display Name').element() as HTMLInputElement, 'Newbie');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pwpwpwpw');
    await screen.getByRole('button', { name: 'Create Account' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invite expired');
    });
  });

  it('falls back to default error text when invite-accept JSON parse fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse')),
    } as Response);
    const screen = await mount('/invite/tok-broken');
    setReactInputValue(screen.getByLabelText('Display Name').element() as HTMLInputElement, 'Newbie');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pwpwpwpw');
    await screen.getByRole('button', { name: 'Create Account' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invite acceptance failed');
    });
  });

  it('renders a string-form server error (no nested message) on guest login', async () => {
    // `data.error` is a plain string → the `data.error?.message || data.error`
    // middle branch surfaces it directly.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Account is locked' }, false, 403));
    const screen = await mount('/');
    setReactInputValue(screen.getByLabelText('Email').element() as HTMLInputElement, 'a@a.com');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Account is locked');
    });
  });

  it('uses the default login message when the error body parses but has no error field', async () => {
    // res.ok false, json() resolves to an object WITHOUT `error` → both
    // `data.error?.message` and `data.error` are falsy, so the final
    // `|| 'Login failed'` arm provides the message.
    fetchMock.mockResolvedValueOnce(jsonResponse({ somethingElse: true }, false, 400));
    const screen = await mount('/');
    setReactInputValue(screen.getByLabelText('Email').element() as HTMLInputElement, 'a@a.com');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Login failed');
    });
  });

  it('uses the default invite message when the error body parses but has no error field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ somethingElse: true }, false, 400));
    const screen = await mount('/invite/tok-noerr');
    setReactInputValue(screen.getByLabelText('Display Name').element() as HTMLInputElement, 'Newbie');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pwpwpwpw');
    await screen.getByRole('button', { name: 'Create Account' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invite acceptance failed');
    });
  });

  it('falls back to the default login message when a non-Error is thrown', async () => {
    fetchMock.mockRejectedValueOnce('a bare string rejection');
    const screen = await mount('/');
    setReactInputValue(screen.getByLabelText('Email').element() as HTMLInputElement, 'a@a.com');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pw');
    await screen.getByRole('button', { name: 'Sign in', exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Login failed');
    });
  });

  it('falls back to the default invite message when a non-Error is thrown', async () => {
    fetchMock.mockRejectedValueOnce('a bare string rejection');
    const screen = await mount('/invite/tok-x');
    setReactInputValue(screen.getByLabelText('Display Name').element() as HTMLInputElement, 'Newbie');
    setReactInputValue(screen.getByLabelText('Password').element() as HTMLInputElement, 'pwpwpwpw');
    await screen.getByRole('button', { name: 'Create Account' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invite acceptance failed');
    });
  });
});

function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
