import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys, parentPath } from '@/lib/query-keys';
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
}

export function PinnedPanel({
  channelId,
  channelSlug,
  conversationId,
  onClose,
  userMap,
  currentUserId,
}: PinnedPanelProps) {
  const path = parentPath({ channelId, conversationId });

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.pinned(path),
    queryFn: () => apiFetch<Message[]>(`/api/v1/${path}/pinned`),
    enabled: !!(channelId || conversationId),
  });

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
          return (
            <MessageItem
              key={msg.id}
              message={msg}
              authorName={u?.displayName ?? 'Unknown'}
              authorAvatarURL={u?.avatarURL}
              authorOnline={u?.online}
              isOwn={msg.authorID === currentUserId}
              channelId={channelId}
              channelSlug={channelSlug}
              conversationId={conversationId}
              currentUserId={currentUserId}
            />
          );
        })}
      </div>
    </SidePanel>
  );
}
