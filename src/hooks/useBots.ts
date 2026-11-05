import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { BotAccount, BotToken, BotTokenIssued } from '@/types/generated';

// Bot accounts and their access tokens, on the admin page. Every change also
// arrives as bot.changed (ChatPage), so other admins' lists follow.

export interface BotInput {
  username: string;
  displayName: string;
  description: string;
}

const botPath = (id: string) => `/api/v1/admin/bots/${encodeURIComponent(id)}`;

export function useBots() {
  return useQuery({
    queryKey: queryKeys.bots(),
    queryFn: async () => {
      const res = await apiFetch<BotAccount[]>('/api/v1/admin/bots');
      return Array.isArray(res) ? res : [];
    },
  });
}

export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BotInput) =>
      apiFetch<BotAccount>('/api/v1/admin/bots', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots() }),
  });
}

export function useUpdateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BotInput }) =>
      apiFetch<BotAccount>(botPath(id), { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots() }),
  });
}

export function useSetBotEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<BotAccount>(`${botPath(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots() }),
  });
}

export function useBotTokens(botID: string) {
  return useQuery({
    queryKey: queryKeys.botTokens(botID),
    queryFn: async () => {
      const res = await apiFetch<BotToken[]>(`${botPath(botID)}/tokens`);
      return Array.isArray(res) ? res : [];
    },
  });
}

export function useCreateBotToken(botID: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (description: string) =>
      apiFetch<BotTokenIssued>(`${botPath(botID)}/tokens`, { method: 'POST', body: JSON.stringify({ description }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.botTokens(botID) }),
  });
}

export function useRevokeBotToken(botID: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenID: string) =>
      apiFetch<void>(`${botPath(botID)}/tokens/${encodeURIComponent(tokenID)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.botTokens(botID) }),
  });
}
