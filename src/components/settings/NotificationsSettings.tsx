import { useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DESKTOP_LEVEL_OPTIONS,
} from '@/components/notifications/notification-options';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { apiFetch } from '@/lib/api';
import { idleDetectionSupported, requestIdleDetectionPermission } from '@/lib/idle-detector';
import { getNotificationTrace } from '@/lib/notification-trace';
import type { MobileNotificationLevel, NotificationLevel, NotificationSettings, User } from '@/types';
import { SettingsRow, SettingsSection } from './settings-ui';
import { useSaveTracker } from './save-status';

// withKeyword appends a trimmed keyword unless it's blank or a case-insensitive
// duplicate.
function withKeyword(list: string[], raw: string): string[] {
  const kw = raw.trim();
  if (!kw || list.some((k) => k.toLowerCase() === kw.toLowerCase())) return list;
  return [...list, kw];
}

// Keywords are optional on the wire; locally they're always a list.
type Settings = NotificationSettings & { keywords: string[] };

export function NotificationsSettings() {
  const { user, patchUser } = useAuth();
  const track = useSaveTracker();
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...user?.notificationSettings,
    keywords: user?.notificationSettings?.keywords ?? [],
  }));
  const [keywordDraft, setKeywordDraft] = useState('');
  const [error, setError] = useState('');
  // Saves run one after another so a burst of toggles can't land out of order;
  // each request carries the full settings snapshot taken at change time.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(settings);

  function update(patch: Partial<Settings>) {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setSettings(next);
    setError('');
    queue.current = queue.current.then(() =>
      track(
        apiFetch<User>('/api/v1/users/me/notification-settings', {
          method: 'PUT',
          body: JSON.stringify(next),
        }),
      ).then(
        (updated) => patchUser({ notificationSettings: updated.notificationSettings ?? next }),
        (err: unknown) =>
          setError(err instanceof Error ? err.message : 'Failed to save notification settings'),
      ),
    );
  }

  function addKeyword() {
    const next = withKeyword(latest.current.keywords, keywordDraft);
    setKeywordDraft('');
    if (next !== latest.current.keywords) update({ keywords: next });
  }

  const differentOnMobile = settings.mobileLevel !== 'default';

  return (
    <>
      {error && (
        <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <SettingsSection title="Notify me about">
        <SettingsRow
          label="Desktop"
          htmlFor="settings-desktop-level"
          hint="Default for every channel. Override per channel from its menu."
        >
          <LevelSelect
            id="settings-desktop-level"
            value={settings.desktopLevel}
            onChange={(v) => update({ desktopLevel: v as NotificationLevel })}
          />
        </SettingsRow>

        <SettingsRow label="Different settings on mobile" hint="Mobile follows desktop unless you turn this on.">
          <Switch
            className={SWITCH_CLASS}
            checked={differentOnMobile}
            aria-label="Different settings on mobile"
            onCheckedChange={(on) =>
              update({ mobileLevel: on ? (settings.desktopLevel as MobileNotificationLevel) : 'default' })
            }
          />
        </SettingsRow>

        {differentOnMobile && (
          <SettingsRow label="Mobile" htmlFor="settings-mobile-level" className="pl-4">
            <LevelSelect
              id="settings-mobile-level"
              value={settings.mobileLevel}
              onChange={(v) => update({ mobileLevel: v as MobileNotificationLevel })}
            />
          </SettingsRow>
        )}

        <SettingsRow
          stacked
          label="Keywords"
          htmlFor="notification-keyword"
          hint="Get notified when a message contains any of these words, even at the Mentions level."
        >
          <div className="flex flex-wrap gap-1.5">
            {settings.keywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center gap-1.5 rounded-full bg-muted py-1 pr-1.5 pl-3 text-[13px]"
                data-testid="keyword-chip"
              >
                {kw}
                <button
                  type="button"
                  onClick={() => update({ keywords: latest.current.keywords.filter((k) => k !== kw) })}
                  aria-label={`Remove keyword ${kw}`}
                  className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              id="notification-keyword"
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              // Don't drop a word the user typed but didn't press Enter for.
              onBlur={addKeyword}
              placeholder="+ Add keyword"
              className="w-40 rounded-full border border-dashed border-border-strong bg-transparent px-3 py-1 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-solid focus-visible:border-foreground/40"
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Threads & mentions">
        <ToggleRow
          label="Replies to threads I follow"
          checked={settings.threadReplies}
          onChange={(on) => update({ threadReplies: on })}
        />
        <ToggleRow
          label="Follow all threads"
          hint="Include threads you haven't joined."
          checked={settings.followAllThreads}
          onChange={(on) => update({ followAllThreads: on })}
        />
        <ToggleRow
          label="Ignore @all and @here"
          checked={settings.ignoreGroupMentions}
          onChange={(on) => update({ ignoreGroupMentions: on })}
        />
      </SettingsSection>

      <DeviceSection />
    </>
  );
}

// The stock "off" track (bg-input) nearly vanishes on the white dialog surface;
// a muted-foreground tint keeps the off state visible in both themes.
const SWITCH_CLASS = 'data-unchecked:bg-muted-foreground/30 dark:data-unchecked:bg-muted-foreground/30';

function LevelSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative shrink-0 mobile:w-full">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-56 cursor-pointer appearance-none rounded-lg border border-border-strong bg-popover pr-8 pl-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 mobile:w-full"
      >
        {DESKTOP_LEVEL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <SettingsRow label={label} hint={hint}>
      <Switch className={SWITCH_CLASS} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </SettingsRow>
  );
}

// DeviceSection holds the CLIENT-side delivery switches (stored per browser,
// not on the account) plus a collapsed Troubleshooting area: the OS permission
// state, a test notification, and the recent-decisions trace. The test bypasses
// the server and exercises the exact last-mile path (permission + popups + OS).
function DeviceSection() {
  const { prefs, setBrowserEnabled, setSoundEnabled, setIdleDetectionEnabled, permission, requestPermission, dispatch } =
    useNotifications();
  const [status, setStatus] = useState('');
  const [idleStatus, setIdleStatus] = useState('');
  // Re-read the trace ring buffer when Troubleshooting is toggled open.
  const [, setTraceTick] = useState(0);

  async function handleIdleDetectionToggle(on: boolean) {
    setIdleStatus('');
    if (!on) {
      setIdleDetectionEnabled(false);
      return;
    }
    // Permission needs this click's user-gesture context.
    const granted = await requestIdleDetectionPermission();
    setIdleDetectionEnabled(granted);
    if (!granted) {
      setIdleStatus('Idle-detection permission was not granted — enable it in your browser’s site settings and try again.');
    }
  }

  async function sendTest() {
    let perm = permission;
    if (perm === 'default') {
      perm = await requestPermission();
    }
    // Unique messageID so cross-tab dedup never swallows the test; kind "mention"
    // and no authorID so the active-view / own-echo suppressions can't drop it.
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
      setStatus('Played the sound, but “Show popups” is off, so no popup appeared.');
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

  const troubleshooting = (
    <details
      data-testid="notification-trace"
      className="group/trouble pt-3"
      onToggle={() => setTraceTick((t) => t + 1)}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 py-1.5 text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-3.5 w-3.5 -rotate-90 transition-transform group-open/trouble:rotate-0" aria-hidden="true" />
        Troubleshooting
      </summary>
      <div className="[&>*+*]:border-t [&>*+*]:border-divider">
        <SettingsRow label="Browser permission">
          <span className="inline-flex items-center gap-1.5" data-testid="notification-permission">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${permission === 'granted' ? 'bg-online' : 'bg-muted-foreground'}`}
            />
            {permissionLabel}
          </span>
        </SettingsRow>
        <SettingsRow
          label="Test notification"
          hint={
            status ? (
              <span role="status" data-testid="test-notification-status">
                {status}
              </span>
            ) : undefined
          }
        >
          <Button type="button" variant="outline" size="sm" onClick={sendTest} data-testid="send-test-notification">
            Send test
          </Button>
        </SettingsRow>
        <div className="py-3">
          <div className="mb-2 font-medium">Recent notification decisions</div>
          {(() => {
            const trace = getNotificationTrace().slice(-20).reverse();
            if (trace.length === 0) {
              return <p className="text-[13px] text-muted-foreground">No notifications processed in this tab yet.</p>;
            }
            return (
              <ul className="space-y-0.5 rounded-lg border bg-sidebar px-3 py-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
                {trace.map((e, i) => (
                  <li key={`${e.at}-${i}`} data-testid="notification-trace-entry">
                    {new Date(e.at).toLocaleTimeString()} {e.step}
                    {e.messageID ? ` ${e.messageID}` : ''}
                    {e.detail ? ` ${JSON.stringify(e.detail)}` : ''}
                  </li>
                ))}
              </ul>
            );
          })()}
        </div>
      </div>
    </details>
  );

  return (
    <SettingsSection
      title="On this device"
      footer={troubleshooting}
    >
      <ToggleRow
        label="Show popups"
        checked={prefs.browserEnabled}
        onChange={(on) => {
          setBrowserEnabled(on);
          if (on && permission === 'default') void requestPermission();
        }}
      />
      <ToggleRow label="Play a sound" checked={prefs.soundEnabled} onChange={(on) => setSoundEnabled(on)} />
      {idleDetectionSupported() && (
        <SettingsRow label="Send to phone when I'm away" hint="Detects screen lock and idle time on this browser.">
          <Switch
            className={SWITCH_CLASS}
            checked={prefs.idleDetectionEnabled}
            aria-label="Send to phone when I'm away"
            onCheckedChange={(on) => {
              void handleIdleDetectionToggle(on);
            }}
          />
        </SettingsRow>
      )}
      {idleStatus && (
        <p className="py-3 text-[13px] text-muted-foreground" role="status" data-testid="idle-detection-status">
          {idleStatus}
        </p>
      )}
    </SettingsSection>
  );
}
