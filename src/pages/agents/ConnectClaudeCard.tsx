import { useEffect, useState, type ReactNode } from 'react';
import { Check, Circle, CircleAlert, CloudCheck, LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiError } from '@/lib/api';
import { harnessLabel, harnessVersion, osLabel } from '@/lib/runner-labels';
import {
  useConnectWorkbench,
  useRevokeRunnerToken,
  useRunnerTokens,
  useWorkbenchStatus,
  WORKBENCH_POLL_MS,
  type RunnerInstall,
  type WorkbenchJob,
} from '@/hooks/useRunnerTokens';

// While the workbench runner is set up but not online yet, the Runners list
// is re-checked: a runner coming online sends no event.
function pollUntilOnline(runners: RunnerInstall[] | undefined): number | false {
  const install = runners?.find((r) => r.workbench);
  return install && !install.online ? WORKBENCH_POLL_MS : false;
}

type StepState = 'done' | 'active' | 'todo';

// ConnectClaudeCard offers Connect to Claude until the person has a runner
// on the agent workbench: one click and ex asks the workbench to set one up
// for them, so their Claude Code agents run without a computer of their own.
// While that happens the card walks through the steps; it is finished when
// the runner is online, which the Runners list says. From then on the card
// is that runner: online, what it runs, and a Disconnect.
export function ConnectClaudeCard() {
  const { data: runners, refetch: refetchRunners } = useRunnerTokens(true, pollUntilOnline);
  const install = runners?.find((r) => r.workbench);
  const status = useWorkbenchStatus(!!install && !install.online);
  const finished = status.data?.state === 'done';
  // The workbench is done: look for the runner now rather than at the next check.
  useEffect(() => {
    if (finished) void refetchRunners();
  }, [finished, refetchRunners]);
  const connect = useConnectWorkbench();

  if (!runners) return null;

  if (install?.online) return <Connected install={install} />;

  const job = status.data;
  if (install && job?.state === 'failed') {
    return (
      <Card
        icon={<CircleAlert className="h-5 w-5 text-destructive" aria-hidden="true" />}
        title="Couldn't connect to Claude"
        action={<RetryButton connect={connect} replace={install.id} label="Try again" />}
      >
        <p className="text-sm text-muted-foreground" role="alert">
          {statusText(job) ?? "The agent workbench couldn't set up your runner."}
        </p>
        {/* A refused setup is this card already; any other error is the retry's own. */}
        <ConnectError error={refused(connect.error) ? null : connect.error} />
      </Card>
    );
  }

  if (!install && !connect.isPending) {
    return (
      <Card
        icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
        title="Connect to Claude"
        action={<Button onClick={() => connect.mutate(undefined)}>Connect to Claude</Button>}
      >
        <p className="text-sm text-muted-foreground">
          Get a runner on the agent workbench, signed in to Claude. Nothing to install, and your agents keep working
          when your computer is off.
        </p>
        <ConnectError error={connect.error} />
      </Card>
    );
  }

  // Setting up: asked for, then on the workbench, then waiting to come online.
  const steps: Array<{ label: string; state: StepState; hint?: string }> = [
    { label: 'Ask the agent workbench for a runner', state: install ? 'done' : 'active' },
    {
      label: 'Set up your runner',
      state: !install ? 'todo' : job?.state === 'done' ? 'done' : 'active',
      hint: job?.state === 'queued' ? 'Waiting for the workbench to start' : undefined,
    },
    { label: 'Bring it online', state: job?.state === 'done' ? 'active' : 'todo' },
  ];
  const stuck = !!install && (job?.state === 'done' || !!status.error);
  return (
    <Card
      busy
      icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
      title="Connecting to Claude"
      action={stuck ? <RetryButton connect={connect} replace={install.id} label="Start over" variant="ghost" /> : undefined}
    >
      <p className="text-sm text-muted-foreground">This keeps going if you leave the page.</p>
      <ol className="mt-3 space-y-2" aria-label="Setup steps">
        {steps.map((s) => (
          <Step key={s.label} {...s} />
        ))}
      </ol>
      {status.error && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Can't reach the agent workbench to check on it. Still trying.
        </p>
      )}
    </Card>
  );
}

// Connected is the workbench runner once it is online, in one line: what
// it is, what it runs, and a way to let it go.
function Connected({ install }: { install: RunnerInstall }) {
  const revoke = useRevokeRunnerToken();
  const [confirming, setConfirming] = useState(false);
  const details = [
    'Agent workbench',
    install.os ? osLabel(install.os) : null,
    install.version ? `ex-runner ${install.version}` : null,
    ...(install.harnesses ?? []).map(
      (h) => `${harnessLabel(h.name)}${h.version ? ` ${harnessVersion(h.version)}` : ''}${h.authed ? '' : ' (not signed in)'}`,
    ),
  ].filter(Boolean);
  return (
    <Card
      icon={<CloudCheck className="h-5 w-5" aria-hidden="true" />}
      title={
        <>
          Connected to Claude
          <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-online" aria-hidden="true" />
            Online
          </span>
        </>
      }
      action={
        <Button variant="outline" onClick={() => setConfirming(true)} disabled={revoke.isPending}>
          Disconnect
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">{details.join(' · ')}</p>
      {revoke.error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          Couldn't disconnect: {revoke.error.message}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={() => setConfirming(false)}
        title="Disconnect the agent workbench?"
        description="Agents stop running on the agent workbench right away. To use it again, connect to Claude here."
        confirmLabel="Disconnect"
        destructive
        testIDPrefix="workbench-disconnect-confirm"
        onConfirm={() => revoke.mutate(install.id)}
      />
    </Card>
  );
}

function Step({ label, state, hint }: { label: string; state: StepState; hint?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm" aria-current={state === 'active' ? 'step' : undefined} data-state={state}>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {state === 'done' && <Check className="h-4 w-4 text-foreground" aria-hidden="true" />}
        {state === 'active' && <LoaderCircle className="h-4 w-4 animate-spin text-foreground" aria-hidden="true" />}
        {state === 'todo' && <Circle className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
      </span>
      <span className={state === 'todo' ? 'text-muted-foreground' : 'text-foreground'}>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </li>
  );
}

function RetryButton({
  connect,
  replace,
  label,
  variant,
}: {
  connect: ReturnType<typeof useConnectWorkbench>;
  replace: string;
  label: string;
  variant?: 'ghost';
}) {
  return (
    <Button variant={variant} onClick={() => connect.mutate(replace)} disabled={connect.isPending}>
      {label}
    </Button>
  );
}

function ConnectError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p className="mt-2 text-sm text-destructive" role="alert">
      {error.message || "Couldn't connect to Claude."}
    </p>
  );
}

// refused is the workbench turning the setup down, which the failed card
// already says.
function refused(err: Error | null): boolean {
  return err instanceof ApiError && err.status === 424;
}

// statusText is the workbench's own explanation, when it gave one in words.
function statusText(job: WorkbenchJob): string | null {
  return typeof job.status === 'string' && job.status.trim() !== '' ? job.status.trim() : null;
}

function Card({
  icon,
  title,
  action,
  busy,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="connect-claude"
      aria-busy={busy || undefined}
      className="mb-4 flex flex-wrap items-start gap-3 rounded-lg border bg-card p-4"
      data-testid="connect-claude"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 id="connect-claude" className="text-sm font-semibold">
          {title}
        </h2>
        <div className="mt-0.5">{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </section>
  );
}
