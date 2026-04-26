import { useRef, useCallback, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

export interface UserMapEntry {
  displayName: string;
  avatarURL?: string;
  online?: boolean;
}

interface MessageListProps {
  pages: { items: Message[] }[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  fetchNextPage: () => void;
  currentUserId?: string;
  channelId?: string;
  conversationId?: string;
  userMap: Record<string, UserMapEntry>;
  onReplyInThread?: (messageID: string) => void;
}

function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function MessageList({
  pages,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  fetchNextPage,
  currentUserId,
  channelId,
  conversationId,
  userMap,
  onReplyInThread,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    // placeholder for future scroll-based logic (e.g. mark-as-read)
  }, []);

  if (isLoading) {
    return (
      <div className="flex-1 p-4 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const allMessages = pages.flatMap((p) => p.items).reverse();

  // Group by date for separators
  let lastDate = '';
  const elements: ReactNode[] = [];

  for (const msg of allMessages) {
    // Skip thread replies in the main list (they live in the ThreadPanel)
    if (msg.parentMessageID) continue;

    const msgDate = new Date(msg.createdAt).toDateString();
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      elements.push(
        <div
          key={`date-${msgDate}`}
          className="flex items-center gap-3 py-2"
          role="separator"
        >
          <div className="flex-1 border-t border-border" />
          <span className="text-xs font-medium text-muted-foreground">
            {formatDateSeparator(msg.createdAt)}
          </span>
          <div className="flex-1 border-t border-border" />
        </div>,
      );
    }

    if (msg.system) {
      elements.push(
        <div
          key={msg.id}
          className="flex justify-center py-1"
          role="status"
        >
          <span className="text-xs italic text-muted-foreground">
            {msg.body}
          </span>
        </div>,
      );
    } else {
      const u = userMap[msg.authorID];
      elements.push(
        <MessageItem
          key={msg.id}
          message={msg}
          authorName={u?.displayName ?? 'Unknown'}
          authorAvatarURL={u?.avatarURL}
          authorOnline={u?.online}
          isOwn={msg.authorID === currentUserId}
          channelId={channelId}
          conversationId={conversationId}
          currentUserId={currentUserId}
          onReplyInThread={onReplyInThread}
        />,
      );
    }
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col-reverse" ref={scrollRef} onScroll={handleScroll}>
      <div className="p-4 space-y-1">
        {allMessages.length === 0 && (
          <p className="py-8 text-center text-muted-foreground">
            No messages yet. Start the conversation!
          </p>
        )}
        {elements}
      </div>
      {hasNextPage && (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" onClick={fetchNextPage} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading...' : 'Load earlier messages'}
          </Button>
        </div>
      )}
    </div>
  );
}
