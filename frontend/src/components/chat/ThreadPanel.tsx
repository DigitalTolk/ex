import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MessageItem } from './MessageItem';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { useSendMessage, type SendMessageInput } from '@/hooks/useMessages';
import { useThreadMessages } from '@/hooks/useThreads';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { collectMessageUserIDs } from '@/lib/message-users';
import type { UserMapEntry } from './MessageList';

interface ThreadPanelProps {
  channelId?: string;
  conversationId?: string;
  threadRootID: string;
  onClose: () => void;
  userMap: Record<string, UserMapEntry>;
  currentUserId?: string;
}

export function ThreadPanel({
  channelId,
  conversationId,
  threadRootID,
  onClose,
  userMap,
  currentUserId,
}: ThreadPanelProps) {
  const { data, isLoading } = useThreadMessages({ channelId, conversationId, threadRootID });

  // Authors + reactors of thread messages may not be in the parent
  // userMap (which was built from the channel page, not the thread).
  // Fetch any missing IDs so reaction tooltips don't show "Unknown".
  const missingUserIDs = useMemo(() => {
    const ids = collectMessageUserIDs(data ?? []);
    return ids.filter((id) => !userMap[id]);
  }, [data, userMap]);
  const { data: extras } = useUsersBatch(missingUserIDs);
  const mergedUserMap = useMemo(() => {
    if (!extras || extras.length === 0) return userMap;
    const m: Record<string, UserMapEntry> = { ...userMap };
    for (const u of extras) {
      m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL };
    }
    return m;
  }, [userMap, extras]);
  // Adapter for MessageItem — its userMap prop is the .get-style lookup
  // ThreadActionBar / reaction tooltip both consume.
  const userLookup = useMemo(
    () => ({ get: (id: string) => mergedUserMap[id] }),
    [mergedUserMap],
  );

  const send = useSendMessage({ channelId, conversationId });
  const inputRef = useRef<MessageInputHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Track whether the user is at the bottom so async-loading content
  // (avatars, attachments) and new replies follow them down only when
  // they're already keeping up with the conversation.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      wasAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, []);

  // Snap to the bottom on open, follow new replies while at the
  // bottom, and keep re-pinning while async content settles. The
  // ResizeObserver lives for the duration of the open thread (gated
  // by wasAtBottomRef so it doesn't yank a reader who has scrolled
  // up). Re-arms when the user opens a different thread.
  const stickyDoneRef = useRef(false);
  const prevLenRef = useRef(0);
  const stickyROrRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    stickyDoneRef.current = false;
    prevLenRef.current = 0;
    if (stickyROrRef.current) {
      stickyROrRef.current.disconnect();
      stickyROrRef.current = null;
    }
  }, [threadRootID]);
  useLayoutEffect(() => {
    const len = data?.length ?? 0;
    if (len === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const stick = () => {
      el.scrollTop = el.scrollHeight;
      wasAtBottomRef.current = true;
    };

    if (!stickyDoneRef.current) {
      // Initial open: always scroll to the newest reply.
      stick();
      stickyDoneRef.current = true;
      prevLenRef.current = len;
      if (typeof ResizeObserver !== 'undefined') {
        const inner = innerRef.current;
        if (inner) {
          const ro = new ResizeObserver(() => {
            if (wasAtBottomRef.current) stick();
          });
          ro.observe(inner);
          stickyROrRef.current = ro;
        }
      }
      return;
    }

    // New reply on a thread already open — follow only if the user
    // hasn't scrolled away. Compute the distance synchronously
    // rather than reading wasAtBottomRef so a programmatic
    // scrollTop set (with no accompanying scroll event) is handled
    // correctly.
    if (len > prevLenRef.current) {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < 120) stick();
    }
    prevLenRef.current = len;
  }, [data?.length]);
  useEffect(
    () => () => {
      if (stickyROrRef.current) {
        stickyROrRef.current.disconnect();
        stickyROrRef.current = null;
      }
    },
    [],
  );

  function handleReply(input: SendMessageInput) {
    send.mutate({ ...input, parentMessageID: threadRootID });
  }

  return (
    <aside className="w-[28rem] border-l flex flex-col" aria-label="Thread">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Thread</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close thread"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <MessageDropZone onFiles={(files) => void inputRef.current?.uploadFiles(files)}>
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div ref={innerRef} className="p-2 space-y-2">
            {isLoading && (
              <p className="text-xs text-muted-foreground p-2">Loading replies...</p>
            )}
            {data?.length === 0 && (
              <p className="text-xs text-muted-foreground p-2">No replies yet. Start the thread!</p>
            )}
            {data?.map((msg) => {
              const u = mergedUserMap[msg.authorID];
              return (
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
                  userMap={userLookup}
                  inThread
                />
              );
            })}
          </div>
        </div>
        <MessageInput
          ref={inputRef}
          onSend={handleReply}
          disabled={send.isPending}
          placeholder="Reply..."
          focusKey={threadRootID}
        />
      </MessageDropZone>
    </aside>
  );
}
