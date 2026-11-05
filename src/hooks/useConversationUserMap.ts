import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useMessagePageUserIDs } from '@/hooks/useMessagePageUserIDs';
import { useEqualValue } from '@/hooks/useEqualValue';
import { sameUserMap } from '@/lib/user-map-equal';
import type { UserMapEntry } from '@/components/chat/MessageList';
import type { Message } from '@/types';

// useConversationUserMap: who a conversation's rows are by — its people and
// every author on the loaded pages (walked per page, and only the page an
// event changed: useMessagePageUserIDs), with you from your own session.
export function useConversationUserMap(pages: { items: Message[] }[] | undefined, participantIDs: string[] | undefined) {
  const { user } = useAuth();
  const userIDs = useMessagePageUserIDs(pages, participantIDs);
  const { data: users } = useUsersBatch(userIDs);
  const built = useMemo(() => {
    const m: Record<string, UserMapEntry> = {};
    if (user) m[user.id] = { displayName: user.displayName, avatarURL: user.avatarURL, userStatus: user.userStatus };
    if (users) {
      for (const u of users) {
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, userStatus: u.userStatus };
      }
    }
    return m;
  }, [user, users]);
  // Rebuilt with the same entries it keeps its identity (see ChannelView).
  return { userMap: useEqualValue(built, sameUserMap), users };
}
