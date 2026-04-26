import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { MessageItem } from './MessageItem';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
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
  const parentPath = channelId
    ? `channels/${channelId}`
    : `conversations/${conversationId}`;

  const { data, isLoading } = useQuery({
    queryKey: ['pinned', parentPath],
    queryFn: () => apiFetch<Message[]>(`/api/v1/${parentPath}/pinned`),
    enabled: !!(channelId || conversationId),
  });

  return (
    <aside className="w-[28rem] border-l flex flex-col" aria-label="Pinned messages">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Pinned messages</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close pinned messages"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {isLoading && (
          <p className="text-xs text-muted-foreground p-2">Loading pinned messages...</p>
        )}
        {!isLoading && (data?.length ?? 0) === 0 && (
          <p data-testid="pinned-empty" className="text-xs text-muted-foreground p-2">
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
    </aside>
  );
}
