import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MonitorCog } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Skeleton } from '@/components/ui/skeleton';
import { RunnerList } from '@/components/runners/RunnerList';
import { RunnerSetupSteps } from '@/components/runners/RunnerSetupSteps';
import { ThisComputerCard } from '@/components/runners/ThisComputerCard';
import { useAuth } from '@/context/AuthContext';
import { useDesktopRunner } from '@/hooks/useDesktopRunner';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useRunnerTokens } from '@/hooks/useRunnerTokens';
import { useWorkspaceSettings } from '@/hooks/useSettings';

// While the page is open, re-check which computers are online: a runner
// going offline has no event (its lease just lapses).
const ONLINE_POLL_MS = 30_000;

// RunnersPage is the AI hub's Runners tab: the computers that run the
// caller's Claude Code and Codex agents. Inside the desktop app it can set up
// and run ex-runner on this computer; everywhere it lists the connected
// computers and shows the command-line setup for others. It exists only
// while an admin has "Runners in the app" turned on.
export default function RunnersPage() {
  useDocumentTitle('Runners');
  const { data: settings, isLoading } = useWorkspaceSettings();
  const enabled = settings?.runnersInApp === true;

  return (
    <PageContainer
      title="Runners"
      description="Computers that run your Claude Code and Codex agents. Bedrock agents run on the server and need none."
    >
      {isLoading && <Skeleton className="h-40 w-full" />}
      {!isLoading && !enabled && <TurnedOff />}
      {enabled && <RunnersBody />}
    </PageContainer>
  );
}

function TurnedOff() {
  const { user } = useAuth();
  return (
    <div className="py-12 text-center text-muted-foreground" data-testid="runners-off">
      <MonitorCog className="mx-auto mb-3 h-8 w-8" aria-hidden="true" />
      <p>Runners in the app are turned off for this workspace.</p>
      {user?.systemRole === 'admin' ? (
        <p className="mt-1 text-sm">
          Turn them on in{' '}
          <Link className="underline" to="/admin/agents">
            Admin → Agents
          </Link>
          .
        </p>
      ) : (
        <p className="mt-1 text-sm">An admin can turn them on. Until then, set up ex-runner from your account menu's Runners.</p>
      )}
    </div>
  );
}

function RunnersBody() {
  const { available, state } = useDesktopRunner();
  const { data: runners, isLoading, error } = useRunnerTokens(true, ONLINE_POLL_MS);
  const ownInstalls = useMemo(() => (runners ? new Set(runners.map((r) => r.id)) : null), [runners]);
  const desktop = available && state?.supported === true;
  const thisComputerID = desktop && state?.connection ? state.connection.tokenId : null;

  return (
    <div className="space-y-7">
      {desktop && state && <ThisComputerCard state={state} ownInstalls={ownInstalls} />}
      {available && state && !state.supported && (
        <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground" data-testid="runners-unsupported">
          This version of the ex app can't run ex-runner itself. Use the command-line setup below on this computer, or any other.
        </p>
      )}

      <section className="space-y-3" aria-labelledby="your-computers">
        <h2 id="your-computers" className="text-sm font-semibold">
          Your computers
        </h2>
        <RunnerList runners={runners} isLoading={isLoading} error={error} thisComputerID={thisComputerID} />
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-5" aria-labelledby="runner-setup">
        <div>
          <h2 id="runner-setup" className="text-base font-semibold">
            {desktop ? 'Connect another computer' : 'Connect a computer'}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            From a terminal on that computer. It keeps running in the background, even with ex closed.
          </p>
        </div>
        <RunnerSetupSteps />
      </section>
    </div>
  );
}
