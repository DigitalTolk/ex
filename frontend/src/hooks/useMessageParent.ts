import { useMemo } from 'react';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';

export interface MessageParent {
  label: string;
  href: string;
}

// useMessageParent resolves a message's parentId against the user's
// own sidebar caches and returns a label + deep-link href ready for a
// search hit's "in ~channel"/"in DM-name" decoration. Returns
// undefined when the user no longer has access to the parent.
export function useMessageParent(
  parentId: string,
  msgId?: string,
  threadRoot?: string,
): MessageParent | undefined {
  const { data: userChannels = [] } = useUserChannels();
  const { data: userConversations = [] } = useUserConversations();
  return useMemo(() => {
    const ch = userChannels.find((c) => c.channelID === parentId);
    if (ch) {
      return {
        label: `~${ch.channelName}`,
        href: buildChannelHref(ch.channelName, msgId, threadRoot),
      };
    }
    const conv = userConversations.find((c) => c.conversationID === parentId);
    if (conv) {
      return {
        label: conv.displayName || 'Direct message',
        href: buildConversationHref(parentId, msgId, threadRoot),
      };
    }
    return undefined;
  }, [userChannels, userConversations, parentId, msgId, threadRoot]);
}
