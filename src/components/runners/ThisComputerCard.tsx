import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Download, EllipsisVertical, Laptop, LoaderCircle, Play, ScrollText, Square } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RunnerLogDialog } from '@/components/runners/RunnerLogDialog';
import { useCreateRunnerGrant } from '@/hooks/useRunnerTokens';
import { queryKeys } from '@/lib/query-keys';
import {
  desktopRunner,
  nextStep,
  updateAvailable,
  type DesktopRunnerState,
  type RunnerStep,
} from '@/lib/desktop-runner';

type Action = 'install' | 'connect' | 'start' | 'stop' | 'autostart' | 'disconnect' | 'uninstall';

// The desktop app rejects beginConnect with exactly this when the person
// says no in its confirmation dialog — a choice, not an error to show.
const CONNECT_CANCELLED = 'cancelled';

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong.');

// ThisComputerCard sets up and runs ex-runner on the computer the desktop
// app is open on: install → connect → run, one step at a time, with the
// controls for each. Nothing installs or runs until the person clicks, and
// "Start when ex opens" is off until they turn it on.
export function ThisComputerCard({
  state,
  ownInstalls,
}: {
  state: DesktopRunnerState;
  // The caller's paired install ids, once the Runners list has loaded.
  ownInstalls: ReadonlySet<string> | null;
}) {
  const queryClient = useQueryClient();
  const grant = useCreateRunnerGrant();
  const [pending, setPending] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'disconnect' | 'uninstall' | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const step = nextStep(state, window.location.origin, ownInstalls);
  const busy = pending !== null || state.busy !== null;

  const act = async (name: Action, fn: () => Promise<void>) => {
    setPending(name);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setPending(null);
    }
  };

  // Connecting: the app starts `ex-runner login --no-browser` (after its own
  // native "connect this computer?" confirmation), this page approves the
  // pairing with the signed-in session, and the app hands the one-time code
  // to the waiting runner. The runner token never passes through here.
  const connect = () =>
    act('connect', async () => {
      const req = await desktopRunner.beginConnect().catch((err: unknown) => {
        if (err instanceof Error && err.message === CONNECT_CANCELLED) return null;
        throw err;
      });
      if (!req) return;
      try {
        const { code } = await grant.mutateAsync({ challenge: req.challenge, label: req.name });
        await desktopRunner.finishConnect(code);
      } catch (err) {
        desktopRunner.cancelConnect().catch(() => {});
        throw err;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.runnerTokens() });
    });

  const shownError = actionError ?? state.error;
  const connected = step.step === 'start' || step.step === 'running';

  return (
    <section className="rounded-lg border bg-card" aria-labelledby="this-computer-title" data-testid="this-computer-card">
      <div className="flex items-start justify-between gap-3 p-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <Laptop className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="this-computer-title" className="text-base font-semibold">
              This computer
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Run your Claude Code and Codex agents here, managed by the ex app.
            </p>
          </div>
        </div>
        <StatusPill state={state} step={step} />
      </div>

      <Stepper step={step} />

      <div className="space-y-3 px-5 pt-4 pb-5">
        <StepBody
          step={step}
          state={state}
          pending={pending}
          busy={busy}
          onInstall={() => act('install', desktopRunner.install)}
          onConnect={connect}
          onStart={() => act('start', desktopRunner.start)}
          onStop={() => act('stop', desktopRunner.stop)}
          onCancelConnect={() => act('connect', desktopRunner.cancelConnect)}
        />
        {shownError && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {shownError}
          </p>
        )}
      </div>

      {state.binary && (
        <div className="space-y-3 border-t px-5 py-4">
          {connected && !state.external && (
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor="runner-autostart">Start when ex opens</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  ex-runner stops when you quit ex. For agents that run while ex is closed, use the command-line setup below.
                </p>
              </div>
              <Switch
                id="runner-autostart"
                checked={state.autoStart}
                disabled={pending === 'autostart'}
                onCheckedChange={(on) => act('autostart', () => desktopRunner.setAutoStart(on))}
                data-testid="runner-autostart"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" data-testid="runner-meta">
              {[
                `ex-runner ${state.binary.version}`,
                state.binary.source === 'app' ? 'installed by ex' : 'installed outside ex',
                state.connection && connected ? `connected as ${state.connection.user}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setLogOpen(true)} data-testid="runner-view-log">
                <ScrollText aria-hidden="true" />
                View log
              </Button>
              <MoreMenu
                state={state}
                disabled={busy}
                onUpdate={() => act('install', desktopRunner.install)}
                onDisconnect={() => setConfirm('disconnect')}
                onUninstall={() => setConfirm('uninstall')}
              />
            </div>
          </div>
        </div>
      )}

      <RunnerLogDialog open={logOpen} onOpenChange={setLogOpen} />
      {confirm === 'disconnect' && (
        <ConfirmDialog
          open
          onOpenChange={() => setConfirm(null)}
          title="Disconnect this computer?"
          description="ex-runner stops here and forgets its sign-in, and the computer leaves your Runners list. You can connect it again any time."
          confirmLabel="Disconnect"
          destructive
          testIDPrefix="this-computer-disconnect"
          onConfirm={() =>
            act('disconnect', async () => {
              await desktopRunner.disconnect();
              void queryClient.invalidateQueries({ queryKey: queryKeys.runnerTokens() });
            })
          }
        />
      )}
      {confirm === 'uninstall' && (
        <ConfirmDialog
          open
          onOpenChange={() => setConfirm(null)}
          title="Remove ex-runner from this computer?"
          description="ex-runner stops and the copy ex installed is deleted. This computer stays connected; install it again to use it."
          confirmLabel="Remove"
          destructive
          testIDPrefix="this-computer-uninstall"
          onConfirm={() => act('uninstall', desktopRunner.uninstall)}
        />
      )}
    </section>
  );
}

function StatusPill({ state, step }: { state: DesktopRunnerState; step: RunnerStep }) {
  let label = 'Not set up';
  let dot = 'bg-muted-foreground/40';
  if (state.process === 'starting') label = 'Starting…';
  else if (state.process === 'stopping') label = 'Stopping…';
  else if (step.step === 'running') {
    label = 'Running';
    dot = 'bg-online';
  } else if (step.step === 'start') label = 'Stopped';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
      data-testid="this-computer-status"
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

const STEPS = [
  { key: 'install', label: 'Install' },
  { key: 'connect', label: 'Connect' },
  { key: 'run', label: 'Run' },
] as const;

// Which of the three steps are done, and which one is current.
function stepIndex(step: RunnerStep): number {
  switch (step.step) {
    case 'install':
    case 'update':
      return 0;
    case 'connect':
      return 1;
    case 'start':
      return 2;
    default:
      return 3;
  }
}

function Stepper({ step }: { step: RunnerStep }) {
  const current = stepIndex(step);
  return (
    <ol className="flex items-center gap-2 px-5" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const done = i < current;
        const isCurrent = !done && i === current;
        return (
          <li key={s.key} className="flex min-w-0 flex-1 items-center gap-2" aria-current={isCurrent ? 'step' : undefined}>
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                done
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : isCurrent
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground'
              }`}
              data-testid={`runner-step-${s.key}`}
              data-state={done ? 'done' : isCurrent ? 'current' : 'todo'}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
            </span>
            <span className={`truncate text-sm ${isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
              {s.label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
            {i < STEPS.length - 1 && <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function Spinner() {
  return <LoaderCircle className="animate-spin" aria-hidden="true" />;
}

function Body({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1 text-sm">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function StepBody({
  step,
  state,
  pending,
  busy,
  onInstall,
  onConnect,
  onStart,
  onStop,
  onCancelConnect,
}: {
  step: RunnerStep;
  state: DesktopRunnerState;
  pending: Action | null;
  busy: boolean;
  onInstall: () => void;
  onConnect: () => void;
  onStart: () => void;
  onStop: () => void;
  onCancelConnect: () => void;
}) {
  if (state.busy === 'installing' || pending === 'install') {
    const pct = state.progress === null ? null : Math.round(state.progress * 100);
    return (
      <Body>
        <p className="flex items-center gap-2 font-medium">
          <Spinner />
          {pct === null ? 'Installing ex-runner…' : `Downloading ex-runner… ${pct}%`}
        </p>
        <div
          className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Installing ex-runner"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct ?? 15}%` }} />
        </div>
      </Body>
    );
  }
  if (state.busy === 'connecting' || pending === 'connect') {
    return (
      <Body
        action={
          // A connect left waiting (the page reloaded mid-way) can be dropped
          // here instead of waiting out ex-runner's own timeout.
          pending === null && (
            <Button variant="outline" onClick={onCancelConnect} data-testid="runner-cancel-connect">
              Cancel
            </Button>
          )
        }
      >
        <p className="flex items-center gap-2 font-medium">
          <Spinner />
          Connecting this computer…
        </p>
        <p className="text-muted-foreground">Confirm in the dialog ex opened, if it asks.</p>
      </Body>
    );
  }

  switch (step.step) {
    case 'install':
      return (
        <Body
          action={
            <Button onClick={onInstall} disabled={busy} data-testid="runner-install">
              <Download aria-hidden="true" />
              Install ex-runner
            </Button>
          }
        >
          <p className="font-medium">Install ex-runner</p>
          <p className="text-muted-foreground">
            A small program from the ex team that runs your agents with the Claude Code or Codex you already use here.
          </p>
        </Body>
      );
    case 'update':
      return state.binary?.source === 'app' ? (
        <Body
          action={
            <Button onClick={onInstall} disabled={busy} data-testid="runner-install">
              <Download aria-hidden="true" />
              Update ex-runner
            </Button>
          }
        >
          <p className="font-medium">Update ex-runner</p>
          <p className="text-muted-foreground">This version ({state.binary.version}) is too old for ex to control.</p>
        </Body>
      ) : (
        <Body
          action={
            <Button onClick={onInstall} disabled={busy} data-testid="runner-install">
              <Download aria-hidden="true" />
              Install ex's own copy
            </Button>
          }
        >
          <p className="font-medium">ex-runner {state.binary?.version} is too old for ex to control</p>
          <p className="text-muted-foreground">
            Update it with <code className="font-mono">brew upgrade ex-runner</code>, or let ex install its own copy.
          </p>
        </Body>
      );
    case 'connect': {
      const copy = {
        new: ['Connect this computer', 'Link it to your account so your agents can run here.', 'Connect this computer'],
        expired: ["This computer's sign-in expired", 'Connect it again to bring your agents back.', 'Connect again'],
        'other-server': [
          'Connected to a different ex server',
          `It runs agents for ${state.connection?.server}. Connect it to this server instead.`,
          'Connect to this server',
        ],
        'not-yours': [
          'Not connected to your account',
          'Its connection was removed, or it runs agents for someone else. Connect it to your account.',
          'Connect to my account',
        ],
      }[step.reason];
      return (
        <Body
          action={
            <Button onClick={onConnect} disabled={busy} data-testid="runner-connect">
              {copy[2]}
            </Button>
          }
        >
          <p className="font-medium">{copy[0]}</p>
          <p className="text-muted-foreground">{copy[1]}</p>
        </Body>
      );
    }
    case 'start':
      return (
        <Body
          action={
            <Button onClick={onStart} disabled={busy || state.process !== 'stopped'} data-testid="runner-start">
              {state.process === 'starting' || pending === 'start' ? <Spinner /> : <Play aria-hidden="true" />}
              Start
            </Button>
          }
        >
          <p className="font-medium">Ready to run</p>
          <p className="text-muted-foreground">Start ex-runner to bring your agents online on this computer.</p>
        </Body>
      );
    default:
      return state.external ? (
        <Body>
          <p className="font-medium">Your agents can run on this computer</p>
          <p className="text-muted-foreground">
            ex-runner is running outside the app — as a Homebrew service or in a terminal. Stop it there, e.g.{' '}
            <code className="font-mono">brew services stop ex-runner</code>.
          </p>
        </Body>
      ) : (
        <Body
          action={
            <Button variant="outline" onClick={onStop} disabled={busy || state.process !== 'running'} data-testid="runner-stop">
              {state.process === 'stopping' || pending === 'stop' ? <Spinner /> : <Square aria-hidden="true" />}
              Stop
            </Button>
          }
        >
          <p className="font-medium">Your agents can run on this computer</p>
          <p className="text-muted-foreground">Mention an agent in a channel and it answers from here.</p>
        </Body>
      );
  }
}

function MoreMenu({
  state,
  disabled,
  onUpdate,
  onDisconnect,
  onUninstall,
}: {
  state: DesktopRunnerState;
  disabled: boolean;
  onUpdate: () => void;
  onDisconnect: () => void;
  onUninstall: () => void;
}) {
  const canUpdate = state.binary?.source === 'app' && updateAvailable(state);
  const canUninstall = state.binary?.source === 'app';
  if (!canUpdate && !state.connection && !canUninstall) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        aria-label="More runner actions"
        disabled={disabled}
        data-testid="runner-more"
      >
        <EllipsisVertical aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canUpdate && (
          <DropdownMenuItem onClick={onUpdate} data-testid="runner-update">
            Update to {state.latestVersion}
          </DropdownMenuItem>
        )}
        {state.connection && (
          <DropdownMenuItem onClick={onDisconnect} data-testid="runner-disconnect-here">
            Disconnect this computer
          </DropdownMenuItem>
        )}
        {canUninstall && (
          <DropdownMenuItem variant="destructive" onClick={onUninstall} data-testid="runner-uninstall">
            Remove ex-runner
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
