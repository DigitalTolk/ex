import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { resetNotificationTraceForTests, traceNotification } from '@/lib/notification-trace';
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

const notif = vi.hoisted(() => ({
  prefs: { soundEnabled: true, browserEnabled: true, idleDetectionEnabled: false },
  permission: 'granted' as string,
  dispatch: vi.fn(),
  requestPermission: vi.fn(async () => 'granted' as string),
  setBrowserEnabled: vi.fn(),
  setSoundEnabled: vi.fn(),
  setIdleDetectionEnabled: vi.fn(),
}));
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => notif,
}));

const idleDetector = vi.hoisted(() => {
  const state = {
    supported: true,
    permission: true,
    request: vi.fn(async () => state.permission),
  };
  return state;
});
vi.mock('@/lib/idle-detector', () => ({
  idleDetectionSupported: () => idleDetector.supported,
  requestIdleDetectionPermission: idleDetector.request,
}));

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
    notif.dispatch.mockClear();
    notif.requestPermission.mockClear();
    notif.requestPermission.mockResolvedValue('granted');
    notif.setBrowserEnabled.mockClear();
    notif.setSoundEnabled.mockClear();
    notif.setIdleDetectionEnabled.mockClear();
    notif.permission = 'granted';
    notif.prefs = { soundEnabled: true, browserEnabled: true, idleDetectionEnabled: false };
    idleDetector.supported = true;
    idleDetector.permission = true;
    idleDetector.request.mockClear();
    resetNotificationTraceForTests();
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

  it('changes the mobile notification level independently of desktop', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('Notification settings')).toBeVisible();

    // The mobile group offers "Same as desktop" plus the desktop levels; pick
    // "Same as desktop" is the saved value, so switch mobile to its own
    // "All messages" (the second radio with that label — first is desktop's).
    await screen.getByRole('radio', { name: 'All messages' }).nth(1).click();
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c: unknown[]) => c[0] === '/api/v1/users/me/notification-settings');
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body);
      expect(body.mobileLevel).toBe('all');
      // Desktop stays on its saved level — the two groups are independent.
      expect(body.desktopLevel).toBe('mentions');
    });
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

  it('sends a test notification through the dispatch path with a unique id', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByTestId('send-test-notification').click();
    expect(notif.dispatch).toHaveBeenCalledTimes(1);
    const payload = notif.dispatch.mock.calls[0][0] as { kind: string; messageID: string; parentType: string };
    expect(payload.kind).toBe('mention'); // not "message" → can't be active-view-suppressed
    expect(payload.messageID).toMatch(/^test-/); // unique → never deduped
    expect(payload.parentType).toBe('channel');
    await expect.element(screen.getByTestId('test-notification-status')).toHaveTextContent(/Sent/i);
  });

  it('requests permission first when it has not been granted yet', async () => {
    notif.permission = 'default';
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByTestId('send-test-notification').click();
    expect(notif.requestPermission).toHaveBeenCalled();
  });

  it('explains when the permission prompt was dismissed without granting', async () => {
    notif.permission = 'default';
    notif.requestPermission.mockResolvedValue('default'); // user dismissed the prompt
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByTestId('send-test-notification').click();
    await expect.element(screen.getByTestId('test-notification-status')).toHaveTextContent(/not granted/i);
  });

  it('toggling browser popups off never re-requests permission', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByLabelText(/Browser popups/i).click();
    expect(notif.setBrowserEnabled).toHaveBeenCalledWith(false);
    expect(notif.requestPermission).not.toHaveBeenCalled();
  });

  it('explains when browser permission is blocked', async () => {
    notif.permission = 'denied';
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByTestId('send-test-notification').click();
    await expect.element(screen.getByTestId('test-notification-status')).toHaveTextContent(/blocked/i);
  });

  it('explains when web notifications are unsupported', async () => {
    notif.permission = 'unsupported';
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByTestId('send-test-notification').click();
    await expect.element(screen.getByTestId('test-notification-status')).toHaveTextContent(/does not support/i);
  });

  it('explains when popups are turned off but sound played', async () => {
    notif.prefs = { soundEnabled: true, browserEnabled: false, idleDetectionEnabled: false };
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByTestId('send-test-notification').click();
    await expect.element(screen.getByTestId('test-notification-status')).toHaveTextContent(/popup/i);
  });

  it('toggling browser popups on requests permission when not yet asked', async () => {
    notif.permission = 'default';
    notif.prefs = { soundEnabled: true, browserEnabled: false, idleDetectionEnabled: false }; // start OFF so the click turns it ON
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('switch', { name: 'Browser popups' }).click();
    expect(notif.setBrowserEnabled).toHaveBeenCalledWith(true);
    expect(notif.requestPermission).toHaveBeenCalled();
    await screen.getByRole('switch', { name: 'Notification sound' }).click();
    expect(notif.setSoundEnabled).toHaveBeenCalled();
  });

  it('enabling away detection requests permission from the toggle gesture and persists the grant', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('switch', { name: /Away detection/ }).click();
    await vi.waitFor(() => {
      expect(notif.setIdleDetectionEnabled).toHaveBeenCalledWith(true);
    });
  });

  it('a denied idle-detection permission leaves the feature off and explains why', async () => {
    idleDetector.permission = false;
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('switch', { name: /Away detection/ }).click();
    await vi.waitFor(() => {
      expect(notif.setIdleDetectionEnabled).toHaveBeenCalledWith(false);
    });
    await expect.element(screen.getByTestId('idle-detection-status')).toHaveTextContent(/not granted/i);
  });

  it('disabling away detection never re-prompts for permission', async () => {
    notif.prefs = { soundEnabled: true, browserEnabled: true, idleDetectionEnabled: true };
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await screen.getByRole('switch', { name: /Away detection/ }).click();
    expect(notif.setIdleDetectionEnabled).toHaveBeenCalledWith(false);
    expect(idleDetector.request).not.toHaveBeenCalled();
  });

  it('hides the away-detection toggle when the browser has no IdleDetector', async () => {
    idleDetector.supported = false;
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByRole('switch', { name: 'Notification sound' })).toBeVisible();
    expect(document.querySelector('[role="switch"][aria-label*="Away detection"]')).toBeNull();
    expect(screen.container.textContent).not.toContain('Away detection');
  });

  it('diagnostics readout shows the placeholder when no notifications were processed, and entries when they were', async () => {
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    const details = screen.getByTestId('notification-trace');
    await details.getByText(/Recent notification decisions/).click();
    await expect.element(details).toHaveTextContent(/No notifications processed/);
    // A processed notification appears after re-opening the block — one full
    // entry and one bare entry (no messageID/detail, e.g. a payload-less step).
    traceNotification('suppressed-thread', 'm-diag', { thread: 'root-9' });
    traceNotification('held');
    await details.getByText(/Recent notification decisions/).click(); // close
    await details.getByText(/Recent notification decisions/).click(); // reopen re-reads
    const entries = screen.getByTestId('notification-trace-entry').elements();
    expect(entries.some((el) => /suppressed-thread m-diag/.test(el.textContent ?? ''))).toBe(true);
    expect(entries.some((el) => /held\s*$/.test(el.textContent ?? ''))).toBe(true);
  });

  it('hides the desktop footer Save button on mobile', async () => {
    isMobileRef.value = true;
    const screen = await render(<NotificationSettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('Notification settings')).toBeVisible();
    // The bottom-bar Save is desktop-only; on mobile it moves to the header action.
    expect(document.querySelector('.justify-end button')).toBeNull();
  });
});
