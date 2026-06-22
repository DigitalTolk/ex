import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDialogMobileAction,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { NotificationOptionGroup } from '@/components/notifications/NotificationOptionGroup';
import { useUserChannels, useMuteChannel, useSetChannelNotificationPrefs } from '@/hooks/useChannels';
import { useAuth } from '@/context/AuthContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import type {
  ChannelNotificationOverride,
  MobileNotificationLevel,
  NotificationLevel,
  NotificationSettings,
} from '@/types';

interface NotificationPreferencesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  channelName: string;
}

const ACCOUNT_FALLBACK: NotificationSettings = {
  desktopLevel: 'mentions',
  mobileLevel: 'default',
  threadReplies: true,
  ignoreGroupMentions: false,
  followAllThreads: false,
  keywords: [],
};

type TriState = 'inherit' | 'on' | 'off';

const DESKTOP_LABEL: Record<NotificationLevel, string> = {
  all: 'All messages',
  mentions: 'Mentions, DMs & keywords',
};
const MOBILE_LABEL: Record<MobileNotificationLevel, string> = {
  default: 'Same as desktop',
  all: 'All messages',
  mentions: 'Mentions, DMs & keywords',
};

export function NotificationPreferencesDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
}: NotificationPreferencesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-md:grid-rows-[auto_1fr]" mobileCloseLabel="Cancel">
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

  const uc = userChannels?.find((c) => c.channelID === channelId);
  const account = user?.notificationSettings ?? ACCOUNT_FALLBACK;

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

  const triOptions = [
    { value: 'inherit', label: 'Use default' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];

  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Preferences for <span className="font-medium text-foreground">~{channelName}</span>. "Use
        default" follows your account-level notification settings.
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label>Mute channel</Label>
          <p className="text-xs text-muted-foreground">
            No sound or popup, and hide unread emphasis in the sidebar.
          </p>
        </div>
        <Switch checked={muted} onCheckedChange={setMuted} aria-label="Mute channel" />
      </div>

      <NotificationOptionGroup
        label="Desktop notifications"
        value={desktopLevel}
        onChange={setDesktopLevel}
        options={[
          { value: 'inherit', label: 'Use default' },
          { value: 'all', label: 'All messages' },
          { value: 'mentions', label: 'Mentions, DMs & keywords' },
        ]}
        hint={`Default: ${DESKTOP_LABEL[account.desktopLevel]}`}
      />

      <NotificationOptionGroup
        label="Mobile notifications"
        value={mobileLevel}
        onChange={setMobileLevel}
        options={[
          { value: 'inherit', label: 'Use default' },
          { value: 'default', label: 'Same as desktop' },
          { value: 'all', label: 'All messages' },
          { value: 'mentions', label: 'Mentions, DMs & keywords' },
        ]}
        hint={`Default: ${MOBILE_LABEL[account.mobileLevel]}`}
      />

      <NotificationOptionGroup
        label="Thread replies"
        value={threadReplies}
        onChange={(v) => setThreadReplies(v as TriState)}
        options={triOptions}
        hint={`Default: ${account.threadReplies ? 'On' : 'Off'}`}
      />
      <NotificationOptionGroup
        label="Ignore @all and @here"
        value={ignoreGroupMentions}
        onChange={(v) => setIgnoreGroupMentions(v as TriState)}
        options={triOptions}
        hint={`Default: ${account.ignoreGroupMentions ? 'On' : 'Off'}`}
      />
      <NotificationOptionGroup
        label="Follow all threads"
        value={followAllThreads}
        onChange={(v) => setFollowAllThreads(v as TriState)}
        options={triOptions}
        hint={`Default: ${account.followAllThreads ? 'On' : 'Off'}`}
      />

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
