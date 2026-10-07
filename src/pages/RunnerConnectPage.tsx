import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useCreateRunnerGrant } from '@/hooks/useRunnerTokens';
import { rememberReturnTo } from '@/lib/return-to';
import { callbackUrl, parseConnectRequest, runnerConnectNav } from '@/lib/runner-connect';

type Phase = 'ask' | 'connected' | 'cancelled';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 px-4">
      <main className="w-full max-w-md space-y-5 rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {children}
      </main>
    </div>
  );
}

// RunnerConnectPage is where `ex-runner login` sends the browser: the
// signed-in user approves (or refuses) running their agents on that machine.
// It handles its own sign-in redirect instead of sitting behind
// ProtectedRoute, so it can remember itself and come back after login.
export default function RunnerConnectPage() {
  useDocumentTitle('Connect ex-runner');
  const { user, isAuthenticated, isLoading } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const grant = useCreateRunnerGrant();
  const [phase, setPhase] = useState<Phase>('ask');
  const request = parseConnectRequest(params);

  if (!request) {
    return (
      <Shell title="This link isn't valid">
        <p className="text-sm text-muted-foreground">
          It may be incomplete or from an older version. Run <code>ex-runner login</code> again on the computer you
          want to connect, and use the link it opens.
        </p>
      </Shell>
    );
  }

  if (isLoading) {
    return (
      <Shell title="Connect ex-runner">
        <p className="text-sm text-muted-foreground" role="status">
          Checking your sign-in…
        </p>
      </Shell>
    );
  }

  if (!isAuthenticated) {
    return (
      <Shell title="Sign in to connect ex-runner">
        <p className="text-sm text-muted-foreground">
          Sign in to the account whose agents should run on <strong>{request.name}</strong>. You'll come straight
          back here.
        </p>
        <Button
          className="w-full"
          onClick={() => {
            rememberReturnTo(location.pathname + location.search);
            navigate('/login');
          }}
        >
          Sign in
        </Button>
      </Shell>
    );
  }

  if (phase === 'connected') {
    return (
      <Shell title="ex-runner is connected">
        <p className="text-sm text-muted-foreground">
          Finishing in your terminal. Start it there with <code>ex-runner start</code>; you can close this tab.
        </p>
      </Shell>
    );
  }

  if (phase === 'cancelled') {
    return (
      <Shell title="Cancelled">
        <p className="text-sm text-muted-foreground">Nothing was connected. You can close this tab.</p>
      </Shell>
    );
  }

  async function connect() {
    const res = await grant.mutateAsync({ challenge: request!.challenge, label: request!.name }).catch(() => null);
    if (!res) return; // grant.error renders below
    setPhase('connected');
    runnerConnectNav.leaveFor(callbackUrl(request!, { code: res.code }));
  }

  function cancel() {
    setPhase('cancelled');
    runnerConnectNav.leaveFor(callbackUrl(request!, { error: 'access_denied' }));
  }

  return (
    <Shell title="Connect ex-runner?">
      <p className="text-sm">
        <strong>{request.name}</strong> wants to run your agents.
      </p>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          Your Claude Code and Codex agents will run on that computer, with your access as {user?.displayName}, when
          you ask them to.
        </li>
        <li>
          Only continue if you just ran <code>ex-runner login</code> on that computer yourself.
        </li>
        <li>You can disconnect it any time under Runners in your account menu.</li>
      </ul>
      {grant.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          Couldn't connect: {grant.error.message}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={cancel} disabled={grant.isPending}>
          Cancel
        </Button>
        <Button onClick={() => void connect()} disabled={grant.isPending} data-testid="runner-connect-approve">
          {grant.isPending ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </Shell>
  );
}
