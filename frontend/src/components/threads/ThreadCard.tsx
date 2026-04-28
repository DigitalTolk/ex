import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, MessageSquare } from 'lucide-react';
import { MessageItem } from '@/components/chat/MessageItem';
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput';
import { MessageDropZone } from '@/components/chat/MessageDropZone';
import { Skeleton } from '@/components/ui/skeleton';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useSendMessage, type SendMessageInput } from '@/hooks/useMessages';
import { useInView } from '@/hooks/useInView';
import { usePresence } from '@/context/PresenceContext';
import { collectMessageUserIDs } from '@/lib/message-users';
import {
  hasUnreadActivity,
  markThreadSeen,
  useThreadMessages,
  type ThreadSummary,
} from '@/hooks/useThreads';

interface ThreadCardProps {
  summary: ThreadSummary;
  // Title text (e.g. "~general" or "Bob"). The page resolves it from
  // userChannels / userConversations and passes it in so each card
  // doesn't have to re-derive it.
  title: string;
  // URL the title links to — opens the thread in its parent view via the
  // existing `?thread=…` deep-link the channel/conversation pages handle.
  deepLink: string;
  currentUserId?: string;
}

// Cap the number of fully-rendered messages per thread before we collapse
// the middle. Threads with more than this many entries (root + replies)
// show the root, a "Show N more replies" toggle, and the last 2 replies.
const FULL_RENDER_CAP = 10;
const TAIL_LENGTH = 2;

// ThreadCard renders one thread on the Threads page as a self-contained
// chat snippet: clickable title → root message → some/all replies →
// reply composer. Each card fetches its own thread messages; React
// Query's keyed cache means clicking into the channel/conversation view
// doesn't re-fetch.
export function ThreadCard({ summary, title, deepLink, currentUserId }: ThreadCardProps) {
  const channelId = summary.parentType === 'channel' ? summary.parentID : undefined;
  const conversationId = summary.parentType === 'conversation' ? summary.parentID : undefined;

  // Defer fetching until the card is about to scroll into view —
  // /threads with 50+ entries would otherwise fan out 50 parallel
  // /thread requests on first render.
  const { ref, inView } = useInView<HTMLElement>();
  const inputRef = useRef<MessageInputHandle>(null);

  // Capture the unread state on first render — once we mark this thread
  // seen below the card would otherwise lose its highlight mid-frame.
  const [wasUnread] = useState(() => hasUnreadActivity(summary));

  // Mark seen the first time the card actually scrolls into view.
  useEffect(() => {
    if (!inView) return;
    markThreadSeen(summary.threadRootID);
  }, [inView, summary.threadRootID]);
  const { data: messages, isLoading } = useThreadMessages({
    channelId,
    conversationId,
    threadRootID: summary.threadRootID,
    enabled: inView,
  });

  const root = messages?.[0];
  const replies = messages?.slice(1) ?? [];
  const totalCount = messages?.length ?? 0;

  // Collapse the middle of a long thread. We keep the root visible at
  // the top and the last TAIL_LENGTH replies at the bottom, hiding the
  // ones in between behind a toggle. Threads under FULL_RENDER_CAP are
  // shown in full.
  const [expanded, setExpanded] = useState(false);
  const isLong = totalCount > FULL_RENDER_CAP;
  const tail = isLong ? replies.slice(-TAIL_LENGTH) : replies;
  const hiddenCount = isLong ? replies.length - TAIL_LENGTH : 0;
  const visibleReplies = expanded || !isLong ? replies : tail;

  // User lookup covering authors + reactors so the reaction tooltip
  // doesn't fall back to "Unknown" when someone reacts who isn't an
  // author in this thread.
  const userIDs = useMemo(
    () => collectMessageUserIDs(messages ?? []),
    [messages],
  );
  const { map: userMap } = useUsersBatch(userIDs);
  const presence = usePresence();

  // useSendMessage invalidates the same ['thread', parentPath, rootID]
  // key the hook above subscribes to, so a reply lands without an
  // extra fetch from us.
  const send = useSendMessage({ channelId, conversationId });

  function handleReply(input: SendMessageInput) {
    send.mutate({ ...input, parentMessageID: summary.threadRootID });
    // Treat sending as "seeing" — drops the unread dot in the sidebar
    // since the user is clearly engaged with this thread.
    markThreadSeen(summary.threadRootID);
  }

  return (
    <article
      ref={ref}
      data-testid="thread-card"
      data-thread-root-id={summary.threadRootID}
      data-in-view={inView ? 'true' : 'false'}
      data-unread={wasUnread ? 'true' : 'false'}
      className={
        'rounded-lg border bg-card overflow-hidden ' +
        (wasUnread ? 'border-primary/40 bg-primary/5' : '')
      }
    >
      {/* Title — same shape as a channel/conversation header. Clicking
          opens the thread in its parent view. */}
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        {summary.parentType === 'channel' ? (
          <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <Link
          to={deepLink}
          data-testid="thread-card-title"
          className="truncate text-sm font-semibold hover:underline"
          onClick={() => markThreadSeen(summary.threadRootID)}
        >
          {title}
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">
          {summary.replyCount} {summary.replyCount === 1 ? 'reply' : 'replies'}
        </span>
      </header>

      <MessageDropZone
        className="relative"
        onFiles={(files) => void inputRef.current?.uploadFiles(files)}
      >
        <div className="p-2">
          {isLoading && (
            <div className="space-y-2 p-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          )}

          {!isLoading && root && (
            <MessageItem
              message={root}
              authorName={userMap.get(root.authorID)?.displayName ?? 'Unknown'}
              authorAvatarURL={userMap.get(root.authorID)?.avatarURL}
              authorOnline={presence.isOnline(root.authorID)}
              isOwn={root.authorID === currentUserId}
              channelId={channelId}
              conversationId={conversationId}
              currentUserId={currentUserId}
              userMap={userMap}
              inThread
            />
          )}

          {!isLoading && isLong && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              data-testid="thread-card-expand"
              className="my-1 ml-12 block text-xs font-medium text-primary hover:underline"
            >
              Show {hiddenCount} more {hiddenCount === 1 ? 'reply' : 'replies'}
            </button>
          )}

          {!isLoading &&
            visibleReplies.map((msg) => (
              <MessageItem
                key={msg.id}
                message={msg}
                authorName={userMap.get(msg.authorID)?.displayName ?? 'Unknown'}
                authorAvatarURL={userMap.get(msg.authorID)?.avatarURL}
                authorOnline={presence.isOnline(msg.authorID)}
                isOwn={msg.authorID === currentUserId}
                channelId={channelId}
                conversationId={conversationId}
                currentUserId={currentUserId}
                userMap={userMap}
                inThread
              />
            ))}
        </div>

        {/* Reply composer — sends with parentMessageID set so the post
            lands as a thread reply. Disabled while the previous reply is
            still in flight so a stuttering double-Enter can't double-post. */}
        <div className="border-t bg-background">
          <MessageInput
            ref={inputRef}
            onSend={handleReply}
            disabled={send.isPending}
            placeholder="Reply…"
          />
        </div>
      </MessageDropZone>
    </article>
  );
}

