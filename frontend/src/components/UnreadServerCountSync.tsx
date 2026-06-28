import { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';

// UnreadServerCountSync reconciles the UnreadContext per-target unread counts to
// the authoritative server seq counts whenever the userChannels /
// userConversations lists change (initial load, reconnect refetch,
// userchannel.updated invalidation). It renders nothing; it just keeps the
// single source of truth (the context count maps) in step with the server so
// the sidebar badges and tab title reflect the real unread count instead of a
// drifting session delta. Mounted once at the app root, alongside the title
// bridge, so the maps are seeded for every consumer regardless of route.
export function UnreadServerCountSync() {
  const { isAuthenticated } = useAuth();
  const { data: channels } = useUserChannels({ enabled: isAuthenticated });
  const { data: conversations } = useUserConversations({ enabled: isAuthenticated });
  const { syncServerCounts } = useUnread();

  useEffect(() => {
    const channelCounts = new Map<string, number>();
    for (const c of channels ?? []) channelCounts.set(c.channelID, c.unreadCount ?? 0);
    const conversationCounts = new Map<string, number>();
    for (const c of conversations ?? []) conversationCounts.set(c.conversationID, c.unreadCount ?? 0);
    syncServerCounts(channelCounts, conversationCounts);
  }, [channels, conversations, syncServerCounts]);

  return null;
}
