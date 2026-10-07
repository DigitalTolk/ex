import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRevokeRunnerToken, useRunnerTokens, type RunnerInstall } from '@/hooks/useRunnerTokens';

const EX_RUNNER_README = 'https://github.com/DigitalTolk/ex-runners#install';

interface RunnersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// RunnersDialog lists the computers connected with ex-runner — where the
// user's Claude Code and Codex agents run — and disconnects them. Bedrock
// agents run on the server and need none of this.
export function RunnersDialog({ open, onOpenChange }: RunnersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" mobileCloseLabel="Close">
        <DialogHeader>
          <DialogTitle>Runners</DialogTitle>
          <DialogDescription>
            Computers that run your Claude Code and Codex agents. Bedrock agents run on the server and need no runner.
          </DialogDescription>
        </DialogHeader>
        {open && <RunnersBody />}
      </DialogContent>
    </Dialog>
  );
}

function SetupSteps() {
  const login = `ex-runner login ${window.location.origin}`;
  return (
    <div className="space-y-2 text-sm">
      <p>
        To connect a computer,{' '}
        <a className="underline" href={EX_RUNNER_README} target="_blank" rel="noreferrer">
          install ex-runner
        </a>{' '}
        on it, then run:
      </p>
      {[login, 'ex-runner start'].map((cmd) => (
        <div key={cmd} className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
          <code className="truncate">{cmd}</code>
          <CopyButton value={cmd} label={`Copy "${cmd}"`} size="icon" variant="ghost" />
        </div>
      ))}
    </div>
  );
}

function RunnersBody() {
  const { data: runners, isLoading, error } = useRunnerTokens();
  const revoke = useRevokeRunnerToken();
  const [confirming, setConfirming] = useState<RunnerInstall | null>(null);

  return (
    <div className="space-y-4">
      {isLoading && (
        <p className="text-sm text-muted-foreground" role="status">
          Loading…
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          Couldn't load your runners: {error.message}
        </p>
      )}
      {runners && runners.length === 0 && (
        <p className="text-sm text-muted-foreground">No computers are connected yet.</p>
      )}
      {runners && runners.length > 0 && (
        <ul className="divide-y rounded-md border" data-testid="runners-list">
          {runners.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.label}</p>
                <p className="text-xs text-muted-foreground">
                  Connected {new Date(r.createdAt).toLocaleDateString()} · sign-in renews automatically while it runs
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setConfirming(r)} data-testid={`runner-disconnect-${r.id}`}>
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoke.error && (
        <p className="text-sm text-destructive" role="alert">
          Couldn't disconnect: {revoke.error.message}
        </p>
      )}
      <SetupSteps />
      {confirming && (
        <ConfirmDialog
          open
          // The dialog only ever asks to close (cancel, confirm, Escape).
          onOpenChange={() => setConfirming(null)}
          title={`Disconnect ${confirming.label}?`}
          description="Agents stop running on that computer right away. To use it again, run ex-runner login there."
          confirmLabel="Disconnect"
          destructive
          testIDPrefix="runner-disconnect-confirm"
          onConfirm={() => revoke.mutate(confirming.id)}
        />
      )}
    </div>
  );
}
