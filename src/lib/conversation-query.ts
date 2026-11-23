import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Conversation } from '@/types';

// conversationQuery is the one definition of "load a conversation": the DM
// view (useConversation) and the composer's @-list read the same cache entry.
// It lives outside the hooks modules, which tests mock wholesale.
export function conversationQuery(conversationId: string | undefined) {
  return {
    queryKey: queryKeys.conversation(conversationId ?? ''),
    // Coerce a 204/empty body to null — a queryFn must never resolve undefined.
    queryFn: async () => (await apiFetch<Conversation>(`/api/v1/conversations/${conversationId}`)) ?? null,
    enabled: !!conversationId,
  };
}
