import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { IncomingWebhook } from '@/types';

export interface CreateIncomingWebhookInput {
  title: string;
  description?: string;
  channelID: string;
  lockToChannel: boolean;
  username?: string;
  profileImageURL?: string;
}

export function useIncomingWebhooks() {
  return useQuery({
    queryKey: queryKeys.incomingWebhooks(),
    queryFn: async () => {
      const res = await apiFetch<IncomingWebhook[]>('/api/v1/admin/webhooks');
      return Array.isArray(res) ? res : [];
    },
  });
}

export function useCreateIncomingWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIncomingWebhookInput) =>
      apiFetch<IncomingWebhook>('/api/v1/admin/webhooks', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.incomingWebhooks() }),
  });
}

export function useUpdateIncomingWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CreateIncomingWebhookInput }) =>
      apiFetch<IncomingWebhook>(`/api/v1/admin/webhooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.incomingWebhooks() }),
  });
}

export function useDeleteIncomingWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.incomingWebhooks() }),
  });
}
