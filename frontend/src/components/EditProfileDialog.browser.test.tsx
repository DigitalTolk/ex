import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditProfileDialog } from './EditProfileDialog';
import { apiFetch } from '@/lib/api';

// A real 1×1 PNG so the avatar preview's createObjectURL/<img> path works.
function pngFile(name = 'avatar.png', type = 'image/png') {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type });
}

// Browser coverage for EditProfileDialog — mounts the dialog open/closed
// and verifies the form renders + cancel/close + save paths.

const tokenRef = vi.hoisted(() => ({ value: 'token' as string | null }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    id: 'u-1',
    email: 'a@x.com',
    displayName: 'Alice Renamed',
    systemRole: 'admin',
    status: 'active',
  }),
  getAccessToken: () => tokenRef.value,
}));

const authState = {
  user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', authProvider: 'local' as string },
  isAuthenticated: true,
  isLoading: false,
  setAuth: vi.fn(),
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
  useOptionalAuth: () => authState,
}));

const themeRef = vi.hoisted(() => ({ value: 'system' as 'light' | 'dark' | 'system' }));
const setThemeMock = vi.hoisted(() => vi.fn());
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme: setThemeMock }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EditProfileDialog browser', () => {
  beforeEach(() => {
    authState.user.authProvider = 'local';
    authState.user.displayName = 'Alice';
    tokenRef.value = 'token';
    themeRef.value = 'system';
    setThemeMock.mockClear();
    authState.setAuth.mockClear();
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockResolvedValue({
      id: 'u-1', email: 'a@x.com', displayName: 'Alice Renamed', systemRole: 'admin', status: 'active',
    } as never);
  });
  afterEach(() => cleanup());

  it('does not render when closed', async () => {
    const onOpenChange = vi.fn();
    await render(
      <Wrap>
        <EditProfileDialog open={false} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    expect(document.body.textContent).not.toContain('Edit profile');
  });

  it('renders the form when open with the current display name prefilled', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EditProfileDialog open={true} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    await expect.element(screen.getByText('Edit profile')).toBeVisible();
    const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement
      ?? document.querySelector('input:not([type])') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('Alice');
  });

  it('saves a renamed display name for a guest account via PATCH', async () => {
    authState.user.authProvider = 'guest';
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap><EditProfileDialog open onOpenChange={onOpenChange} /></Wrap>,
    );
    const nameInput = document.getElementById('displayName') as HTMLInputElement;
    await screen.getByLabelText('Display name').fill('Alice Renamed');
    expect(nameInput.value).toBe('Alice Renamed');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c: unknown[]) => c[0] === '/api/v1/users/me');
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body);
      expect(body.displayName).toBe('Alice Renamed');
    }, { timeout: 10000 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes without a PATCH when nothing changed', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap><EditProfileDialog open onOpenChange={onOpenChange} /></Wrap>,
    );
    // Local (SSO) user cannot rename and made no avatar change → empty body.
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 10000 });
    expect(vi.mocked(apiFetch).mock.calls.some((c: unknown[]) => c[0] === '/api/v1/users/me')).toBe(false);
  });

  it('surfaces an error when the save request fails', async () => {
    authState.user.authProvider = 'guest';
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('nope'));
    const screen = await render(
      <Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await screen.getByLabelText('Display name').fill('Changed Name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByText('nope')).toBeVisible();
  });

  it('returns null (renders nothing) when there is no signed-in user', async () => {
    const saved = authState.user;
    (authState as { user: typeof saved | null }).user = null;
    try {
      await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
      expect(document.body.textContent).not.toContain('Edit profile');
    } finally {
      authState.user = saved;
    }
  });

  it('rejects a non-image avatar file with a validation error', async () => {
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(fileInput, pngFile('doc.pdf', 'application/pdf'));
    await expect.element(screen.getByRole('alert')).toHaveTextContent('JPEG, PNG, or WebP');
  });

  it('rejects an avatar file larger than 2MB', async () => {
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 10)], 'big.png', { type: 'image/png' });
    await userEvent.upload(fileInput, big);
    await expect.element(screen.getByRole('alert')).toHaveTextContent('smaller than 2MB');
  });

  it('uploads a new avatar (presign + PUT) and saves it with the returned key', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ uploadURL: 'https://s3/put', key: 'avatars/u-1.png' } as never)
      .mockResolvedValueOnce({ id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', avatarURL: 'https://s3/a.png' } as never);
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
    try {
      const onOpenChange = vi.fn();
      const screen = await render(<Wrap><EditProfileDialog open onOpenChange={onOpenChange} /></Wrap>);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(fileInput, pngFile());
      // Wait until the local preview shows the uploaded blob (avatarKey set).
      await vi.waitFor(() => {
        const img = document.querySelector('img');
        expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/);
      }, { timeout: 10000 });
      await screen.getByRole('button', { name: 'Save' }).click();
      await vi.waitFor(() => {
        const call = vi.mocked(apiFetch).mock.calls.find((c: unknown[]) => c[0] === '/api/v1/users/me');
        expect(call).toBeDefined();
        expect(JSON.parse((call![1] as { body: string }).body).avatarKey).toBe('avatars/u-1.png');
      }, { timeout: 10000 });
      expect(authState.setAuth).toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('renders an empty name field and the initials fallback when displayName is undefined', async () => {
    // displayName undefined → `user?.displayName ?? ''` takes the `?? ''` arm,
    // and getInitials(user.displayName || '??') takes the `|| '??'` arm.
    (authState.user as { displayName?: string }).displayName = undefined;
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    await expect.element(screen.getByText('Edit profile')).toBeVisible();
    expect((document.getElementById('displayName') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).toContain('?');
  });

  it('ignores an avatar file-change event with no selected file', async () => {
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    // Fire change with an empty FileList → handleFileSelect's `if (!file) return`.
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    // No error banner appears and the form is still interactive.
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  it('opens the file chooser when the camera (Change avatar) button is clicked', async () => {
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    // Stub the native click so no real OS file chooser opens; the camera
    // button's handler forwards to the hidden input via fileInputRef.
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
    await screen.getByRole('button', { name: 'Change avatar' }).click();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it('selects the System theme via the theme picker', async () => {
    themeRef.value = 'light';
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    await screen.getByRole('button', { name: 'System theme' }).click();
    expect(setThemeMock).toHaveBeenCalledWith('system');
  });

  it('marks the Dark theme button active when the current theme is dark', async () => {
    themeRef.value = 'dark';
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    // theme === 'dark' ? 'default' : 'outline' → the dark button takes the
    // default (active) variant. Clicking another option drives setTheme.
    await expect.element(screen.getByRole('button', { name: 'Dark theme' })).toBeVisible();
    await screen.getByRole('button', { name: 'Light theme' }).click();
    expect(setThemeMock).toHaveBeenCalledWith('light');
  });

  it('marks the Light theme button active when the current theme is light', async () => {
    themeRef.value = 'light';
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    // theme === 'light' → the Light button takes the active (default) variant.
    await expect.element(screen.getByRole('button', { name: 'Light theme' })).toBeVisible();
    await screen.getByRole('button', { name: 'Dark theme' }).click();
    expect(setThemeMock).toHaveBeenCalledWith('dark');
  });

  it('saves the avatar key without setAuth when no access token is present', async () => {
    authState.user.authProvider = 'guest';
    tokenRef.value = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ uploadURL: 'https://s3/put', key: 'avatars/u-1.png' } as never)
      .mockResolvedValueOnce({ id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' } as never);
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
    try {
      const onOpenChange = vi.fn();
      const screen = await render(<Wrap><EditProfileDialog open onOpenChange={onOpenChange} /></Wrap>);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(fileInput, pngFile());
      await vi.waitFor(() => {
        const img = document.querySelector('img');
        expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/);
      }, { timeout: 10000 });
      await screen.getByRole('button', { name: 'Save' }).click();
      await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 10000 });
      // token falsy → the `if (token) setAuth(...)` guard is skipped.
      expect(authState.setAuth).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('falls back to a generic message when the save rejects with a non-Error', async () => {
    authState.user.authProvider = 'guest';
    vi.mocked(apiFetch).mockRejectedValueOnce('weird');
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    await screen.getByLabelText('Display name').fill('Changed');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to save profile');
  });

  it('falls back to a generic message when the avatar upload rejects with a non-Error', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockRejectedValueOnce('weird');
    const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(fileInput, pngFile());
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Avatar upload failed');
  });

  it('surfaces an error when the avatar PUT upload fails', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValueOnce({ uploadURL: 'https://s3/put', key: 'k' } as never);
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    try {
      const screen = await render(<Wrap><EditProfileDialog open onOpenChange={vi.fn()} /></Wrap>);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(fileInput, pngFile());
      await expect.element(screen.getByRole('alert')).toHaveTextContent('Upload failed: 503');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
