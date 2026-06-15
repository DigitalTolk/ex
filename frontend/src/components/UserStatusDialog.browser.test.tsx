import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserStatusDialog } from './UserStatusDialog';
import { apiFetch } from '@/lib/api';

// Browser coverage for UserStatusDialog — exercises mount, preset selection,
// the save/clear flows, validation, and error handling.

const SAVED_USER = {
  id: 'u-1',
  email: 'a@x.com',
  displayName: 'Alice',
  systemRole: 'admin',
  status: 'active',
  userStatus: { emoji: ':palm_tree:', text: 'On Vacation', clearAt: '' },
};

const tokenRef = vi.hoisted(() => ({ value: 'token' as string | null }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    id: 'u-1',
    email: 'a@x.com',
    displayName: 'Alice',
    systemRole: 'admin',
    status: 'active',
    userStatus: { emoji: ':palm_tree:', text: 'On Vacation', clearAt: '' },
  }),
  getAccessToken: () => tokenRef.value,
}));

const authState = {
  user: {
    id: 'u-1',
    email: 'a@x.com',
    displayName: 'Alice',
    systemRole: 'admin',
    status: 'active',
    userStatus: undefined as undefined | { emoji: string; text: string; clearAt: string },
  },
  isAuthenticated: true,
  isLoading: false,
  setAuth: vi.fn(),
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
  useOptionalAuth: () => authState,
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Track each mount and await unmount() so the Radix dialog portal is torn
// down React-safely between tests (WebKit otherwise stacks portals); kill
// animations so the exit resolves synchronously.
const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}
let killAnims: HTMLStyleElement | null = null;

// Set a native <select> value and fire the change event React listens for.
function selectOption(id: string, value: string) {
  const sel = document.getElementById(id) as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function patchCall(method: string) {
  return vi.mocked(apiFetch).mock.calls.find(
    (c: unknown[]) => c[0] === '/api/v1/users/me/status'
      && (c[1] as { method?: string } | undefined)?.method === method,
  );
}

describe('UserStatusDialog browser', () => {
  beforeEach(() => {
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    killAnims?.remove();
    killAnims = null;
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockResolvedValue(SAVED_USER);
    authState.user.userStatus = undefined;
    tokenRef.value = 'token';
    authState.setAuth.mockClear();
  });

  it('renders nothing when there is no signed-in user', async () => {
    const saved = authState.user;
    (authState as { user: typeof saved | null }).user = null;
    try {
      await mount(<Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>);
      // UserStatusDialog's `if (!user) return null` short-circuits before any
      // dialog content renders.
      expect(document.body.textContent).not.toContain('Set status');
    } finally {
      authState.user = saved;
    }
  });

  it('does not render when closed', async () => {
    await mount(
      <Wrap><UserStatusDialog open={false} onOpenChange={vi.fn()} /></Wrap>,
    );
    expect(document.body.textContent).not.toContain('On Vacation');
  });

  it('renders the preset list when open', async () => {
    await mount(
      <Wrap><UserStatusDialog open={true} onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('On Vacation');
    });
    expect(document.body.textContent).toContain('Working from home');
    expect(document.body.textContent).toContain('In a meeting');
  });

  it('saving a preset status PATCHes /users/me/status with a clear-after window', async () => {
    const onOpenChange = vi.fn();
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={onOpenChange} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-preset')).not.toBeNull());
    // "Out for Lunch" has a 30-minute clear window.
    selectOption('status-preset', 'Out for Lunch');
    await screen.getByRole('button', { name: 'Save status' }).click();
    await vi.waitFor(() => {
      const call = patchCall('PATCH');
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body);
      expect(body.text).toBe('Out for Lunch');
      expect(body.clearAfterSeconds).toBeGreaterThan(0);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('exercises the today / 1-hour / custom clear-after modes on save', async () => {
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByLabelText('Status text').fill('Heads down');
    for (const mode of ['today', '1h', 'custom']) {
      selectOption('clear-after', mode);
      await screen.getByRole('button', { name: 'Save status' }).click();
      await vi.waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      vi.mocked(apiFetch).mockClear();
    }
  });

  it('blocks saving with an empty status text and shows a validation error', async () => {
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByRole('button', { name: 'Save status' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Choose an emoji and status text');
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('surfaces an error when saving the status fails', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('status service down'));
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByLabelText('Status text').fill('Busy');
    await screen.getByRole('button', { name: 'Save status' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('status service down');
  });

  it('selecting "Custom status" preset is a no-op for the preset fields', async () => {
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-preset')).not.toBeNull());
    // Selecting the synthetic custom value hits the early return (no preset
    // match) without mutating emoji/text.
    selectOption('status-preset', '__custom__');
    await screen.getByLabelText('Status text').fill('Free text');
    expect((document.getElementById('status-text') as HTMLInputElement).value).toBe('Free text');
  });

  it('treats a custom clear time in the past as no clear-after window', async () => {
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('clear-after')).not.toBeNull());
    await screen.getByLabelText('Status text').fill('Past');
    selectOption('clear-after', 'custom');
    // A custom time well in the past → clearAfterSecondsFor computes seconds<=0
    // and returns undefined (the `: undefined` arm).
    await screen.getByLabelText('Custom clear time').fill('2000-01-01T00:00');
    await screen.getByRole('button', { name: 'Save status' }).click();
    await vi.waitFor(() => {
      const call = patchCall('PATCH');
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body);
      expect(body.clearAfterSeconds).toBeUndefined();
    });
  });

  it('saves without calling setAuth when no access token is present', async () => {
    tokenRef.value = null;
    const onOpenChange = vi.fn();
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={onOpenChange} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByLabelText('Status text').fill('Heads down');
    await screen.getByRole('button', { name: 'Save status' }).click();
    // applyUpdated skips setAuth (token falsy) but still closes the dialog.
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(authState.setAuth).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when clearing rejects with a non-Error', async () => {
    authState.user.userStatus = { emoji: ':palm_tree:', text: 'On Vacation', clearAt: '' };
    vi.mocked(apiFetch).mockRejectedValueOnce('nope');
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByRole('button', { name: 'Clear status' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to clear status');
  });

  it('prefills the custom clear time from an existing status with a clearAt', async () => {
    authState.user.userStatus = {
      emoji: ':rocket:',
      text: 'Launching',
      clearAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    };
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('clear-after')).not.toBeNull());
    // initialStateFor maps clearAt → clearAfter 'custom' and seeds customUntil
    // from inputValueForISO instead of the +1h default.
    const customInput = screen.getByLabelText('Custom clear time');
    await expect.element(customInput).toBeVisible();
    expect((document.getElementById('clear-after') as HTMLSelectElement).value).toBe('custom');
  });

  it('rejects status text longer than 32 characters', async () => {
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    // maxLength on the input is bypassed by setting the value directly so the
    // explicit length guard (> MAX_STATUS_TEXT_LENGTH) runs.
    const input = document.getElementById('status-text') as HTMLInputElement;
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    native.call(input, 'x'.repeat(40));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await screen.getByRole('button', { name: 'Save status' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('32 characters or fewer');
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when saving rejects with a non-Error', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce('boom');
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByLabelText('Status text').fill('Busy');
    await screen.getByRole('button', { name: 'Save status' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to save status');
  });

  it('clears an existing status via DELETE and recovers from a clear error', async () => {
    authState.user.userStatus = { emoji: ':palm_tree:', text: 'On Vacation', clearAt: '' };
    // First clear fails (covers the catch) and keeps the dialog open with an error.
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('cannot clear'));
    const screen = await mount(
      <Wrap><UserStatusDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await vi.waitFor(() => expect(document.getElementById('status-text')).not.toBeNull());
    await screen.getByRole('button', { name: 'Clear status' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('cannot clear');
    // Second clear succeeds → DELETE.
    await screen.getByRole('button', { name: 'Clear status' }).click();
    await vi.waitFor(() => expect(patchCall('DELETE')).toBeDefined());
  });
});
