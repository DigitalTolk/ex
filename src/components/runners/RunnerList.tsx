import { useState } from 'react';
import { CircleAlert, CircleCheck, Laptop, LockKeyhole, LockKeyholeOpen, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoTip } from '@/components/ui/info-tip';
import { Skeleton } from '@/components/ui/skeleton';
import { useRevokeRunnerToken, type RunnerHarness, type RunnerInstall } from '@/hooks/useRunnerTokens';
import { formatRelative } from '@/lib/format';
import { harnessLabel, harnessVersion, osLabel } from '@/lib/runner-labels';

// What a connection is locked to, as a glyph whose tooltip says so.
const DEVICE_LOCKS = {
  hardware: { Icon: ShieldCheck, text: "Locked to this computer's secure chip" },
  software: { Icon: LockKeyhole, text: 'Locked to a key on this computer' },
  none: { Icon: LockKeyholeOpen, text: 'Update ex-runner and run ex-runner login again to lock this connection to the computer' },
} as const;

function DeviceLock({ runner }: { runner: RunnerInstall }) {
  const lock = DEVICE_LOCKS[runner.deviceKey || 'none'];
  return (
    <span className="inline-flex align-middle" data-testid={`runner-lock-${runner.id}`}>
      <InfoTip label="this connection's lock" icon={lock.Icon}>
        {lock.text}
      </InfoTip>
    </span>
  );
}

function HarnessChip({ harness }: { harness: RunnerHarness }) {
  const name = harnessLabel(harness.name);
  return (
    <Badge variant="outline" className="gap-1 font-normal" data-testid={`runner-harness-${harness.name}`}>
      {harness.authed ? (
        <CircleCheck className="text-online" aria-hidden="true" />
      ) : (
        <CircleAlert className="text-muted-foreground" aria-hidden="true" />
      )}
      {harness.authed ? `${name}${harness.version ? ` ${harnessVersion(harness.version)}` : ''}` : `${name} · not signed in`}
    </Badge>
  );
}

function RunnerRow({
  runner,
  isThisComputer,
  onDisconnect,
}: {
  runner: RunnerInstall;
  isThisComputer: boolean;
  onDisconnect: (r: RunnerInstall) => void;
}) {
  const meta = [
    runner.online && runner.os ? osLabel(runner.os) : null,
    runner.online && runner.version ? `ex-runner ${runner.version}` : null,
    runner.lastUsedAt ? `Last used ${formatRelative(runner.lastUsedAt)}${runner.lastIP ? ` from ${runner.lastIP}` : ''}` : null,
    `Connected ${new Date(runner.createdAt).toLocaleDateString()}`,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid={`runner-row-${runner.id}`}>
      <Laptop className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate text-sm font-medium">{runner.label}</p>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid={`runner-status-${runner.id}`}>
            <span
              className={`h-2 w-2 rounded-full ${runner.online ? 'bg-online' : 'bg-muted-foreground/40'}`}
              aria-hidden="true"
            />
            {runner.online ? 'Online' : 'Offline'}
          </span>
          {isThisComputer && <Badge variant="secondary">This computer</Badge>}
        </div>
        <p className="text-xs text-muted-foreground" data-testid={`runner-meta-${runner.id}`}>
          {meta.join(' · ')} <DeviceLock runner={runner} />
        </p>
        {runner.online && (runner.harnesses?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {runner.harnesses!.map((h) => (
              <HarnessChip key={h.name} harness={h} />
            ))}
          </div>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={() => onDisconnect(runner)} data-testid={`runner-disconnect-${runner.id}`}>
        Disconnect
      </Button>
    </li>
  );
}

// RunnerList shows the caller's connected computers — online or not, which
// agent CLIs each found, and a Disconnect for each. Shared by the Runners
// tab and the account menu's Runners dialog.
export function RunnerList({
  runners,
  isLoading,
  error,
  thisComputerID,
}: {
  runners: RunnerInstall[] | undefined;
  isLoading: boolean;
  error: Error | null;
  // The install the desktop app on this computer is connected with.
  thisComputerID?: string | null;
}) {
  const revoke = useRevokeRunnerToken();
  const [confirming, setConfirming] = useState<RunnerInstall | null>(null);

  return (
    <div className="space-y-3">
      {isLoading && (
        <div className="space-y-2 rounded-lg border p-4" role="status">
          <span className="sr-only">Loading your computers…</span>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          Couldn't load your computers: {error.message}
        </p>
      )}
      {runners && runners.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No computers are connected yet.
        </p>
      )}
      {runners && runners.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60" data-testid="runners-list">
          {runners.map((r) => (
            <RunnerRow key={r.id} runner={r} isThisComputer={r.id === thisComputerID} onDisconnect={setConfirming} />
          ))}
        </ul>
      )}
      {revoke.error && (
        <p className="text-sm text-destructive" role="alert">
          Couldn't disconnect: {revoke.error.message}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          open
          // The dialog only ever asks to close (cancel, confirm, Escape).
          onOpenChange={() => setConfirming(null)}
          title={`Disconnect ${confirming.label}?`}
          description="Agents stop running on that computer right away. To use it again, connect it from the Runners tab or run ex-runner login there."
          confirmLabel="Disconnect"
          destructive
          testIDPrefix="runner-disconnect-confirm"
          onConfirm={() => revoke.mutate(confirming.id)}
        />
      )}
    </div>
  );
}
