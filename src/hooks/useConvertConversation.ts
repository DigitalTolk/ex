import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Channel, UserConversation } from '@/types';

// A group message that became a private channel: off the list of direct
// messages, the channel onto the channel list.
export function forgetConvertedConversation(qc: QueryClient, conversationID: string): void {
  qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), (list) =>
    list?.filter((c) => c.conversationID !== conversationID),
  );
  qc.invalidateQueries({ queryKey: queryKeys.userConversations() });
  qc.invalidateQueries({ queryKey: queryKeys.userChannels() });
  // Its threads are the channel's now.
  qc.invalidateQueries({ queryKey: queryKeys.threadPagesAll() });
}

// followConvertedConversation handles someone making a group message a
// private channel: it leaves the direct messages, and whoever has the group
// open carries on in the channel, at the same message or thread.
export function followConvertedConversation(
  qc: QueryClient,
  converted: { conversationID: string; slug: string },
  navigate: NavigateFunction,
  at: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
): void {
  forgetConvertedConversation(qc, converted.conversationID);
  if (at.pathname === `/conversation/${converted.conversationID}`) {
    navigate(`/channel/${converted.slug}${at.search}${at.hash}`, { replace: true });
  }
}

// useConvertConversation turns a group message into a private channel named
// `name`, with everyone in it and all of its history.
export function useConvertConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationID, name }: { conversationID: string; name: string }) =>
      apiFetch<Channel>(`/api/v1/conversations/${encodeURIComponent(conversationID)}/convert`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: (_channel, { conversationID }) => forgetConvertedConversation(qc, conversationID),
  });
}
