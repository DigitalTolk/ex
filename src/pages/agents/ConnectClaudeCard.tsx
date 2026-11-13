import type { ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnectWorkbench, useRunnerTokens, useWorkbenchStatus, type WorkbenchJob } from '@/hooks/useRunnerTokens';
import { showToast } from '@/lib/toast';

// ConnectClaudeCard offers Connect to Claude until the person has a runner
// on the agent workbench: one click and ex asks the workbench to set one up
// for them, so their Claude Code agents run without a computer of their own.
// While the workbench works on it the card follows its progress; once it is
// done the card goes away.
export function ConnectClaudeCard() {
  const { data: runners } = useRunnerTokens();
  const installed = runners?.some((r) => r.workbench) === true;
  const status = useWorkbenchStatus(installed);
  const connect = useConnectWorkbench();

  if (!runners) return null;
  if (!installed) {
    const onConnect = () =>
      connect.mutate(undefined, { onError: (err) => showToast(err.message || "Couldn't connect to Claude.") });
    return (
      <Card
        title="Run your agents on the agent workbench"
        text="Nothing to install: ex sets up a runner for you there, signed in to Claude."
        action={
          <Button onClick={onConnect} disabled={connect.isPending}>
            {connect.isPending ? (
              <LoaderCircle className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="mr-1 h-4 w-4" aria-hidden="true" />
            )}
            {connect.isPending ? 'Connecting…' : 'Connect to Claude'}
          </Button>
        }
      />
    );
  }
  if (status.error) {
    return <Card title="Connecting to Claude" text={status.error.message} alert />;
  }
  const job = status.data;
  if (!job || job.state === 'done') return null;
  if (job.state === 'failed') {
    return (
      <Card
        title="Setting up your runner failed"
        text={`${statusText(job) ?? "The agent workbench couldn't set you up."} To try again, disconnect "Agent workbench" from your runners.`}
        alert
      />
    );
  }
  return (
    <Card
      title="Connecting to Claude"
      text={job.state === 'queued' ? 'Waiting for the agent workbench to start setting up your runner.' : 'The agent workbench is setting up your runner.'}
      busy
    />
  );
}

// statusText is the workbench's own explanation, when it gave one in words.
function statusText(job: WorkbenchJob): string | null {
  return typeof job.status === 'string' && job.status.trim() !== '' ? job.status.trim() : null;
}

function Card({ title, text, action, busy, alert }: { title: string; text: string; action?: ReactNode; busy?: boolean; alert?: boolean }) {
  return (
    <section
      aria-labelledby="connect-claude"
      aria-busy={busy || undefined}
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
      data-testid="connect-claude"
    >
      {busy && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
      {alert && <CircleAlert className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <h2 id="connect-claude" className="text-sm font-semibold">
          {title}
        </h2>
        <p className={`mt-0.5 text-sm ${alert ? 'text-destructive' : 'text-muted-foreground'}`} role={alert ? 'alert' : undefined}>
          {text}
        </p>
      </div>
      {action}
    </section>
  );
}
