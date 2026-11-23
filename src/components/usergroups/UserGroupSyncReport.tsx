import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSyncUserGroupsNow, useUserGroupSyncStatus } from '@/hooks/useUserGroups';
import { errorMessage } from '@/lib/error-message';
import { formatRelative } from '@/lib/format';

// The server refuses a Sync now this soon after a run.
const COOLDOWN_MS = 60_000;

// every says how often the sync runs, in the largest whole unit.
function every(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

// UserGroupSyncReport tells admins how the groups' sync from Microsoft 365
// went (when it last ran, whether it failed, which groups it couldn't use)
// and lets them sync at once.
export function UserGroupSyncReport() {
  const { data: status } = useUserGroupSyncStatus(true);
  const syncNow = useSyncUserGroupsNow();
  const [now, setNow] = useState(() => Date.now());
  const finishedAt = status?.finishedAt ? new Date(status.finishedAt).getTime() : 0;
  const coolingFor = finishedAt + COOLDOWN_MS - now;

  // Re-enable the button when the cooldown ends.
  useEffect(() => {
    if (coolingFor <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), coolingFor);
    return () => clearTimeout(timer);
  }, [coolingFor]);

  if (!status) return null;
  if (!status.configured) {
    return (
      <p className="rounded-md border p-3 text-sm text-muted-foreground" data-testid="usergroup-sync-report">
        User groups aren't connected to Microsoft 365.
      </p>
    );
  }

  const running = status.running || syncNow.isPending;
  const cooling = !running && coolingFor > 0;
  let label = 'Sync now';
  if (running) label = 'Syncing…';
  else if (cooling) label = 'Synced just now';

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="usergroup-sync-report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">
          Groups sync from Microsoft 365 {every(status.intervalMinutes)}.{' '}
          {status.lastSyncedAt ? `Last sync ${formatRelative(status.lastSyncedAt)}.` : 'Not synced yet.'}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={running || cooling}
          onClick={() => {
            syncNow.mutate();
            setNow(Date.now());
          }}
        >
          {running && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {label}
        </Button>
      </div>
      {status.lastError && (
        <p className="text-destructive" role="alert">
          Last sync failed: {status.lastError}
        </p>
      )}
      {syncNow.error && (
        <p className="text-destructive" role="alert">
          {errorMessage(syncNow.error, 'Sync failed to start')}
        </p>
      )}
      {status.skipped.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {status.skipped.length} Microsoft 365 {status.skipped.length === 1 ? "group couldn't" : "groups couldn't"} be used as
            they are
          </summary>
          <ul className="mt-2 space-y-1" aria-label="Microsoft 365 groups not used">
            {status.skipped.map((s) => (
              <li key={s.groupId || s.name}>
                <code className="rounded bg-muted px-1">{s.name}</code> · {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
