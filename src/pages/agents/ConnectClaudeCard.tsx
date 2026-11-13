import { LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnectWorkbench, useRunnerTokens } from '@/hooks/useRunnerTokens';
import { showToast } from '@/lib/toast';

// ConnectClaudeCard offers Connect to Claude until the person has a runner
// on the agent workbench: one click and ex sets one up for them there, so
// their Claude Code agents run without a computer of their own.
export function ConnectClaudeCard() {
  const { data: runners } = useRunnerTokens();
  const connect = useConnectWorkbench();

  if (!runners || runners.some((r) => r.workbench)) return null;

  const onConnect = () =>
    connect.mutate(undefined, {
      onSuccess: () => showToast('Connected to Claude. Your agents can run on the agent workbench now.', 'success'),
      // A toast, not text on the card: a failed setup still lists the
      // workbench runner, which takes the card away.
      onError: (err) => showToast(err.message || "Couldn't connect to Claude."),
    });

  return (
    <section
      aria-labelledby="connect-claude"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
      data-testid="connect-claude"
    >
      <div className="min-w-0 flex-1">
        <h2 id="connect-claude" className="text-sm font-semibold">
          Run your agents on the agent workbench
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Nothing to install: ex sets up a runner for you there, signed in to Claude.
        </p>
      </div>
      <Button onClick={onConnect} disabled={connect.isPending}>
        {connect.isPending ? (
          <LoaderCircle className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Sparkles className="mr-1 h-4 w-4" aria-hidden="true" />
        )}
        {connect.isPending ? 'Connecting…' : 'Connect to Claude'}
      </Button>
    </section>
  );
}
