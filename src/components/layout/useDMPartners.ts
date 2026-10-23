import { useMemo } from 'react';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import type { UserConversation } from '@/types';

// dmPartnerID is the other participant of a 1:1 DM — or its only one, for a
// DM with yourself.
export function dmPartnerID(conversation: UserConversation, selfID: string | undefined): string | undefined {
  return (conversation.participantIDs ?? []).find((p) => p !== selfID) ?? conversation.participantIDs?.[0];
}

// useDMPartners fetches the other participant of every listed DM in one batch
// so the sidebar can render real avatars instead of just initials. A DM whose
// profile the server already resolved needs no lookup, and group DMs use a
// participant-count badge instead.
export function useDMPartners(conversations: UserConversation[], selfID: string | undefined) {
  const partnerIDs = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const c of conversations) {
      if (c.type !== 'dm') continue;
      if (c.profileResolved) continue;
      const other = dmPartnerID(c, selfID);
      if (other && !seen.has(other)) {
        seen.add(other);
        ids.push(other);
      }
    }
    return ids;
  }, [conversations, selfID]);
  return useUsersBatch(partnerIDs).map;
}
