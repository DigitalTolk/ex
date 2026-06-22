import { useState } from 'react';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDialogMobileAction,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { NotificationOptionGroup } from '@/components/notifications/NotificationOptionGroup';
import { useAuth } from '@/context/AuthContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { apiFetch } from '@/lib/api';
import type {
  MobileNotificationLevel,
  NotificationLevel,
  NotificationSettings,
  User,
} from '@/types';

interface NotificationSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  desktopLevel: 'mentions',
  mobileLevel: 'default',
  threadReplies: true,
  ignoreGroupMentions: false,
  followAllThreads: false,
  keywords: [],
};

export function NotificationSettingsDialog({ open, onOpenChange }: NotificationSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-md:grid-rows-[auto_1fr]" mobileCloseLabel="Cancel">
        <DialogHeader>
          <DialogTitle>Notification settings</DialogTitle>
        </DialogHeader>
        {open && <NotificationSettingsBody onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function NotificationSettingsBody({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { user, patchUser } = useAuth();
  const isMobile = useIsMobile();
  const initial = user?.notificationSettings ?? DEFAULT_SETTINGS;

  const [desktopLevel, setDesktopLevel] = useState<NotificationLevel>(initial.desktopLevel);
  const [mobileLevel, setMobileLevel] = useState<MobileNotificationLevel>(initial.mobileLevel);
  const [threadReplies, setThreadReplies] = useState(initial.threadReplies);
  const [ignoreGroupMentions, setIgnoreGroupMentions] = useState(initial.ignoreGroupMentions);
  const [followAllThreads, setFollowAllThreads] = useState(initial.followAllThreads);
  const [keywords, setKeywords] = useState<string[]>(initial.keywords ?? []);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  function addKeyword() {
    const kw = keywordDraft.trim();
    setKeywordDraft('');
    if (!kw) return;
    if (keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) return;
    setKeywords((prev) => [...prev, kw]);
  }

  function removeKeyword(kw: string) {
    setKeywords((prev) => prev.filter((k) => k !== kw));
  }

  function handleKeywordKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addKeyword();
    }
  }

  async function handleSave() {
    setError('');
    setIsSaving(true);
    try {
      const body: NotificationSettings = {
        desktopLevel,
        mobileLevel,
        threadReplies,
        ignoreGroupMentions,
        followAllThreads,
        keywords,
      };
      const updated = await apiFetch<User>('/api/v1/users/me/notification-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      patchUser({ notificationSettings: updated.notificationSettings ?? body });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save notification settings');
    } finally {
      setIsSaving(false);
    }
  }

  useDialogMobileAction(
    isMobile ? { label: 'Save', onClick: handleSave, disabled: isSaving } : null,
  );

  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <NotificationOptionGroup
        label="Desktop notifications"
        value={desktopLevel}
        onChange={(v) => setDesktopLevel(v as NotificationLevel)}
        options={[
          { value: 'all', label: 'All messages' },
          { value: 'mentions', label: 'Mentions, DMs & keywords' },
        ]}
        hint="The default for every channel. Override individual channels from the channel menu."
      />

      <NotificationOptionGroup
        label="Mobile notifications"
        value={mobileLevel}
        onChange={(v) => setMobileLevel(v as MobileNotificationLevel)}
        options={[
          { value: 'default', label: 'Same as desktop' },
          { value: 'all', label: 'All messages' },
          { value: 'mentions', label: 'Mentions, DMs & keywords' },
        ]}
        hint="Mobile push is delivered when you're away from your desktop."
      />

      <ToggleRow
        label="Thread replies"
        description="Notify me about replies to threads I'm following."
        checked={threadReplies}
        onChange={setThreadReplies}
      />
      <ToggleRow
        label="Ignore @all and @here"
        description="Suppress notifications from channel-wide mentions."
        checked={ignoreGroupMentions}
        onChange={setIgnoreGroupMentions}
      />
      <ToggleRow
        label="Follow all threads"
        description="Get thread replies even for threads I haven't joined."
        checked={followAllThreads}
        onChange={setFollowAllThreads}
      />

      <div className="space-y-2">
        <Label htmlFor="notification-keyword">Keywords</Label>
        <p className="text-xs text-muted-foreground">
          Get notified when a message contains one of these words, even at the "Mentions" level.
        </p>
        <div className="flex gap-2">
          <Input
            id="notification-keyword"
            value={keywordDraft}
            onChange={(e) => setKeywordDraft(e.target.value)}
            onKeyDown={handleKeywordKeyDown}
            placeholder="Add a keyword and press Enter"
          />
          <Button type="button" variant="outline" onClick={addKeyword} disabled={!keywordDraft.trim()}>
            Add
          </Button>
        </div>
        {keywords.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {keywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
                data-testid="keyword-chip"
              >
                {kw}
                <button
                  type="button"
                  onClick={() => removeKeyword(kw)}
                  aria-label={`Remove keyword ${kw}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

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

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}
