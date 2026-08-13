import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

// The bot admin API is snake_case, matching Mattermost's integration APIs, so
// tooling written against MM reads these responses without translation.
// callback_secret is never serialized — the shared secret is returned once, at
// the moment the webhook is set.
export interface Bot {
  user_id: string;
  name: string;
  description?: string;
  created_by: string;
  create_at: string;
  update_at: string;
  callback_url?: string;
  /** Event wire format for callback_url: MM's form-encoded payload, or ex's signed JSON. */
  transport?: 'ex' | 'mattermost';
  /** Words that fire the bot without an @mention (MM's outgoing-webhook trigger model). */
  trigger_words?: string[];
  /** 0 = message must start with the trigger word (default), 1 = anywhere in the message. */
  trigger_when?: 0 | 1;
}

export interface BotToken {
  token_id: string;
  bot_user_id: string;
  label?: string;
  create_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

/** A freshly issued token — carries its plaintext exactly once. */
export interface IssuedToken extends BotToken {
  token: string;
}

export function useBots() {
  return useQuery({
    queryKey: queryKeys.bots(),
    queryFn: async () => {
      const res = await apiFetch<Bot[]>('/api/v1/admin/bots');
      return Array.isArray(res) ? res : [];
    },
  });
}

export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      apiFetch<Bot>('/api/v1/admin/bots', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots() }),
  });
}

export function useDeleteBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      // Fail loudly on a missing id instead of requesting ".../undefined", which
      // the server answers with a 404 that looks like "the bot won't delete".
      if (!id) return Promise.reject(new Error('Missing bot id — reload the page and try again.'));
      return apiFetch<void>(`/api/v1/admin/bots/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots() }),
  });
}

export interface SetBotWebhookInput {
  id: string;
  callback_url: string;
  /** 'mattermost' sends MM's form-encoded outgoing-webhook payload; 'ex' (default) sends signed JSON. */
  transport?: 'ex' | 'mattermost';
  trigger_words?: string[];
  trigger_when?: 0 | 1;
}

/** Set (or clear, with an empty url) a bot's outgoing-webhook config. The
 * response reveals the shared secret ONCE so the operator can configure the
 * receiver — it verifies X-Ex-Signature under the 'ex' transport and is the
 * body's `token` under 'mattermost'. It's never returned again. */
export function useSetBotWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SetBotWebhookInput) =>
      apiFetch<{ ok: boolean; signing_secret: string }>(
        `/api/v1/admin/bots/${encodeURIComponent(id)}/webhook`,
        { method: 'PUT', body: JSON.stringify(body) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots() }),
  });
}

export function useBotTokens(botID: string) {
  return useQuery({
    queryKey: queryKeys.botTokens(botID),
    queryFn: async () => {
      const res = await apiFetch<BotToken[]>(`/api/v1/admin/bots/${encodeURIComponent(botID)}/tokens`);
      return Array.isArray(res) ? res : [];
    },
    enabled: Boolean(botID),
  });
}

export function useCreateBotToken(botID: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      apiFetch<IssuedToken>(`/api/v1/admin/bots/${encodeURIComponent(botID)}/tokens`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.botTokens(botID) }),
  });
}

export function useRevokeBotToken(botID: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenID: string) =>
      apiFetch<void>(
        `/api/v1/admin/bots/${encodeURIComponent(botID)}/tokens/${encodeURIComponent(tokenID)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.botTokens(botID) }),
  });
}
