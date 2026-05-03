import { useMemo, useState } from 'react';
import { ChevronDown, Loader2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmojiPicker } from '@/components/EmojiPicker';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, getAccessToken } from '@/lib/api';
import type { User } from '@/types';

interface UserStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ClearAfter = 'never' | 'today' | '30m' | '1h' | 'custom';

const PRESETS: Array<{ text: string; emoji: string; clearAfter: ClearAfter }> = [
  { text: 'On Vacation', emoji: ':palm_tree:', clearAfter: 'never' },
  { text: 'Out Sick', emoji: ':face_thermo:', clearAfter: 'today' },
  { text: 'Working from home', emoji: ':house:', clearAfter: 'today' },
  { text: 'Out for Lunch', emoji: ':sandwich:', clearAfter: '30m' },
  { text: 'In a meeting', emoji: ':spiral_calendar:', clearAfter: '1h' },
];
const CUSTOM_PRESET = '__custom__';
const MAX_STATUS_TEXT_LENGTH = 32;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function partsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function inputValueForDate(date: Date, timeZone: string): string {
  const p = partsInTimeZone(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function defaultCustomUntil(timeZone: string): string {
  return inputValueForDate(new Date(Date.now() + 60 * 60_000), timeZone);
}

function inputValueForISO(iso: string, timeZone: string): string {
  return inputValueForDate(new Date(iso), timeZone);
}

function zonedInputToISO(value: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const desiredUTC = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute);
  let guess = desiredUTC;
  for (let i = 0; i < 2; i += 1) {
    const actual = partsInTimeZone(new Date(guess), timeZone);
    const actualUTC = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    guess += desiredUTC - actualUTC;
  }
  return new Date(guess).toISOString();
}

function clearAtFor(mode: ClearAfter, customUntil: string, timeZone: string): string | undefined {
  const now = new Date();
  if (mode === 'never') return undefined;
  if (mode === '30m') return new Date(now.getTime() + 30 * 60_000).toISOString();
  if (mode === '1h') return new Date(now.getTime() + 60 * 60_000).toISOString();
  if (mode === 'today') {
    const today = partsInTimeZone(now, timeZone);
    return zonedInputToISO(`${today.year}-${pad(today.month)}-${pad(today.day)}T23:59`, timeZone);
  }
  return zonedInputToISO(customUntil, timeZone);
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}

function initialStateFor(user: User | null) {
  const timeZone = user?.timeZone || localTimeZone();
  const status = user?.userStatus;
  const matchedPreset = status ? PRESETS.find((p) => p.text === status.text && p.emoji === status.emoji) : undefined;
  return {
    emoji: status?.emoji ?? ':speech_balloon:',
    text: status?.text ?? '',
    clearAfter: matchedPreset?.clearAfter ?? (status?.clearAt ? 'custom' : 'never') as ClearAfter,
    preset: matchedPreset?.text ?? CUSTOM_PRESET,
    customUntil: status?.clearAt ? inputValueForISO(status.clearAt, timeZone) : defaultCustomUntil(timeZone),
  };
}

export function UserStatusDialog({ open, onOpenChange }: UserStatusDialogProps) {
  const { user, setAuth } = useAuth();
  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <UserStatusDialogContent
          key={`${user.id}:${user.userStatus?.emoji ?? ''}:${user.userStatus?.text ?? ''}:${user.userStatus?.clearAt ?? ''}`}
          user={user}
          setAuth={setAuth}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  );
}

function UserStatusDialogContent({
  user,
  setAuth,
  onOpenChange,
}: {
  user: User;
  setAuth: (token: string, user: User) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const initialState = initialStateFor(user);
  const [emoji, setEmoji] = useState(initialState.emoji);
  const [text, setText] = useState(initialState.text);
  const [clearAfter, setClearAfter] = useState<ClearAfter>(initialState.clearAfter);
  const [preset, setPreset] = useState(initialState.preset);
  const [customUntil, setCustomUntil] = useState(initialState.customUntil);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const userTimeZone = user?.timeZone || localTimeZone();

  const previewStatus = useMemo(
    () => ({ emoji, text, clearAt: clearAtFor(clearAfter, customUntil, userTimeZone) }),
    [emoji, text, clearAfter, customUntil, userTimeZone],
  );

  async function applyUpdated(updated: User) {
    const token = getAccessToken();
    if (token) setAuth(token, updated);
    onOpenChange(false);
  }

  async function saveStatus() {
    setError('');
    if (!emoji.trim() || !text.trim()) {
      setError('Choose an emoji and status text.');
      return;
    }
    if ([...text.trim()].length > MAX_STATUS_TEXT_LENGTH) {
      setError('Status text must be 32 characters or fewer.');
      return;
    }
    setSaving(true);
    try {
      const updated = await apiFetch<User>('/api/v1/users/me/status', {
        method: 'PATCH',
        body: JSON.stringify({
          emoji,
          text: text.trim(),
          clearAt: clearAtFor(clearAfter, customUntil, userTimeZone),
          timeZone: localTimeZone(),
        }),
      });
      setSaving(false);
      await applyUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save status');
      setSaving(false);
    }
  }

  async function clearStatus() {
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<User>('/api/v1/users/me/status', {
        method: 'DELETE',
        body: JSON.stringify({ timeZone: localTimeZone() }),
      });
      setSaving(false);
      await applyUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear status');
      setSaving(false);
    }
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Set status</DialogTitle>
      </DialogHeader>
      <div className="min-h-[340px] space-y-4" data-testid="user-status-dialog-body">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="status-preset">Predefined status</Label>
          <div className="relative">
            <select
              id="status-preset"
              value={preset}
              onChange={(e) => {
                const value = e.target.value;
                setPreset(value);
                const selected = PRESETS.find((p) => p.text === value);
                if (!selected) return;
                setEmoji(selected.emoji);
                setText(selected.text);
                setClearAfter(selected.clearAfter);
              }}
              className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm"
            >
              <option value={CUSTOM_PRESET}>Custom status</option>
              {PRESETS.map((p) => (
                <option key={p.text} value={p.text}>{p.text}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>

        <div className="grid grid-cols-[auto_1fr] items-end gap-3">
          <div className="space-y-2">
            <Label>Emoji</Label>
            <EmojiPicker
              onSelect={(nextEmoji) => {
                setEmoji(nextEmoji);
                setPreset(CUSTOM_PRESET);
              }}
              trigger={(
                <Button type="button" variant="outline" size="icon" aria-label="Choose status emoji">
                  <EmojiGlyph emoji={emoji} />
                </Button>
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="status-text">Status text</Label>
            <Input
              id="status-text"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPreset(CUSTOM_PRESET);
              }}
              maxLength={MAX_STATUS_TEXT_LENGTH}
              placeholder="What's your status?"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="clear-after">Remove status after</Label>
          <div className="relative">
            <select
              id="clear-after"
              value={clearAfter}
              onChange={(e) => {
                setClearAfter(e.target.value as ClearAfter);
                setPreset(CUSTOM_PRESET);
              }}
              className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm"
            >
              <option value="never">Don't clear</option>
              <option value="today">Today</option>
              <option value="30m">30 minutes</option>
              <option value="1h">1 hour</option>
              <option value="custom">Custom time</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
        {clearAfter === 'custom' && (
          <Input
            type="datetime-local"
            value={customUntil}
            onChange={(e) => setCustomUntil(e.target.value)}
            aria-label="Custom clear time"
          />
        )}

        {text.trim() && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm">
            <span className="text-muted-foreground">Preview</span>
            <UserStatusIndicator status={previewStatus} />
            <span className="truncate">{text}</span>
          </div>
        )}

        <div className="flex justify-between gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={clearStatus} disabled={saving || !user.userStatus}>
            <X className="mr-2 h-4 w-4" />
            Clear status
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={saveStatus} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save status
            </Button>
          </div>
        </div>
      </div>
    </DialogContent>
  );
}
