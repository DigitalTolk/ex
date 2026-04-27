import { useRef, useCallback, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import { useMessageDeepLinkHighlight } from '@/hooks/useMessageDeepLinkHighlight';
import { dayKey, formatDayHeading } from '@/lib/format';
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
  channelSlug?: string;
  conversationId?: string;
  userMap: Record<string, UserMapEntry>;
  onReplyInThread?: (messageID: string) => void;
  // Rendered at the top of the list once we've paged back to the very first
  // message (hasNextPage is false). Owners pass the variant that matches the
  // parent kind: ChannelIntro / DMIntro / SelfDMIntro / GroupIntro.
  intro?: ReactNode;
}

export function MessageList({
  pages,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  fetchNextPage,
  currentUserId,
  channelId,
  channelSlug,
  conversationId,
  userMap,
  onReplyInThread,
  intro,
}: MessageListProps) {
  useMessageDeepLinkHighlight([channelId, conversationId, isLoading, pages.length]);
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

  // The intro renders at the very top of the message list — but only once
  // we've paged back to the start (no older messages remaining). This
  // mirrors how chat apps reveal "this is the beginning of …" only when
  // the user actually reaches the beginning.
  if (intro && !hasNextPage) {
    elements.push(<div key="intro">{intro}</div>);
  }

  for (const msg of allMessages) {
    // Skip thread replies in the main list (they live in the ThreadPanel)
    if (msg.parentMessageID) continue;

    const msgDate = dayKey(msg.createdAt);
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      elements.push(
        <div
          key={`date-${msgDate}`}
          data-testid="day-divider"
          className="flex items-center gap-3 py-2"
          role="separator"
        >
          <div className="flex-1 border-t border-border" />
          <span className="text-xs font-medium text-muted-foreground">
            {formatDayHeading(msg.createdAt)}
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
          channelSlug={channelSlug}
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
        {elements}
        {allMessages.length === 0 && (
          <p
            data-testid="empty-message-list"
            className="py-8 text-center text-muted-foreground"
          >
            No messages yet. Start the conversation!
          </p>
        )}
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
