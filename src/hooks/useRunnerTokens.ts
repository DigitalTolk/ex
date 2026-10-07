import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

// One connected ex-runner install, as the Runners dialog shows it. The token
// itself never leaves the server.
export interface RunnerInstall {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

const RUNNER_TOKENS_KEY = ['runner-tokens'] as const;

export function useRunnerTokens(enabled = true) {
  return useQuery({
    queryKey: RUNNER_TOKENS_KEY,
    enabled,
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
