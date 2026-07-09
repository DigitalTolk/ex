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
import { NotificationOptionGroup, NotificationToggleRow } from '@/components/notifications/NotificationOptionGroup';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DESKTOP_LEVEL_OPTIONS,
  MOBILE_LEVEL_OPTIONS,
} from '@/components/notifications/notification-options';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
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

// withKeyword appends a trimmed keyword unless it's blank or a case-insensitive
// duplicate — the dedupe rule shared by the "Add" button and the save-time
// commit of a still-typed keyword.
function withKeyword(list: string[], raw: string): string[] {
  const kw = raw.trim();
  if (!kw || list.some((k) => k.toLowerCase() === kw.toLowerCase())) return list;
  return [...list, kw];
}

export function NotificationSettingsDialog({ open, onOpenChange }: NotificationSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" className="mobile:grid-rows-[auto_1fr]" finalFocus={false} mobileCloseLabel="Cancel">
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
  const initial = user?.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS;

  const [desktopLevel, setDesktopLevel] = useState<NotificationLevel>(initial.desktopLevel);
  const [mobileLevel, setMobileLevel] = useState<MobileNotificationLevel>(initial.mobileLevel);
  const [threadReplies, setThreadReplies] = useState(initial.threadReplies);
  const [ignoreGroupMentions, setIgnoreGroupMentions] = useState(initial.ignoreGroupMentions);
  const [followAllThreads, setFollowAllThreads] = useState(initial.followAllThreads);
  // New accounts are seeded with name-derived keywords server-side at sign-up,
  // so the list here is simply whatever the user has saved.
  const [keywords, setKeywords] = useState<string[]>(initial.keywords ?? []);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  function addKeyword() {
    setKeywords((prev) => withKeyword(prev, keywordDraft));
    setKeywordDraft('');
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
      // Commit any keyword still sitting in the input — saving should not
      // silently drop a word the user typed but didn't click "Add" for.
      const effectiveKeywords = withKeyword(keywords, keywordDraft);
      setKeywords(effectiveKeywords);
      setKeywordDraft('');
      const body: NotificationSettings = {
        desktopLevel,
        mobileLevel,
        threadReplies,
        ignoreGroupMentions,
        followAllThreads,
        keywords: effectiveKeywords,
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
    <div className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto overflow-x-hidden">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <NotificationOptionGroup
        label="Desktop notifications"
        value={desktopLevel}
        onChange={(v) => setDesktopLevel(v as NotificationLevel)}
        options={DESKTOP_LEVEL_OPTIONS}
        hint="The default for every channel. Override individual channels from the channel menu."
      />

      <NotificationOptionGroup
        label="Mobile notifications"
        value={mobileLevel}
        onChange={(v) => setMobileLevel(v as MobileNotificationLevel)}
        options={MOBILE_LEVEL_OPTIONS}
        hint="Mobile push is delivered when you're away from your desktop."
      />

      <NotificationToggleRow
        label="Thread replies"
        description="Notify me about replies to threads I'm following."
        checked={threadReplies}
        onChange={setThreadReplies}
      />
      <NotificationToggleRow
        label="Ignore @all and @here"
        description="Suppress notifications from channel-wide mentions."
        checked={ignoreGroupMentions}
        onChange={setIgnoreGroupMentions}
      />
      <NotificationToggleRow
        label="Follow all threads"
        description="Get thread replies even for threads I haven't joined."
        checked={followAllThreads}
        onChange={setFollowAllThreads}
      />

      <NotificationDeliverySection />


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

// NotificationDeliverySection surfaces the CLIENT-side delivery switches (browser
// popups + sound), the OS permission state, and a "Send test notification"
// button. These gate whether a popup actually appears regardless of the
// account-level settings above, so this is the place to diagnose "I don't see
// any popups" — the test bypasses the server entirely and exercises the exact
// last-mile path (permission + browserEnabled + the OS).
function NotificationDeliverySection() {
  const { prefs, setBrowserEnabled, setSoundEnabled, permission, requestPermission, dispatch } =
    useNotifications();
  const [status, setStatus] = useState('');

  async function sendTest() {
    let perm = permission;
    if (perm === 'default') {
      perm = await requestPermission();
    }
    // Unique messageID so cross-tab dedup never swallows the test; kind "mention"
    // (not "message") and no authorID so the active-view / own-echo suppressions
    // can't drop it. This drives the same dispatch path a real alert uses.
    dispatch({
      kind: 'mention',
      title: 'Test notification 🔔',
      body: 'If you can see this, desktop notifications are working.',
      deepLink: '',
      parentID: '__notification_test__',
      parentType: 'channel',
      messageID: `test-${Date.now()}`,
      createdAt: new Date().toISOString(),
    });

    if (perm === 'unsupported') {
      setStatus('This browser/OS does not support web notifications.');
    } else if (perm === 'denied') {
      setStatus('Browser permission is blocked. Enable notifications for this site in your browser settings, then try again.');
    } else if (perm !== 'granted') {
      setStatus('Browser permission was not granted — no popup will show until you allow it.');
    } else if (!prefs.browserEnabled) {
      setStatus('Played the sound, but “Browser popups” is off above, so no popup appeared.');
    } else {
      setStatus('Sent. If no popup appeared, your OS is likely suppressing it (Do Not Disturb / Focus mode), or popups are blocked at the OS level for this browser.');
    }
  }

  const permissionLabel =
    permission === 'granted'
      ? 'Allowed'
      : permission === 'denied'
        ? 'Blocked in this browser'
        : permission === 'unsupported'
          ? 'Not supported by this browser'
          : 'Not requested yet';

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <Label>Delivery &amp; troubleshooting</Label>
        <p className="text-xs text-muted-foreground">
          These control whether alerts actually surface on this device, independent of the levels above.
        </p>
      </div>

      <NotificationToggleRow
        label="Browser popups"
        description="Show a desktop notification popup for new alerts on this device."
        checked={prefs.browserEnabled}
        onChange={(on) => {
          setBrowserEnabled(on);
          if (on && permission === 'default') void requestPermission();
        }}
      />
      <NotificationToggleRow
        label="Notification sound"
        description="Play a sound when an alert arrives on this device."
        checked={prefs.soundEnabled}
        onChange={setSoundEnabled}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Browser permission: <span className="font-medium text-foreground">{permissionLabel}</span>
        </p>
        <Button type="button" variant="outline" onClick={sendTest} data-testid="send-test-notification">
          Send test notification
        </Button>
      </div>

      {status && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="test-notification-status">
          {status}
        </p>
      )}
    </div>
  );
}
