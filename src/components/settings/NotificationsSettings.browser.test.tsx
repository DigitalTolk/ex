import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { resetNotificationTraceForTests, traceNotification } from '@/lib/notification-trace';
import { apiFetch } from '@/lib/api';
import { NotificationsSettings } from './NotificationsSettings';

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
    notificationSettings: undefined as Record<string, unknown> | undefined,
  } as Record<string, unknown> & { notificationSettings: Record<string, unknown> | undefined },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, patchUser }),
}));

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

const SAVED = {
  desktopLevel: 'mentions',
  mobileLevel: 'default',
  threadReplies: true,
  ignoreGroupMentions: false,
  followAllThreads: false,
  keywords: ['deploy'],
};

function putBodies() {
  return vi
    .mocked(apiFetch)
    .mock.calls.filter((c: unknown[]) => c[0] === '/api/v1/users/me/notification-settings')
    .map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body));
}

function lastPut() {
  const all = putBodies();
  return all[all.length - 1];
}

describe('NotificationsSettings (autosave)', () => {
  beforeEach(() => {
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
    vi.mocked(apiFetch).mockImplementation(async (_url: string, init?: RequestInit) => ({
      notificationSettings: JSON.parse(String(init?.body)),
    }) as never);
    authState.user.notificationSettings = { ...SAVED };
  });
  afterEach(() => cleanup());

  it('renders the saved settings grouped into sections', async () => {
    const screen = await render(<NotificationsSettings />);
    await expect.element(screen.getByText('Notify me about')).toBeVisible();
    await expect.element(screen.getByText('Threads & mentions')).toBeVisible();
    await expect.element(screen.getByText('On this device')).toBeVisible();
    await expect.element(screen.getByLabelText('Desktop')).toHaveValue('mentions');
    await expect.element(screen.getByText('deploy')).toBeVisible();
    // Mobile follows desktop by default → no mobile picker.
    await expect.element(screen.getByRole('switch', { name: 'Different settings on mobile' })).not.toBeChecked();
    expect(document.getElementById('settings-mobile-level')).toBeNull();
    // Nothing was saved just by opening.
    expect(putBodies()).toHaveLength(0);
  });

  it('saves the desktop level as soon as it changes', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByLabelText('Desktop').selectOptions('all');
    await vi.waitFor(() => expect(lastPut()?.desktopLevel).toBe('all'));
    expect(lastPut().keywords).toEqual(['deploy']);
    await vi.waitFor(() => expect(patchUser).toHaveBeenCalled());
    expect((patchUser.mock.calls[0][0] as { notificationSettings: { desktopLevel: string } }).notificationSettings.desktopLevel).toBe('all');
  });

  it('turning on different mobile settings copies the desktop level and reveals the picker', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Different settings on mobile' }).click();
    await vi.waitFor(() => expect(lastPut()?.mobileLevel).toBe('mentions'));
    const mobile = screen.getByLabelText('Mobile');
    await expect.element(mobile).toHaveValue('mentions');
    await mobile.selectOptions('all');
    await vi.waitFor(() => expect(lastPut()?.mobileLevel).toBe('all'));
    // Desktop stays on its own level.
    expect(lastPut().desktopLevel).toBe('mentions');
  });

  it('turning different mobile settings off goes back to "same as desktop"', async () => {
    authState.user.notificationSettings = { ...SAVED, mobileLevel: 'all' };
    const screen = await render(<NotificationsSettings />);
    await expect.element(screen.getByLabelText('Mobile')).toHaveValue('all');
    await screen.getByRole('switch', { name: 'Different settings on mobile' }).click();
    await vi.waitFor(() => expect(lastPut()?.mobileLevel).toBe('default'));
    expect(document.getElementById('settings-mobile-level')).toBeNull();
  });

  it('saves each thread & mention toggle', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Replies to threads I follow' }).click();
    await vi.waitFor(() => expect(lastPut()?.threadReplies).toBe(false));
    await screen.getByRole('switch', { name: 'Follow all threads' }).click();
    await vi.waitFor(() => expect(lastPut()?.followAllThreads).toBe(true));
    await screen.getByRole('switch', { name: 'Ignore @all and @here' }).click();
    await vi.waitFor(() => expect(lastPut()?.ignoreGroupMentions).toBe(true));
    // Each save carries the full, cumulative snapshot.
    expect(lastPut()).toMatchObject({ threadReplies: false, followAllThreads: true, ignoreGroupMentions: true });
  });

  it('sends saves one after another, in order, when changes come in a burst', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(apiFetch).mockImplementationOnce(async (_u: string, init?: RequestInit) => {
      await gate;
      return { notificationSettings: JSON.parse(String(init?.body)) } as never;
    });
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Follow all threads' }).click();
    await screen.getByRole('switch', { name: 'Ignore @all and @here' }).click();
    // The second request waits for the first.
    expect(putBodies()).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(putBodies()).toHaveLength(2));
    expect(putBodies()[1]).toMatchObject({ followAllThreads: true, ignoreGroupMentions: true });
  });

  it('adds keywords with Enter, comma and blur, ignoring blank + duplicate entries', async () => {
    const screen = await render(<NotificationsSettings />);
    const input = screen.getByLabelText('Keywords');
    await input.click();
    await userEvent.type(input, 'alpha');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText('alpha')).toBeVisible();
    await userEvent.type(input, 'beta,');
    await expect.element(screen.getByText('beta')).toBeVisible();
    // Duplicate (case-insensitive) and blank entries are ignored — no save.
    const saves = putBodies().length;
    await userEvent.type(input, 'ALPHA');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');
    expect(putBodies()).toHaveLength(saves);
    // A typed-but-not-entered word is kept when the field loses focus.
    await userEvent.type(input, 'urgent');
    await screen.getByText('Keywords').click();
    await vi.waitFor(() => expect(lastPut()?.keywords).toEqual(['deploy', 'alpha', 'beta', 'urgent']));
    expect(document.querySelectorAll('[data-testid="keyword-chip"]').length).toBe(4);
  });

  it('removes a keyword from its chip', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('button', { name: 'Remove keyword deploy' }).click();
    await expect.element(screen.getByText('deploy')).not.toBeInTheDocument();
    await vi.waitFor(() => expect(lastPut()?.keywords).toEqual([]));
  });

  it('falls back to the request body when the response omits settings', async () => {
    vi.mocked(apiFetch).mockResolvedValue({} as never);
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Follow all threads' }).click();
    await vi.waitFor(() => expect(patchUser).toHaveBeenCalled());
    expect((patchUser.mock.calls[0][0] as { notificationSettings: { followAllThreads: boolean } }).notificationSettings.followAllThreads).toBe(true);
  });

  it('shows the error when a save fails, and clears it on the next change', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('boom'));
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Follow all threads' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('boom');
    await screen.getByRole('switch', { name: 'Ignore @all and @here' }).click();
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  });

  it('falls back to a generic error for a non-Error rejection', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce('weird');
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Follow all threads' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to save notification settings');
  });

  it('falls back to defaults when the user has no saved settings', async () => {
    authState.user.notificationSettings = undefined;
    const screen = await render(<NotificationsSettings />);
    await expect.element(screen.getByLabelText('Desktop')).toHaveValue('mentions');
    expect(document.querySelectorAll('[data-testid="keyword-chip"]').length).toBe(0);
  });

  it('shows no keyword chips when the saved list is omitted', async () => {
    const { keywords: _omit, ...rest } = SAVED;
    void _omit;
    authState.user.notificationSettings = rest;
    const screen = await render(<NotificationsSettings />);
    await expect.element(screen.getByText('Keywords')).toBeVisible();
    expect(document.querySelectorAll('[data-testid="keyword-chip"]').length).toBe(0);
  });

  it('device toggles update the local prefs', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Show popups' }).click();
    expect(notif.setBrowserEnabled).toHaveBeenCalledWith(false);
    // Turning popups off never asks for permission.
    expect(notif.requestPermission).not.toHaveBeenCalled();
    await screen.getByRole('switch', { name: 'Play a sound' }).click();
    expect(notif.setSoundEnabled).toHaveBeenCalledWith(false);
  });

  it('turning popups on asks for permission when it has not been requested', async () => {
    notif.permission = 'default';
    notif.prefs = { soundEnabled: true, browserEnabled: false, idleDetectionEnabled: false };
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: 'Show popups' }).click();
    expect(notif.setBrowserEnabled).toHaveBeenCalledWith(true);
    expect(notif.requestPermission).toHaveBeenCalled();
  });

  it('enabling away detection requests permission from the toggle gesture and persists the grant', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: "Send to phone when I'm away" }).click();
    await vi.waitFor(() => expect(notif.setIdleDetectionEnabled).toHaveBeenCalledWith(true));
  });

  it('a denied idle-detection permission leaves the feature off and explains why', async () => {
    idleDetector.permission = false;
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: "Send to phone when I'm away" }).click();
    await vi.waitFor(() => expect(notif.setIdleDetectionEnabled).toHaveBeenCalledWith(false));
    await expect.element(screen.getByTestId('idle-detection-status')).toMatchTextContent(/not granted/i);
  });

  it('disabling away detection never re-prompts for permission', async () => {
    notif.prefs = { soundEnabled: true, browserEnabled: true, idleDetectionEnabled: true };
    const screen = await render(<NotificationsSettings />);
    await screen.getByRole('switch', { name: "Send to phone when I'm away" }).click();
    expect(notif.setIdleDetectionEnabled).toHaveBeenCalledWith(false);
    expect(idleDetector.request).not.toHaveBeenCalled();
  });

  it('hides the away-detection toggle when the browser has no IdleDetector', async () => {
    idleDetector.supported = false;
    const screen = await render(<NotificationsSettings />);
    await expect.element(screen.getByRole('switch', { name: 'Play a sound' })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Send to phone when I'm away");
  });

  it('keeps troubleshooting collapsed until opened', async () => {
    const screen = await render(<NotificationsSettings />);
    const details = screen.getByTestId('notification-trace');
    await expect.element(screen.getByTestId('send-test-notification')).not.toBeVisible();
    await details.getByText('Troubleshooting').click();
    await expect.element(screen.getByTestId('send-test-notification')).toBeVisible();
  });

  it.each([
    ['granted', 'Allowed'],
    ['denied', 'Blocked in this browser'],
    ['unsupported', 'Not supported by this browser'],
    ['default', 'Not requested yet'],
  ])('labels browser permission "%s" as "%s"', async (perm, label) => {
    notif.permission = perm;
    const screen = await render(<NotificationsSettings />);
    await screen.getByTestId('notification-trace').getByText('Troubleshooting').click();
    await expect.element(screen.getByTestId('notification-permission')).toHaveTextContent(label);
  });

  it('sends a test notification through the dispatch path with a unique id', async () => {
    const screen = await render(<NotificationsSettings />);
    await screen.getByTestId('notification-trace').getByText('Troubleshooting').click();
    await screen.getByTestId('send-test-notification').click();
    expect(notif.dispatch).toHaveBeenCalledTimes(1);
    const payload = notif.dispatch.mock.calls[0][0] as { kind: string; messageID: string; parentType: string };
    expect(payload.kind).toBe('mention');
    expect(payload.messageID).toMatch(/^test-/);
    expect(payload.parentType).toBe('channel');
    await expect.element(screen.getByTestId('test-notification-status')).toMatchTextContent(/Sent/i);
  });

  it.each([
    ['requests permission first, then explains a dismissed prompt', 'default', 'default', true, /not granted/i],
    ['explains when browser permission is blocked', 'denied', 'denied', true, /blocked/i],
    ['explains when web notifications are unsupported', 'unsupported', 'unsupported', true, /does not support/i],
    ['explains when popups are off but the sound played', 'granted', 'granted', false, /Show popups/],
  ])('%s', async (_name, perm, requested, popups, message) => {
    notif.permission = perm;
    notif.requestPermission.mockResolvedValue(requested);
    notif.prefs = { soundEnabled: true, browserEnabled: popups, idleDetectionEnabled: false };
    const screen = await render(<NotificationsSettings />);
    await screen.getByTestId('notification-trace').getByText('Troubleshooting').click();
    await screen.getByTestId('send-test-notification').click();
    if (perm === 'default') expect(notif.requestPermission).toHaveBeenCalled();
    await expect.element(screen.getByTestId('test-notification-status')).toMatchTextContent(message);
  });

  it('diagnostics show the placeholder when nothing was processed, and entries when it was', async () => {
    const screen = await render(<NotificationsSettings />);
    const details = screen.getByTestId('notification-trace');
    await details.getByText('Troubleshooting').click();
    await expect.element(details).toMatchTextContent(/No notifications processed/);
    traceNotification('suppressed-thread', 'm-diag', { thread: 'root-9' });
    traceNotification('held');
    await details.getByText('Troubleshooting').click(); // close
    await details.getByText('Troubleshooting').click(); // reopen re-reads
    const entries = screen.getByTestId('notification-trace-entry').elements();
    expect(entries.some((el) => /suppressed-thread m-diag/.test(el.textContent ?? ''))).toBe(true);
    expect(entries.some((el) => /held\s*$/.test(el.textContent ?? ''))).toBe(true);
  });
});
