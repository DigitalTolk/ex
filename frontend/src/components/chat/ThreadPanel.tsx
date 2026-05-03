import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MessageItem } from './MessageItem';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { ThreadTypingIndicator } from './TypingIndicator';
import { Button } from '@/components/ui/button';
import { Bell, BellOff, X } from 'lucide-react';
import { useAtBottomRef } from '@/hooks/useAtBottomRef';
import { useSendMessage, type SendMessageInput } from '@/hooks/useMessages';
import { useFollowThread, useThreadMessages, useUnfollowThread, useUserThreads } from '@/hooks/useThreads';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { collectMessageUserIDs } from '@/lib/message-users';
import { useDeleteDraft, useDraftAttachmentChips, useDraftForScope, useSaveDraft } from '@/hooks/useDrafts';
import type { UserMapEntry } from './MessageList';

const ANCHOR_HIGHLIGHT_CLASSES = ['ring-1', 'ring-amber-400/50', 'rounded-md'];
const ANCHOR_HIGHLIGHT_MS = 2200;

interface ThreadPanelProps {
  channelId?: string;
  conversationId?: string;
  threadRootID: string;
  onClose: () => void;
  userMap: Record<string, UserMapEntry>;
  currentUserId?: string;
  // Deep-link target inside the thread — when set, the panel scrolls
  // to and highlights this reply instead of snapping to the bottom.
  // Used for search/threads-page links of the form
  // /channel/x?thread=root#msg-replyId.
  anchorMsgId?: string;
  // Per-navigation revision token; same role as in MessageList.
  anchorRevision?: string;
}

export function ThreadPanel({
  channelId,
  conversationId,
  threadRootID,
  onClose,
  userMap,
  currentUserId,
  anchorMsgId,
  anchorRevision,
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
  const parentID = channelId ?? conversationId;
  const parentType: 'channel' | 'conversation' = channelId ? 'channel' : 'conversation';
  const { data: userThreads } = useUserThreads();
  const isFollowing = !!userThreads?.some(
    (t) => t.parentID === parentID && t.parentType === parentType && t.threadRootID === threadRootID,
  );
  const followThread = useFollowThread();
  const unfollowThread = useUnfollowThread();
  const { data: draft } = useDraftForScope({
    parentID,
    parentType,
    parentMessageID: threadRootID,
  });
  const draftAttachments = useDraftAttachmentChips(draft?.attachmentIDs);
  const draftID = draft?.id;
  const saveDraft = useSaveDraft();
  const deleteDraft = useDeleteDraft();
  const saveDraftMutate = saveDraft.mutate;
  const deleteDraftMutate = deleteDraft.mutate;

  // Most recent own reply for the ArrowUp-edit-last shortcut. Thread
  // data is oldest-first; walk from the end to find the newest reply
  // matching the current user. Skip the root — that's editable from
  // the main composer, not the thread panel.
  const lastOwnMessageId = useMemo(() => {
    if (!currentUserId || !data) return undefined;
    for (let i = data.length - 1; i >= 0; i--) {
      const m = data[i];
      if (m.parentMessageID !== threadRootID) continue;
      if (m.authorID !== currentUserId) continue;
      if (m.deleted || m.system) continue;
      return m.id;
    }
    return undefined;
  }, [data, currentUserId, threadRootID]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Inner messages container — observed by the ResizeObservers below
  // (NOT scroller.lastElementChild, which can be a fixed-height
  // sentinel and would never report real content shifts).
  const innerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useAtBottomRef(scrollRef);

  // userHasScrolledRef is shared with the anchor effect below. Once
  // the user takes control of the scroll, the bottom-stick RO can
  // engage even in deep-link mode — but until then it stays a no-op
  // so an anchor that landed near the bottom doesn't get yanked by
  // settling avatars / attachments.
  const userHasScrolledRef = useRef(false);
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
  }, [threadRootID, anchorMsgId]);
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
      // Initial open. Skip the snap-to-newest if a deep-link anchor
      // is set — the anchor effect below controls position. The RO
      // is still installed so live-following resumes if/when the
      // user reaches the bottom themselves.
      if (!anchorMsgId) {
        stick();
      }
      stickyDoneRef.current = true;
      prevLenRef.current = len;
      if (typeof ResizeObserver !== 'undefined') {
        const inner = innerRef.current;
        if (inner) {
          // See MessageList: in deep-link mode (anchor set) we never
          // auto-stick — the reader went to a specific reply and
          // didn't opt into live-tail follow. In live-tail mode we
          // follow growth while the reader is at the bottom.
          let lastHeight = el.scrollHeight;
          const ro = new ResizeObserver(() => {
            const height = el.scrollHeight;
            const grew = height > lastHeight + 0.5;
            lastHeight = height;
            if (anchorMsgId) return;
            if (!grew) return;
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
  }, [data?.length, wasAtBottomRef, anchorMsgId]);

  // Deep-link landing inside the thread panel: scroll the matching
  // reply into view + highlight, exactly once per (threadRootID,
  // anchor). Mirrors MessageList's anchor logic, including a short-
  // lived follow-anchor RO so async reply content (avatars, attachments)
  // settling above the anchor doesn't push it off-screen. See
  // MessageList.tsx for the StrictMode/page-fetch invariants this
  // shape preserves.
  const anchorAppliedRef = useRef<string | null>(null);
  const followDeadlineRef = useRef<number>(0);
  useLayoutEffect(() => {
    if (!anchorMsgId) {
      anchorAppliedRef.current = null;
      userHasScrolledRef.current = false;
      followDeadlineRef.current = 0;
      return;
    }
    if ((data?.length ?? 0) === 0) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const el = document.getElementById(`msg-${anchorMsgId}`);
    if (!el) return;

    const dedupKey = anchorRevision ? `${anchorMsgId}@${anchorRevision}` : anchorMsgId;
    if (anchorAppliedRef.current !== dedupKey) {
      el.scrollIntoView({ block: 'center' });
      anchorAppliedRef.current = dedupKey;
      wasAtBottomRef.current = false;
      userHasScrolledRef.current = false;
      followDeadlineRef.current = Date.now() + 1500;
    }

    if (userHasScrolledRef.current) return;
    if (Date.now() >= followDeadlineRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;
    const inner = innerRef.current;
    if (!inner) return;
    let expectedScrollTop = scroller.scrollTop;
    const stopFollowing = () => {
      ro.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      window.clearTimeout(timeoutId);
    };
    const onScroll = () => {
      if (Math.abs(scroller.scrollTop - expectedScrollTop) > 5) {
        userHasScrolledRef.current = true;
        stopFollowing();
      }
    };
    const ro = new ResizeObserver(() => {
      el.scrollIntoView({ block: 'center' });
      expectedScrollTop = scroller.scrollTop;
    });
    ro.observe(inner);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const remaining = Math.max(0, followDeadlineRef.current - Date.now());
    const timeoutId = window.setTimeout(stopFollowing, remaining);
    return stopFollowing;
  }, [anchorMsgId, anchorRevision, data?.length, wasAtBottomRef]);

  // Cosmetic highlight ring on the in-thread anchor.
  const repliesHaveLoaded = (data?.length ?? 0) > 0;
  useEffect(() => {
    if (!anchorMsgId || !repliesHaveLoaded) return;
    const el = document.getElementById(`msg-${anchorMsgId}`);
    if (!el) return;
    el.classList.add(...ANCHOR_HIGHLIGHT_CLASSES);
    const t = window.setTimeout(() => {
      el.classList.remove(...ANCHOR_HIGHLIGHT_CLASSES);
    }, ANCHOR_HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(t);
      el.classList.remove(...ANCHOR_HIGHLIGHT_CLASSES);
    };
  }, [anchorMsgId, anchorRevision, repliesHaveLoaded]);
  useEffect(
    () => () => {
      if (stickyROrRef.current) {
        stickyROrRef.current.disconnect();
        stickyROrRef.current = null;
      }
    },
    [],
  );

  // Backup for the bottom-stick RO: late-loading <img> elements
  // (avatars, attachments, unfurl thumbs) finish at unpredictable
  // moments. Listening for delegated load events on the inner
  // container is the most reliable signal that "this image just
  // grew its box" — gated by wasAtBottomRef and skipped in deep-link
  // mode. Mirrors MessageList; see that file for the full rationale.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    if (anchorMsgId) return;
    const onLoad = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== 'IMG') return;
      if (!wasAtBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    };
    inner.addEventListener('load', onLoad, true);
    return () => inner.removeEventListener('load', onLoad, true);
  }, [anchorMsgId, wasAtBottomRef]);

  const handleDraftChange = useCallback(
    (value: SendMessageInput) => {
      if (!parentID) return;
      saveDraftMutate({
        parentID,
        parentType,
        parentMessageID: threadRootID,
        body: value.body,
        attachmentIDs: value.attachmentIDs ?? [],
      });
    },
    [parentID, parentType, threadRootID, saveDraftMutate],
  );

  const handleReply = useCallback(
    (input: SendMessageInput) => {
      const payload = { ...input, parentMessageID: threadRootID };
      if (!draftID) {
        send.mutate(payload);
        return;
      }
      send.mutate(payload, { onSuccess: () => deleteDraftMutate(draftID) });
    },
    [send, threadRootID, draftID, deleteDraftMutate],
  );

  return (
    <aside className="w-[28rem] border-l flex flex-col" aria-label="Thread">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Thread</h2>
        <div className="flex items-center gap-1">
          {parentID && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={followThread.isPending || unfollowThread.isPending}
              onClick={() => {
                const target = { parentID, parentType, threadRootID };
                if (isFollowing) {
                  unfollowThread.mutate(target);
                } else {
                  followThread.mutate(target);
                }
              }}
              aria-label={isFollowing ? 'Unfollow thread' : 'Follow thread'}
            >
              {isFollowing ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
              {isFollowing ? 'Unfollow' : 'Follow'}
            </Button>
          )}
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
        <ThreadTypingIndicator
          parentID={channelId ?? conversationId}
          threadRootID={threadRootID}
          userMap={mergedUserMap}
        />
        <MessageInput
          ref={inputRef}
          onSend={handleReply}
          disabled={send.isPending}
          placeholder="Reply..."
          focusKey={threadRootID}
          initialBody={draft?.body ?? ''}
          initialDrafts={draftAttachments}
          onDraftChange={handleDraftChange}
          typingParentID={channelId ?? conversationId}
          typingParentType={channelId ? 'channel' : 'conversation'}
          typingThreadRootID={threadRootID}
          lastOwnMessageId={lastOwnMessageId}
        />
      </MessageDropZone>
    </aside>
  );
}
