import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDialogMobileAction,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NotificationOptionGroup, NotificationToggleRow } from '@/components/notifications/NotificationOptionGroup';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DESKTOP_LEVEL_OPTIONS,
  MOBILE_LEVEL_OPTIONS,
  DESKTOP_LEVEL_LABEL,
  MOBILE_LEVEL_LABEL,
  INHERIT_OPTION,
} from '@/components/notifications/notification-options';
import { useUserChannels, useMuteChannel, useSetChannelNotificationPrefs } from '@/hooks/useChannels';
import { useAuth } from '@/context/AuthContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import type {
  ChannelNotificationOverride,
  MobileNotificationLevel,
  NotificationLevel,
} from '@/types';

interface NotificationPreferencesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  channelName: string;
}

type TriState = 'inherit' | 'on' | 'off';

// The per-channel level rows prepend "Use default" to the shared account-level
// options. Tri-state booleans reuse the same inherit/on/off shape.
const DESKTOP_OVERRIDE_OPTIONS = [INHERIT_OPTION, ...DESKTOP_LEVEL_OPTIONS];
const MOBILE_OVERRIDE_OPTIONS = [INHERIT_OPTION, ...MOBILE_LEVEL_OPTIONS];
const TRI_OPTIONS = [INHERIT_OPTION, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];

export function NotificationPreferencesDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
}: NotificationPreferencesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" className="mobile:grid-rows-[auto_1fr]" finalFocus={false} mobileCloseLabel="Cancel">
        <DialogHeader>
          <DialogTitle>Notification preferences</DialogTitle>
        </DialogHeader>
        {open && (
          <NotificationPreferencesBody
            channelId={channelId}
            channelName={channelName}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NotificationPreferencesBody({
  channelId,
  channelName,
  onOpenChange,
}: {
  channelId: string;
  channelName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { data: userChannels } = useUserChannels();
  const setPrefs = useSetChannelNotificationPrefs();
  const muteChannel = useMuteChannel();

  const uc = useMemo(
    () => userChannels?.find((c) => c.channelID === channelId),
    [userChannels, channelId],
  );
  const account = user?.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS;

  const [muted, setMuted] = useState(!!uc?.muted);
  const [desktopLevel, setDesktopLevel] = useState<string>(uc?.desktopLevel ?? 'inherit');
  const [mobileLevel, setMobileLevel] = useState<string>(uc?.mobileLevel ?? 'inherit');
  const [threadReplies, setThreadReplies] = useState<TriState>(triFrom(uc?.threadReplies));
  const [ignoreGroupMentions, setIgnoreGroupMentions] = useState<TriState>(triFrom(uc?.ignoreGroupMentions));
  const [followAllThreads, setFollowAllThreads] = useState<TriState>(triFrom(uc?.followAllThreads));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setError('');
    setIsSaving(true);
    try {
      const override: ChannelNotificationOverride = {
        desktopLevel: desktopLevel === 'inherit' ? undefined : (desktopLevel as NotificationLevel),
        mobileLevel: mobileLevel === 'inherit' ? undefined : (mobileLevel as MobileNotificationLevel),
        threadReplies: triValue(threadReplies),
        ignoreGroupMentions: triValue(ignoreGroupMentions),
        followAllThreads: triValue(followAllThreads),
      };
      await setPrefs.mutateAsync({ channelId, override });
      if (muted !== !!uc?.muted) {
        await muteChannel.mutateAsync({ channelId, muted });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save notification preferences');
    } finally {
      setIsSaving(false);
    }
  }

  useDialogMobileAction(
    isMobile ? { label: 'Save', onClick: handleSave, disabled: isSaving } : null,
  );

  // The three boolean overrides share one shape; drive them from a list so the
  // markup isn't three copy-pasted blocks.
  const toggleOverrides = [
    { label: 'Thread replies', value: threadReplies, set: setThreadReplies, def: account.threadReplies },
    { label: 'Ignore @all and @here', value: ignoreGroupMentions, set: setIgnoreGroupMentions, def: account.ignoreGroupMentions },
    { label: 'Follow all threads', value: followAllThreads, set: setFollowAllThreads, def: account.followAllThreads },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto overflow-x-hidden">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Preferences for <span className="font-medium text-foreground">~{channelName}</span>. "Use
        default" follows your account-level notification settings.
      </p>

      <NotificationToggleRow
        label="Mute channel"
        description="No sound or popup, and hide unread emphasis in the sidebar."
        checked={muted}
        onChange={setMuted}
      />

      <NotificationOptionGroup
        label="Desktop notifications"
        value={desktopLevel}
        onChange={setDesktopLevel}
        options={DESKTOP_OVERRIDE_OPTIONS}
        hint={`Default: ${DESKTOP_LEVEL_LABEL[account.desktopLevel]}`}
      />

      <NotificationOptionGroup
        label="Mobile notifications"
        value={mobileLevel}
        onChange={setMobileLevel}
        options={MOBILE_OVERRIDE_OPTIONS}
        hint={`Default: ${MOBILE_LEVEL_LABEL[account.mobileLevel]}`}
      />

      {toggleOverrides.map((t) => (
        <NotificationOptionGroup
          key={t.label}
          label={t.label}
          value={t.value}
          onChange={(v) => t.set(v as TriState)}
          options={TRI_OPTIONS}
          hint={`Default: ${t.def ? 'On' : 'Off'}`}
        />
      ))}

      {!isMobile && (
        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}

function triFrom(v: boolean | undefined): TriState {
  if (v === undefined) return 'inherit';
  return v ? 'on' : 'off';
}

function triValue(v: TriState): boolean | undefined {
  if (v === 'inherit') return undefined;
  return v === 'on';
}
