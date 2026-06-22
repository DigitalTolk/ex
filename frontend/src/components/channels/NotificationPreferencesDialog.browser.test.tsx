import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { NotificationPreferencesDialog } from './NotificationPreferencesDialog';

const setPrefs = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
const muteChannel = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
const channelsState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: channelsState.rows }),
  useSetChannelNotificationPrefs: () => setPrefs,
  useMuteChannel: () => muteChannel,
}));

const authState = vi.hoisted(() => ({
  notificationSettings: {
    desktopLevel: 'mentions', mobileLevel: 'default', threadReplies: true,
    ignoreGroupMentions: false, followAllThreads: false, keywords: [] as string[],
  } as Record<string, unknown> | undefined,
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', notificationSettings: authState.notificationSettings } }),
}));

const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileRef.value }));

function clickInGroup(groupLabel: string, optionLabel: string) {
  const group = document.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`) as HTMLElement;
  const btn = Array.from(group.querySelectorAll('button')).find((b) => b.textContent === optionLabel) as HTMLButtonElement;
  btn.click();
}

describe('NotificationPreferencesDialog browser', () => {
  beforeEach(() => {
    isMobileRef.value = false;
    setPrefs.mutateAsync.mockReset().mockResolvedValue(undefined);
    muteChannel.mutateAsync.mockReset().mockResolvedValue(undefined);
    channelsState.rows = [{ channelID: 'ch1', channelName: 'general', muted: false }];
    authState.notificationSettings = {
      desktopLevel: 'mentions', mobileLevel: 'default', threadReplies: true,
      ignoreGroupMentions: false, followAllThreads: false, keywords: [],
    };
  });
  afterEach(() => cleanup());

  it('does not render when closed', async () => {
    await render(<NotificationPreferencesDialog open={false} onOpenChange={vi.fn()} channelId="ch1" channelName="general" />);
    expect(document.body.textContent).not.toContain('Notification preferences');
  });

  it('saves explicit overrides and toggles mute when changed', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={onOpenChange} channelId="ch1" channelName="general" />,
    );
    await expect.element(screen.getByText('Notification preferences')).toBeVisible();
    // Account default hint surfaces.
    await expect.element(screen.getByText('Default: Mentions, DMs & keywords').first()).toBeVisible();

    clickInGroup('Desktop notifications', 'All messages');
    clickInGroup('Thread replies', 'Off');
    await screen.getByRole('switch', { name: 'Mute channel' }).click();

    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(setPrefs.mutateAsync).toHaveBeenCalled());
    const arg = setPrefs.mutateAsync.mock.calls[0][0] as { channelId: string; override: Record<string, unknown> };
    expect(arg.channelId).toBe('ch1');
    expect(arg.override.desktopLevel).toBe('all');
    expect(arg.override.threadReplies).toBe(false);
    expect(arg.override.mobileLevel).toBeUndefined();
    expect(arg.override.ignoreGroupMentions).toBeUndefined();
    expect(muteChannel.mutateAsync).toHaveBeenCalledWith({ channelId: 'ch1', muted: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps all overrides as inherit and does not touch mute when unchanged', async () => {
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(setPrefs.mutateAsync).toHaveBeenCalled());
    const arg = setPrefs.mutateAsync.mock.calls[0][0] as { override: Record<string, unknown> };
    expect(arg.override.desktopLevel).toBeUndefined();
    expect(arg.override.threadReplies).toBeUndefined();
    expect(muteChannel.mutateAsync).not.toHaveBeenCalled();
  });

  it('prefills from an existing override and saves explicit on/off values', async () => {
    channelsState.rows = [{
      channelID: 'ch1', channelName: 'general', muted: true,
      desktopLevel: 'all', mobileLevel: 'mentions', threadReplies: false,
      ignoreGroupMentions: true, followAllThreads: false,
    }];
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    // Mute switch reflects the stored muted=true.
    await expect.element(screen.getByRole('switch', { name: 'Mute channel' })).toHaveAttribute('aria-checked', 'true');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(setPrefs.mutateAsync).toHaveBeenCalled());
    const arg = setPrefs.mutateAsync.mock.calls[0][0] as { override: Record<string, unknown> };
    expect(arg.override.desktopLevel).toBe('all');
    expect(arg.override.threadReplies).toBe(false);
    expect(arg.override.ignoreGroupMentions).toBe(true);
    expect(arg.override.followAllThreads).toBe(false);
    // muted unchanged → mute mutation not invoked.
    expect(muteChannel.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows an error when saving fails', async () => {
    setPrefs.mutateAsync.mockRejectedValueOnce(new Error('nope'));
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('nope');
  });

  it('falls back to a generic error for a non-Error rejection', async () => {
    setPrefs.mutateAsync.mockRejectedValueOnce('weird');
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to save notification preferences');
  });

  it('falls back to account defaults when the user has no settings and no channel row', async () => {
    authState.notificationSettings = undefined;
    channelsState.rows = [];
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    await expect.element(screen.getByText('Default: Same as desktop')).toBeVisible();
  });

  it('renders account-default hints for non-default account toggles', async () => {
    authState.notificationSettings = {
      desktopLevel: 'mentions', mobileLevel: 'default',
      threadReplies: false, ignoreGroupMentions: true, followAllThreads: true, keywords: [],
    };
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    // threadReplies default Off; ignore-group + follow-all defaults On.
    await expect.element(screen.getByText('Default: Off')).toBeVisible();
    expect(document.body.textContent).toContain('Default: On');
  });

  it('hides the desktop footer Save button on mobile', async () => {
    isMobileRef.value = true;
    const screen = await render(
      <NotificationPreferencesDialog open onOpenChange={vi.fn()} channelId="ch1" channelName="general" />,
    );
    await expect.element(screen.getByText('Notification preferences')).toBeVisible();
    expect(document.querySelector('.justify-end button')).toBeNull();
  });
});
