import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys, parentPath } from '@/lib/query-keys';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { MessageItem } from './MessageItem';
import { SidePanel } from './SidePanel';
import type { Message } from '@/types';
import type { UserMapEntry } from './MessageList';

interface PinnedPanelProps {
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  onClose: () => void;
  userMap: Record<string, UserMapEntry>;
  currentUserId?: string;
  // Opening a thread from a pinned row dismisses the pinned panel and
  // installs the thread side panel for that root message. Owners
  // (ChannelView / ConversationView) wire this to their openThread()
  // helper, which already closes other side panels.
  onReplyInThread?: (messageID: string) => void;
}

export function PinnedPanel({
  channelId,
  channelSlug,
  conversationId,
  onClose,
  userMap,
  currentUserId,
  onReplyInThread,
}: PinnedPanelProps) {
  const path = parentPath({ channelId, conversationId });
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.pinned(path),
    queryFn: async () => {
      const res = await apiFetch<Message[]>(`/api/v1/${path}/pinned`);
      return Array.isArray(res) ? res : [];
    },
    enabled: !!(channelId || conversationId),
  });

  // MessageItem expects a `userMap.get(id)` accessor — same shape the
  // MessageList builds. Without it, every reaction tooltip reads
  // "Unknown" because the lookup falls through.
  const userLookup = useMemo(
    () => ({ get: (id: string) => userMap[id] }),
    [userMap],
  );

  // Navigate to the pinned message in its host view. The URL hash drives
  // useDeepLinkAnchor → MessageList scrolls + flashes the highlight ring.
  // Thread replies route through ?thread=ROOT so the host view replaces
  // this pinned panel with the thread panel and highlights both the
  // parent (in the main list) and the reply (inside the thread panel).
  function jumpToMessage(msg: Message) {
    if (channelId && channelSlug) {
      navigate(buildChannelHref(channelSlug, msg.id, msg.parentMessageID));
    } else if (conversationId) {
      navigate(buildConversationHref(conversationId, msg.id, msg.parentMessageID));
    }
  }

  return (
    <SidePanel
      title="Pinned messages"
      ariaLabel="Pinned messages"
      closeLabel="Close pinned messages"
      onClose={onClose}
    >
      <div className="space-y-2">
        {isLoading && (
          <p className="p-2 text-xs text-muted-foreground">Loading pinned messages...</p>
        )}
        {!isLoading && (data?.length ?? 0) === 0 && (
          <p data-testid="pinned-empty" className="p-2 text-xs text-muted-foreground">
            Nothing pinned yet. Pin a message to keep it handy.
          </p>
        )}
        {data?.map((msg) => {
          const u = userMap[msg.authorID];
          // Wrapping the row in a real <button> would be invalid HTML
          // (MessageItem renders its own buttons inside). div+role=button
          // gives us the same focus/click affordance without nesting,
          // and lets nested buttons (Reply in thread, reactions, kebab)
          // capture their own clicks before our row handler runs.
          return (
            <div
              key={msg.id}
              role="button"
              tabIndex={0}
              data-testid="pinned-message-row"
              onClick={(e) => {
                // If the click originated on a nested interactive
                // element, that handler already ran — don't also
                // navigate away.
                const target = e.target as HTMLElement | null;
                if (target?.closest('button, [role="menuitem"], a')) return;
                jumpToMessage(msg);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                jumpToMessage(msg);
              }}
              className="block w-full rounded text-left hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
            >
              <MessageItem
                message={msg}
                authorName={u?.displayName ?? 'Unknown'}
                authorAvatarURL={u?.avatarURL}
                authorOnline={u?.online}
                isOwn={msg.authorID === currentUserId}
                channelId={channelId}
                channelSlug={channelSlug}
                conversationId={conversationId}
                currentUserId={currentUserId}
                userMap={userLookup}
                onReplyInThread={onReplyInThread}
              />
            </div>
          );
        })}
      </div>
    </SidePanel>
  );
}
