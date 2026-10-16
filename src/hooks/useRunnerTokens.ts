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
