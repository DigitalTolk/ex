import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

// One agent CLI a runner found on its computer, and whether it is signed in.
export interface RunnerHarness {
  name: string;
  version?: string;
  authed: boolean;
}

// One connected ex-runner install, as the Runners dialog and tab show it.
// The token itself never leaves the server. The live fields describe the
// runner process signed in with it, and are empty while it is offline.
export interface RunnerInstall {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  online?: boolean;
  os?: string;
  version?: string;
  harnesses?: RunnerHarness[];
  // The install ex set up on the agent workbench (Connect to Claude).
  workbench?: boolean;
}

const RUNNER_TOKENS_KEY = queryKeys.runnerTokens();

// useRunnerTokens lists the caller's connected computers. A runner going
// offline has no event (its lease just lapses), so a page that shows online
// status passes pollMs to re-check while it is open.
export function useRunnerTokens(enabled = true, pollMs?: number) {
  return useQuery({
    queryKey: RUNNER_TOKENS_KEY,
    enabled,
    refetchInterval: pollMs,
    queryFn: async () => {
      const res = await apiFetch<{ runners: RunnerInstall[] }>('/api/v1/runner-tokens');
      return res?.runners ?? [];
    },
  });
}

export function useRevokeRunnerToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/api/v1/runner-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: RUNNER_TOKENS_KEY }),
  });
}

// useCreateRunnerGrant is the Connect button on /runner/connect: the signed-in
// user approves this pairing and gets the one-time code for ex-runner.
export function useCreateRunnerGrant() {
  return useMutation({
    mutationFn: async (input: { challenge: string; label: string }) =>
      apiFetch<{ code: string; expiresAt: string }>('/api/v1/runner-tokens/grants', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

// How the agent workbench is setting up the caller's runner. state is
// queued, running, done or failed; status and result are the workbench's
// own words, whatever shape they take.
export interface WorkbenchJob {
  id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: unknown;
  result?: unknown;
}

const WORKBENCH_POLL_MS = 3000;

// useWorkbenchStatus follows the setup while it is queued or running. It
// sits under the Runners key, so anything that refetches the Runners list
// (connecting, disconnecting) refetches this too.
export function useWorkbenchStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.workbenchStatus(),
    enabled,
    queryFn: async () => (await apiFetch<WorkbenchJob>('/api/v1/runner-tokens/workbench')) ?? null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'running' ? WORKBENCH_POLL_MS : false;
    },
  });
}

// useConnectWorkbench is Connect to Claude: the server issues a runner token
// and hands it to the agent workbench, which queues setting up ex-runner for
// the caller. The token never comes to the browser. Either way the Runners
// list is refetched: a failed setup still lists its install, and a 409 means
// another tab already connected.
export function useConnectWorkbench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => apiFetch<WorkbenchJob>('/api/v1/runner-tokens/workbench', { method: 'POST' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: RUNNER_TOKENS_KEY }),
  });
}
