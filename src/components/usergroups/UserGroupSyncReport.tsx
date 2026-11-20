import { useUserGroupSyncStatus } from '@/hooks/useUserGroups';
import { formatRelative } from '@/lib/format';

// What each department-value anomaly means, in a phrase.
const ANOMALY_TEXT: Record<string, string> = {
  'non-standard-dash': 'a dash other than "-"',
  spacing: 'a missing space',
  'second-separator': 'more than one " - "',
  'empty-squad': 'an empty squad',
  'duplicate-squad': 'a squad listed twice',
  semicolon: 'squads separated by ";"',
  'empty-squad-list': 'nothing after the dash',
  'no-department': 'no department before the dash',
  'too-many-squads': 'more than 20 squads',
};

// UserGroupSyncReport tells admins how the groups' sync from Microsoft 365
// went: when it last ran, whether it held, and the department values it read
// only partly (fix them in Microsoft 365).
export function UserGroupSyncReport() {
  const { data: status } = useUserGroupSyncStatus(true);
  if (!status) return null;
  const { anomalies } = status;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="usergroup-sync-report">
      <p className="text-muted-foreground">
        Groups follow each person's Microsoft 365 department ("Department - Squad, Squad") and sync every 30 minutes.{' '}
        {status.lastSyncedAt ? `Last sync ${formatRelative(status.lastSyncedAt)}.` : 'Not synced yet.'}
      </p>
      {status.held && (
        <p role="status">
          Microsoft 365 returned far fewer departments than the sync before, so this sync was paused. The next one applies if it reads
          the same.
        </p>
      )}
      {anomalies.people > 0 && (
        <details>
          <summary className="cursor-pointer">
            {anomalies.people} {anomalies.people === 1 ? 'person has a department' : 'people have a department'} ex couldn't fully read
          </summary>
          <ul className="mt-2 space-y-1" aria-label="Department values read only partly">
            {anomalies.examples.map((ex) => (
              <li key={ex.value}>
                <code className="rounded bg-muted px-1">{ex.value || '(empty)'}</code> · {ex.kinds.map((k) => ANOMALY_TEXT[k] ?? k).join(', ')} ·{' '}
                {ex.people} {ex.people === 1 ? 'person' : 'people'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
