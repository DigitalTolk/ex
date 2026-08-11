import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellOff, Globe, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageItem } from '@/components/chat/MessageItem';
import { isGroupedWithPrevious } from '@/components/chat/MessageListRows';
import { MessageInput, type MessageInputHandle, type MessageInputValue } from '@/components/chat/MessageInput';
import { MessageDropZone } from '@/components/chat/MessageDropZone';
import { useFrequentEmojis } from '@/hooks/useEmoji';
import { NonMemberInvitePrompt } from '@/components/chat/NonMemberInvitePrompt';
import { useNonMemberInvite } from '@/hooks/useNonMemberInvite';
import { Skeleton } from '@/components/ui/skeleton';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useEditMessage, useSendMessage, type SendMessageInput } from '@/hooks/useMessages';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { Message } from '@/types';
import { useInView, useLiveInView } from '@/hooks/useInView';
import {
  useDraftAttachmentChips,
  useDraftForScope,
  useSaveDraft,
} from '@/hooks/useDrafts';
import { collectMessageUserIDs } from '@/lib/message-users';
import { addInViewThread, removeInViewThread } from '@/lib/thread-scope';
import {
  markThreadSeen,
  useThreadMessages,
  useUnfollowThread,
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
  unread?: boolean;
}

function markSummaryThreadSeen(summary: ThreadSummary) {
  markThreadSeen(summary.threadRootID, summary.latestActivityAt, {
    parentID: summary.parentID,
    parentType: summary.parentType,
  });
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
export function ThreadCard({ summary, title, deepLink, currentUserId, unread = false }: ThreadCardProps) {
  const channelId = summary.parentType === 'channel' ? summary.parentID : undefined;
  const conversationId = summary.parentType === 'conversation' ? summary.parentID : undefined;

  // Defer fetching until the card is about to scroll into view —
  // /threads with 50+ entries would otherwise fan out 50 parallel
  // /thread requests on first render.
  const { ref, inView } = useInView<HTMLElement>();
  const inputRef = useRef<MessageInputHandle>(null);

  useEffect(() => {
    if (!inView || !unread) return;
    markSummaryThreadSeen(summary);
  }, [inView, summary, unread]);

  // While this card is CURRENTLY in the viewport the user is reading the
  // thread (SPEC D-3) — register it so a live reply neither pops a
  // notification nor lights the Threads badge. liveInView (non-sticky) is
  // deliberate: the sticky inView above would keep a scrolled-past card
  // registered forever. The attention gates (visible + focused + recent
  // input) are applied by the suppression check itself, so cards registered
  // in a backgrounded tab never suppress anything.
  const liveInView = useLiveInView(ref);
  useEffect(() => {
    if (!liveInView) return;
    addInViewThread(summary.threadRootID);
    return () => removeInViewThread(summary.threadRootID);
  }, [liveInView, summary.threadRootID]);

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
  const quickReactions = useFrequentEmojis(3);
  const unfollowThread = useUnfollowThread();

  // The "previous" message for the first visible reply: the root when the
  // thread is shown in full, or null when the middle is collapsed (the real
  // predecessor is hidden, so the first visible reply must start a fresh
  // group rather than merging into a message that isn't on screen).
  const firstVisiblePrev = expanded || !isLong ? root : null;

  // useSendMessage invalidates the same ['thread', parentPath, rootID]
  // key the hook above subscribes to, so a reply lands without an
  // extra fetch from us.
  const send = useSendMessage({ channelId, conversationId });
  const editMessage = useEditMessage();
  const isMobile = useIsMobile();
  // Desktop edits inline inside the MessageItem; mobile routes them to this
  // card's bottom composer (an inline editor is cramped behind the keyboard),
  // mirroring ThreadPanel. activeEditingMessage is only set on mobile.
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const activeEditingMessage = isMobile ? editingMessage : null;
  const { pendingInvites, channelSlug, checkMentions, clearInvites } = useNonMemberInvite(channelId, currentUserId);
  const parentID = channelId ?? conversationId;
  const parentType: 'channel' | 'conversation' = channelId ? 'channel' : 'conversation';
  const draftScope = useMemo(
    () => ({ parentID, parentType, parentMessageID: summary.threadRootID }),
    [parentID, parentType, summary.threadRootID],
  );
  const { data: draft } = useDraftForScope(draftScope);
  const draftAttachments = useDraftAttachmentChips(draft?.attachmentIDs);
  const saveDraft = useSaveDraft();
  const saveDraftMutate = saveDraft.mutate;

  const handleDraftChange = useCallback(
    (input: MessageInputValue, options?: { notify?: boolean; keepalive?: boolean }) => {
      /* istanbul ignore next -- parentID is channelId ?? conversationId and parentType is always 'channel' | 'conversation', so one is always set; this guard is unreachable defensive code. */
      if (!parentID) return;
      saveDraftMutate({
        parentID,
        parentType,
        parentMessageID: summary.threadRootID,
        body: input.body,
        attachmentIDs: input.attachmentIDs ?? [],
        // Keystroke saves persist silently; the focus-loss flush (notify)
        // is what surfaces the draft in the sidebar.
        silent: !options?.notify,
        keepalive: options?.keepalive,
      });
    },
    [parentID, parentType, summary.threadRootID, saveDraftMutate],
  );

  const handleReply = useCallback(
    (input: SendMessageInput) => {
      // Offer to add any @mentioned non-members to the channel (no-op for DMs).
      checkMentions(input.body);
      const payload = { ...input, parentMessageID: summary.threadRootID };
      // Draft lifecycle (condemn at mutate, cache patch-out on success,
      // rollback on error) is owned by useSendMessage.
      send.mutate(payload);
      // Treat sending as "seeing" — drops the unread dot in the sidebar
      // since the user is clearly engaged with this thread.
      markSummaryThreadSeen(summary);
    },
    [send, summary, checkMentions],
  );

  // Mobile edit submit — the bottom composer doubles as the edit field while
  // editingMessage is set (see activeEditingMessage). Desktop edits go through
  // the MessageItem's own inline composer (which handles attachments); this card
  // composer is BODY-ONLY, so it omits attachmentIDs to PRESERVE the message's
  // existing attachments rather than stripping them (sending [] would delete).
  // Not wrapped in useCallback — the React Compiler memoizes it, and a manual
  // dep list here mismatches the compiler's inference (setEditingMessage).
  const handleEditMessage = (value: SendMessageInput) => {
    /* istanbul ignore next -- only wired as onSend while editingMessage is set; defensive. */
    if (!editingMessage) return;
    if (!value.body.trim() || value.body === editingMessage.body) {
      setEditingMessage(null);
      return;
    }
    editMessage.mutate(
      { messageId: editingMessage.id, body: value.body, channelId, conversationId },
      { onSuccess: () => setEditingMessage(null) },
    );
  };

  return (
    <article
      ref={ref}
      data-testid="thread-card"
      data-thread-root-id={summary.threadRootID}
      data-in-view={inView ? 'true' : 'false'}
      data-unread={unread ? 'true' : 'false'}
      className={
        // overflow-clip (not overflow-hidden) so the rounded corners still
        // clip children WITHOUT establishing a scroll container — macOS
        // WKWebView (the desktop app's webview) otherwise traps wheel events
        // over a hidden-overflow box, blocking page scroll when the cursor is
        // over the card header.
        // Unread emphasis is NEUTRAL (a stronger border + gentle shadow) plus
        // the pink "Unread" badge below — never a `primary` wash/border/ring,
        // which in dark mode is white and floods the card with a glaring
        // light accent.
        'rounded-lg border bg-card overflow-clip ' +
        (unread ? 'border-border-strong shadow-sm' : '')
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
          // overflow-clip (not `truncate`, which is overflow-hidden) for the
          // same reason as the card wrapper: the desktop webview traps wheel
          // events over a hidden-overflow box, so hovering the channel name
          // here used to block page scroll. clip shrinks the flex item the
          // same way without establishing a scroll container.
          className="min-w-0 overflow-clip whitespace-nowrap text-ellipsis text-sm font-semibold"
          onClick={() => markSummaryThreadSeen(summary)}
        >
          {title}
        </Link>
        {unread && (
          <span
            data-testid="thread-card-unread"
            className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-semibold text-brand-foreground"
          >
            Unread
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          disabled={unfollowThread.isPending}
          onClick={() => unfollowThread.mutate({
            parentID: summary.parentID,
            parentType: summary.parentType,
            threadRootID: summary.threadRootID,
          })}
          aria-label="Unfollow thread"
        >
          <BellOff className="h-3.5 w-3.5" />
          Unfollow
        </Button>
        <span
          // shrink-0 + nowrap: on a narrow mobile header the flex squeeze
          // otherwise wraps "4 replies" onto two rows — the title (min-w-0,
          // ellipsis) is the only element that may give way.
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
        >
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
              authorUserStatus={userMap.get(root.authorID)?.userStatus}
              isOwn={root.authorID === currentUserId}
              channelId={channelId}
              conversationId={conversationId}
              currentUserId={currentUserId}
              userMap={userMap}
              quickReactions={quickReactions}
              inThread
              onEditMessage={isMobile ? setEditingMessage : undefined}
            />
          )}

          {!isLoading && isLong && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              data-testid="thread-card-expand"
              className="my-1 ml-12 block text-xs font-medium text-link transition-colors hover:text-link/80"
            >
              {/* hiddenCount is always ≥ 8 here: the toggle only shows when the
                  thread exceeds FULL_RENDER_CAP (10), so replies − TAIL_LENGTH ≥ 8.
                  Always plural — a "1 reply" case can't occur. */}
              Show {hiddenCount} more replies
            </button>
          )}

          {!isLoading &&
            visibleReplies.map((msg, i) => (
              <MessageItem
                key={msg.id}
                message={msg}
                firstInGroup={!isGroupedWithPrevious(i === 0 ? firstVisiblePrev : visibleReplies[i - 1], msg)}
                authorName={userMap.get(msg.authorID)?.displayName ?? 'Unknown'}
                authorAvatarURL={userMap.get(msg.authorID)?.avatarURL}
                authorUserStatus={userMap.get(msg.authorID)?.userStatus}
                isOwn={msg.authorID === currentUserId}
                channelId={channelId}
                conversationId={conversationId}
                currentUserId={currentUserId}
                userMap={userMap}
                quickReactions={quickReactions}
                inThread
                onEditMessage={isMobile ? setEditingMessage : undefined}
              />
            ))}
        </div>

        <NonMemberInvitePrompt
          channelId={channelId}
          channelName={channelSlug}
          users={pendingInvites}
          onDismiss={clearInvites}
        />

        {/* Reply composer — sends with parentMessageID set so the post
            lands as a thread reply. Disabled while the previous reply is
            still in flight so a stuttering double-Enter can't double-post. */}
        <MessageInput
          // Re-mount when switching between reply and edit so the editor
          // re-initialises with the right body (initialBody is only "initial").
          key={activeEditingMessage ? `edit-${activeEditingMessage.id}` : `reply-${summary.threadRootID}`}
          ref={inputRef}
          onSend={activeEditingMessage ? handleEditMessage : handleReply}
          onCancel={activeEditingMessage ? () => setEditingMessage(null) : undefined}
          submitLabel={activeEditingMessage ? 'Save' : undefined}
          disabled={activeEditingMessage ? editMessage.isPending : send.isPending}
          placeholder={activeEditingMessage ? 'Edit message…' : 'Reply…'}
          initialBody={activeEditingMessage?.body ?? draft?.body ?? ''}
          initialDrafts={activeEditingMessage ? [] : draftAttachments}
          onDraftChange={activeEditingMessage ? undefined : handleDraftChange}
          typingParentID={activeEditingMessage ? undefined : parentID}
          typingParentType={activeEditingMessage ? undefined : parentType}
          typingThreadRootID={summary.threadRootID}
          hideCodeButton
          bottomInset={false}
        />
      </MessageDropZone>
    </article>
  );
}
