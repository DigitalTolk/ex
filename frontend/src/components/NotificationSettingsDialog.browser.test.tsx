import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { NotificationSettingsDialog } from './NotificationSettingsDialog';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const patchUser = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  user: {
    id: 'u-1',
    email: 'a@x.com',
    displayName: 'Alice',
    systemRole: 'member' as string,
    status: 'active',
    notificationSettings: {
      desktopLevel: 'mentions' as string,
      mobileLevel: 'default' as string,
      threadReplies: true,
      ignoreGroupMentions: false,
      followAllThreads: false,
      keywords: ['deploy'] as string[],
    } as Record<string, unknown> | undefined,
  } as Record<string, unknown>,
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, patchUser }),
}));

const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileRef.value }));

function okUser(overrides?: Record<string, unknown>) {
  return {
    id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'member', status: 'active',
    notificationSettings: {
      desktopLevel: 'all', mobileLevel: 'default', threadReplies: true,
      ignoreGroupMentions: false, followAllThreads: false, keywords: ['deploy'],
    },
    ...overrides,
  };
}

describe('NotificationSettingsDialog browser', () => {
  beforeEach(() => {
    isMobileRef.value = false;
    patchUser.mockClear();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(okUser() as never);
    authState.user.notificationSettings = {
      desktopLevel: 'mentions', mobileLevel: 'default', threadReplies: true,
      ignoreGroupMentions: false, followAllThreads: false, keywords: ['deploy'],
    };
  });
  afterEach(() => cleanup());

  it('does not render when closed', async () => {
    await render(<NotificationSettingsDialog open={false} onOpenChange={vi.fn()} />);
    expect(document.body.textContent).not.toContain('Notification settings');
  });

  it('renders current settings and saves an updated payload', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(<NotificationSettingsDialog open onOpenChange={onOpenChange} />);
    await expect.element(screen.getByText('Notification settings')).toBeVisible();

    // Existing keyword chip is shown.
    await expect.element(screen.getByText('deploy')).toBeVisible();

    // Switch desktop to "All messages" and toggle the follow-all switch.
    await screen.getByRole('radio', { name: 'All messages' }).first().click();
    await screen.getByRole('switch', { name: 'Follow all threads' }).click();

    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c: unknown[]) => c[0] === '/api/v1/users/me/notification-settings');
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body);
      expect(body.desktopLevel).toBe('all');
      expect(body.followAllThreads).toBe(true);
      expect(body.keywords).toEqual(['deploy']);
    });
    expect(patchUser).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('adds a keyword via the Add button and removes one via its chip', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Keywords').fill('release');
    await screen.getByRole('button', { name: 'Add' }).click();
    await expect.element(screen.getByText('release')).toBeVisible();
    // Remove the original "deploy" keyword.
    await screen.getByRole('button', { name: 'Remove keyword deploy' }).click();
    await expect.element(screen.getByText('deploy')).not.toBeInTheDocument();
  });

  it('adds a keyword with Enter and comma, ignoring blank + duplicate entries', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText('Keywords');
    // type() fires real keydown events so the non-shortcut keys (the false
    // arm of handleKeywordKeyDown) are exercised too.
    await input.click();
    await userEvent.type(input, 'alpha');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText('alpha')).toBeVisible();
    // Comma also commits a keyword.
    await userEvent.type(input, 'beta,');
    await expect.element(screen.getByText('beta')).toBeVisible();
    // Duplicate (case-insensitive) is ignored.
    await userEvent.type(input, 'ALPHA');
    await userEvent.keyboard('{Enter}');
    // Blank is ignored.
    await userEvent.keyboard('{Enter}');
    const chips = document.querySelectorAll('[data-testid="keyword-chip"]');
    // deploy + alpha + beta only.
    expect(chips.length).toBe(3);
  });

  it('commits a typed-but-not-added keyword when saving', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Keywords').fill('urgent');
    // No "Add" click — Save must still capture it.
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c: unknown[]) => c[0] === '/api/v1/users/me/notification-settings');
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as { body: string }).body).keywords).toEqual(['deploy', 'urgent']);
    });
  });

  it('does not duplicate a pending keyword that already exists on save', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Keywords').fill('DEPLOY');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c: unknown[]) => c[0] === '/api/v1/users/me/notification-settings');
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as { body: string }).body).keywords).toEqual(['deploy']);
    });
  });

  it('falls back to the request body when the response omits settings', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okUser({ notificationSettings: undefined }) as never);
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(patchUser).toHaveBeenCalled());
    const patch = patchUser.mock.calls[0][0] as { notificationSettings: { desktopLevel: string } };
    expect(patch.notificationSettings.desktopLevel).toBe('mentions');
  });

  it('shows an error message when saving fails', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('boom'));
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('falls back to a generic error for a non-Error rejection', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce('weird');
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to save notification settings');
  });

  it('falls back to defaults when the user has no saved settings', async () => {
    authState.user.notificationSettings = undefined;
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    // Mentions is the default desktop level → that radio is active.
    await expect.element(screen.getByRole('radio', { name: 'Mentions, DMs & keywords' }).first()).toHaveAttribute('aria-checked', 'true');
  });

  it('shows no keyword chips when the saved list is empty', async () => {
    authState.user.notificationSettings = {
      desktopLevel: 'mentions', mobileLevel: 'default', threadReplies: true,
      ignoreGroupMentions: false, followAllThreads: false,
      // keywords intentionally omitted → the `initial.keywords ?? []` fallback.
    };
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('Notification settings')).toBeVisible();
    expect(document.querySelectorAll('[data-testid="keyword-chip"]').length).toBe(0);
  });

  it('hides the desktop footer Save button on mobile', async () => {
    isMobileRef.value = true;
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('Notification settings')).toBeVisible();
    // The bottom-bar Save is desktop-only; on mobile it moves to the header action.
    expect(document.querySelector('.justify-end button')).toBeNull();
  });
});
