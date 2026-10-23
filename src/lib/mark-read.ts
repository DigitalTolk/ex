import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { clearChannelUnreadInCache, clearConversationUnreadInCache } from '@/lib/unread-cache';
import type { ActiveParent } from '@/stores/active-parent';

// markParentRead is THE read write for a channel or conversation — the open
// view's read session (useParentChat) and a message read as it arrives
// (ChatPage) both go through it. It drops the badge in the list cache at
// once, then persists the read so it stays cleared on a reload. A failed PUT
// is not surfaced: the next read retries it, and a reload shows the server's
// count. `refreshList` refetches the list afterwards so its count is the
// server's — opening a chat wants that; reading each arriving message would
// refetch the list per message.
export function markParentRead(
  queryClient: QueryClient,
  parent: ActiveParent,
  { refreshList = false }: { refreshList?: boolean } = {},
): Promise<void> {
  if (parent.kind === 'channel') clearChannelUnreadInCache(queryClient, parent.id);
  else clearConversationUnreadInCache(queryClient, parent.id);
  const path = parent.kind === 'channel' ? 'channels' : 'conversations';
  const put = apiFetch<void>(`/api/v1/${path}/${encodeURIComponent(parent.id)}/read`, { method: 'PUT' }).catch(
    () => undefined,
  );
  if (!refreshList) return put;
  return put.finally(() => {
    void queryClient.invalidateQueries({
      queryKey: parent.kind === 'channel' ? queryKeys.userChannels() : queryKeys.userConversations(),
    });
  });
}
