import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { holdRead, setUnreadAnchor, threadReadKey } from '@/lib/read-position';
import { setChannelUnreadCountInCache, setConversationUnreadCountInCache } from '@/lib/unread-cache';
import { showToast } from '@/lib/toast';
import { markThreadSeen } from '@/hooks/useThreads';
import type { MarkUnreadResult, UserState } from '@/types';

export interface MarkUnreadInput {
  parentID: string;
  parentType: 'channel' | 'conversation';
  messageID: string;
}

// useMarkUnread makes a message — and everything after it — unread again. The
// server decides what that means (see MessageService.MarkUnread): a top-level
// message rewinds the chat, a thread reply re-opens the thread. Either way the
// chat stays unread while the user is still in it (holdRead) and the "New
// messages" line moves to the message.
export function useMarkUnread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parentID, parentType, messageID }: MarkUnreadInput) =>
      apiFetch<MarkUnreadResult>(
        `/api/v1/${parentType === 'channel' ? 'channels' : 'conversations'}/${encodeURIComponent(parentID)}/messages/${encodeURIComponent(messageID)}/unread`,
        { method: 'PUT' },
      ),
    onSuccess: (res) => applyMarkUnread(qc, res),
    onError: () => {
      showToast("Couldn't mark the message unread — please try again.");
    },
  });
}

export function applyMarkUnread(qc: QueryClient, res: MarkUnreadResult): void {
  if (res.threadRootID && res.seenAt) {
    const root = res.threadRootID;
    const seenAt = res.seenAt;
    holdRead(threadReadKey(root));
    setUnreadAnchor(threadReadKey(root), { kind: 'message', messageID: res.messageID }, { replace: true });
    // Rewind this device's seen time and the cached server state together,
    // so the thread reads as unread here at once (the merge keeps the newer
    // of the two, and a mark beats a seen time from before it); the
    // notification flag is what lists it as unread in Threads.
    markThreadSeen(root, seenAt);
    qc.setQueryData<UserState>(queryKeys.userState(), (prev) =>
      prev
        ? {
            ...prev,
            threadSeen: { ...prev.threadSeen, [root]: seenAt },
            threadMarkedUnread: { ...prev.threadMarkedUnread, [root]: new Date().toISOString() },
            threadNotifications: prev.threadNotifications.includes(root)
              ? prev.threadNotifications
              : [...prev.threadNotifications, root],
          }
        : prev,
    );
    // A thread the user never posted in joins their Threads list now.
    void qc.invalidateQueries({ queryKey: queryKeys.userThreads() });
    return;
  }
  holdRead(res.parentID);
  setUnreadAnchor(res.parentID, { kind: 'message', messageID: res.messageID }, { replace: true });
  if (res.parentType === 'channel') setChannelUnreadCountInCache(qc, res.parentID, res.unreadCount);
  else setConversationUnreadCountInCache(qc, res.parentID, res.unreadCount);
}
