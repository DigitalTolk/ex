import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { clearChannelUnreadInCache, clearConversationUnreadInCache } from '@/lib/unread-cache';
import type { ActiveParent } from '@/stores/active-parent';

// markParentRead is THE read write for a channel or conversation — the open
// view's read session (useParentChat) and a message read as it arrives
// (ChatPage) both go through it. It drops the badge in the list cache at
// once, then persists the read so it stays cleared on a reload. The cleared
// row is what the server now holds too, so the list is not fetched again: on
// a large account that refetch read every channel the user is in. A failed
// PUT is not surfaced: the next read retries it, and a reload shows the
// server's count.
export function markParentRead(queryClient: QueryClient, parent: ActiveParent): Promise<void> {
  if (parent.kind === 'channel') clearChannelUnreadInCache(queryClient, parent.id);
  else clearConversationUnreadInCache(queryClient, parent.id);
  const path = parent.kind === 'channel' ? 'channels' : 'conversations';
  return apiFetch<void>(`/api/v1/${path}/${encodeURIComponent(parent.id)}/read`, { method: 'PUT' }).catch(
    () => undefined,
  );
}
