import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { apiFetch } from '@/lib/api';
import { ProfileSettings } from './ProfileSettings';

// A real 1×1 PNG.
function pngFile(name = 'avatar.png', type = 'image/png') {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type });
}

const tokenRef = vi.hoisted(() => ({ value: 'token' as string | null }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => tokenRef.value,
}));

const authState = vi.hoisted(() => ({
  user: {
    id: 'u-1',
    email: 'a@x.com',
    displayName: 'Alice' as string | undefined,
    systemRole: 'admin',
    status: 'active',
    authProvider: 'guest' as string | undefined,
    avatarURL: undefined as string | undefined,
  },
  // Like the real AuthContext: a successful save replaces the signed-in user.
  setAuth: vi.fn((_token: string, u: { displayName?: string; avatarURL?: string }) => {
    authState.user.displayName = u.displayName;
    authState.user.avatarURL = u.avatarURL;
  }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
}));

function patchCalls() {
  return vi
    .mocked(apiFetch)
    .mock.calls.filter((c: unknown[]) => c[0] === '/api/v1/users/me')
    .map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body));
}

function fileInput() {
  return document.querySelector('[data-testid="settings-avatar-input"]') as HTMLInputElement;
}

describe('ProfileSettings', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    authState.user.authProvider = 'guest';
    authState.user.displayName = 'Alice';
    authState.user.avatarURL = undefined;
    tokenRef.value = 'token';
    authState.setAuth.mockClear();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (_url: string, init?: RequestInit) => ({
      id: 'u-1',
      email: 'a@x.com',
      displayName: JSON.parse(String(init?.body ?? '{}')).displayName ?? 'Alice',
    }) as never);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  it('shows the photo, an editable name for guests, and a read-only email', async () => {
    const screen = await render(<ProfileSettings />);
    await expect.element(screen.getByText('Photo')).toBeVisible();
    await expect.element(screen.getByText('A', { exact: true })).toBeVisible();
    const name = screen.getByLabelText('Display name');
    await expect.element(name).toHaveValue('Alice');
    await expect.element(name).toBeEnabled();
    await expect.element(screen.getByText('How you appear in messages and the directory.')).toBeVisible();
    const email = screen.getByLabelText('Email');
    await expect.element(email).toHaveValue('a@x.com');
    await expect.element(email).toHaveAttribute('readonly');
    // Save / Cancel only appear once the name changes.
    expect(screen.getByRole('button', { name: 'Save' }).query()).toBeNull();
  });

  it.each([['oidc'], [undefined]])('locks the name for SSO accounts (provider %s)', async (provider) => {
    // Legacy users with no provider are treated as SSO.
    authState.user.authProvider = provider;
    const screen = await render(<ProfileSettings />);
    const name = screen.getByLabelText('Display name');
    await expect.element(name).toBeDisabled();
    await expect.element(screen.getByText('Managed by your sign-in provider.')).toBeVisible();
    // Enter on the locked field is a no-op.
    name.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(patchCalls()).toHaveLength(0);
  });

  it('saves a renamed display name with the Save button', async () => {
    const screen = await render(<ProfileSettings />);
    await screen.getByLabelText('Display name').fill('  Alice Renamed  ');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(patchCalls()).toEqual([{ displayName: 'Alice Renamed' }]));
    expect(authState.setAuth).toHaveBeenCalled();
    // The field shows the saved (trimmed) value.
    await expect.element(screen.getByLabelText('Display name')).toHaveValue('Alice Renamed');
  });

  it('shows "Saving…" while the rename is in flight', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((r) => {
      resolve = r;
    }) as never);
    const screen = await render(<ProfileSettings />);
    await screen.getByLabelText('Display name').fill('Bob');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    resolve({ id: 'u-1', email: 'a@x.com', displayName: 'Bob' });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' }).query()).toBeNull());
  });

  it('saves with Enter and ignores Enter when nothing changed', async () => {
    const screen = await render(<ProfileSettings />);
    const name = screen.getByLabelText('Display name');
    await name.click();
    await userEvent.keyboard('{Enter}');
    expect(patchCalls()).toHaveLength(0);
    await name.fill('Carol');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(patchCalls()).toEqual([{ displayName: 'Carol' }]));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).query()).toBeNull());
  });

  it('a blank name is not a change', async () => {
    const screen = await render(<ProfileSettings />);
    await screen.getByLabelText('Display name').fill('   ');
    expect(screen.getByRole('button', { name: 'Save' }).query()).toBeNull();
  });

  it('Cancel and Escape put the saved name back', async () => {
    const screen = await render(<ProfileSettings />);
    const name = screen.getByLabelText('Display name');
    await name.fill('Dave');
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(name).toHaveValue('Alice');
    await name.fill('Eve');
    await userEvent.keyboard('{Escape}');
    await expect.element(name).toHaveValue('Alice');
    // Escape with nothing to cancel does nothing (and lets the dialog close).
    await userEvent.keyboard('{Escape}');
    await expect.element(name).toHaveValue('Alice');
    expect(patchCalls()).toHaveLength(0);
  });

  it.each([
    [new Error('boom'), 'boom'],
    ['weird', 'Failed to save profile'],
  ])('shows an error when the rename fails (%s)', async (rejection, message) => {
    vi.mocked(apiFetch).mockRejectedValueOnce(rejection);
    const screen = await render(<ProfileSettings />);
    await screen.getByLabelText('Display name').fill('Frank');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('falls back to an empty name + placeholder initials when displayName is missing', async () => {
    authState.user.displayName = undefined;
    const screen = await render(<ProfileSettings />);
    await expect.element(screen.getByLabelText('Display name')).toHaveValue('');
    await expect.element(screen.getByText('?', { exact: true })).toBeVisible();
  });

  it('the Upload photo button opens the file chooser', async () => {
    const screen = await render(<ProfileSettings />);
    const clickSpy = vi.spyOn(fileInput(), 'click');
    await screen.getByTestId('settings-upload-avatar').click();
    expect(clickSpy).toHaveBeenCalled();
  });

  it('uploads a new photo (presign + PUT) and saves it straight away', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ uploadURL: 'https://s3/put', key: 'avatars/u-1.png' } as never)
      .mockResolvedValueOnce({ id: 'u-1', email: 'a@x.com', displayName: 'Alice', avatarURL: 'https://s3/a.png' } as never);
    const screen = await render(<ProfileSettings />);
    await userEvent.upload(fileInput(), pngFile());
    await vi.waitFor(() => expect(patchCalls()).toEqual([{ avatarKey: 'avatars/u-1.png' }]), { timeout: 10000 });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://s3/put', expect.objectContaining({ method: 'PUT' }));
    await vi.waitFor(() => expect(authState.setAuth).toHaveBeenCalled());
    await expect.element(screen.getByTestId('settings-upload-avatar')).toHaveTextContent('Upload photo');
  });

  it('shows "Uploading…" while the photo uploads', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}) as never);
    const screen = await render(<ProfileSettings />);
    await userEvent.upload(fileInput(), pngFile());
    await expect.element(screen.getByTestId('settings-upload-avatar')).toHaveTextContent('Uploading…');
    await expect.element(screen.getByTestId('settings-upload-avatar')).toBeDisabled();
  });

  it('skips setAuth when no access token is present', async () => {
    tokenRef.value = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ uploadURL: 'https://s3/put', key: 'k' } as never)
      .mockResolvedValueOnce({ id: 'u-1', email: 'a@x.com', displayName: 'Alice' } as never);
    const screen = await render(<ProfileSettings />);
    await userEvent.upload(fileInput(), pngFile());
    await vi.waitFor(() => expect(patchCalls()).toHaveLength(1), { timeout: 10000 });
    await expect.element(screen.getByTestId('settings-upload-avatar')).toHaveTextContent('Upload photo');
    expect(authState.setAuth).not.toHaveBeenCalled();
  });

  it('rejects a non-image file and a file over 2MB', async () => {
    const screen = await render(<ProfileSettings />);
    await userEvent.upload(fileInput(), new File(['x'], 'a.txt', { type: 'text/plain' }));
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Only JPEG, PNG, or WebP images are allowed');
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    await userEvent.upload(fileInput(), big);
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Image must be smaller than 2MB');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('ignores a change event with no file selected', async () => {
    await render(<ProfileSettings />);
    fileInput().dispatchEvent(new Event('change', { bubbles: true }));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('surfaces a failed PUT upload', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValueOnce({ uploadURL: 'https://s3/put', key: 'k' } as never);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    const screen = await render(<ProfileSettings />);
    await userEvent.upload(fileInput(), pngFile());
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Upload failed: 503');
    expect(patchCalls()).toHaveLength(0);
  });

  it('falls back to a generic message when the upload rejects with a non-Error', async () => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockRejectedValueOnce('weird');
    const screen = await render(<ProfileSettings />);
    await userEvent.upload(fileInput(), pngFile());
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Avatar upload failed');
  });
});
