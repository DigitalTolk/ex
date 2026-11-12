import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { IncomingWebhook, InteractionStatus, InteractionTestResult } from '@/types';

const base = (id: string) => `/api/v1/admin/webhooks/${encodeURIComponent(id)}/interactivity`;
const statusKey = (id: string) => ['webhook-interactivity', id] as const;

// useInteractivity loads a webhook's interactivity — settings, pause and
// recent interactions — while its section is open.
export function useInteractivity(id: string, enabled: boolean) {
  return useQuery({
    queryKey: statusKey(id),
    queryFn: () => apiFetch<InteractionStatus>(base(id)),
    enabled,
  });
}

// Every change answers with the webhook as it now is: the status and the
// webhook list both refresh.
function useInteractivityChange<In, Out>(id: string, run: (input: In) => Promise<Out>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: statusKey(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.incomingWebhooks() });
    },
  });
}

export function useSetRequestURL(id: string) {
  return useInteractivityChange(id, (requestURL: string) =>
    apiFetch<IncomingWebhook>(`${base(id)}/request-url`, { method: 'PUT', body: JSON.stringify({ requestURL }) }),
  );
}

// useRotateCredential issues a bot token or signing secret; the answer holds
// the value, shown this once.
export function useRotateCredential(id: string, kind: 'bot-token' | 'signing-secret') {
  return useInteractivityChange(id, (revokeNow: boolean) =>
    apiFetch<{ token?: string; secret?: string; webhook: IncomingWebhook }>(`${base(id)}/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ revokeNow }),
    }),
  );
}

export function useSetInteractivitySwitch(id: string, which: 'email-sharing' | 'paused') {
  return useInteractivityChange(id, (enabled: boolean) =>
    apiFetch<IncomingWebhook>(`${base(id)}/${which}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  );
}

export function useSendTestInteraction(id: string) {
  return useInteractivityChange(id, () => apiFetch<InteractionTestResult>(`${base(id)}/test`, { method: 'POST' }));
}
