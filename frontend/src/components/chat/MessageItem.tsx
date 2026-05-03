import { useEffect, useState } from 'react';
import { Pencil, Trash2, SmilePlus, MessageSquareReply, MoreHorizontal, Pin, PinOff, Link as LinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageInput, type MessageInputValue } from '@/components/chat/MessageInput';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmojiPicker } from '@/components/EmojiPicker';
import { UserHoverCard } from '@/components/UserHoverCard';
import { UserAvatar } from '@/components/UserAvatar';
import { useEditMessage, useDeleteMessage, useToggleReaction, useSetPinned } from '@/hooks/useMessages';
import { useEmojiMap } from '@/hooks/useEmoji';
import { renderMarkdown } from '@/lib/markdown';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { useTagOpen } from '@/context/TagSearchContext';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { ThreadActionBar } from '@/components/chat/ThreadActionBar';
import { UnfurlCard } from '@/components/chat/UnfurlCard';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { extractURLs, formatLongDateTime } from '@/lib/format';
import { dispatchFocusComposer, registerEditMessageHandler } from '@/lib/window-events';
import type { Message, UserStatus } from '@/types';

// Module-level Set so MessageList/ThreadPanel don't need to thread a
// context through every callsite. Listeners are MessageItems with an
// open kebab menu; on mouseEnter another row, every other listener
// closes itself. mouseleave on the row doesn't work — Radix portals
// the menu outside the row's DOM, so moving cursor from kebab to a
// menu item would slam the menu shut before the user could click.
type MessageHoverListener = (activeMessageID: string) => void;
const messageHoverListeners = new Set<MessageHoverListener>();
function notifyMessageHovered(id: string) {
  for (const cb of messageHoverListeners) cb(id);
}

interface MessageItemProps {
  message: Message;
  authorName: string;
  authorAvatarURL?: string;
  authorUserStatus?: UserStatus;
  authorOnline?: boolean;
  isOwn: boolean;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  currentUserId?: string;
  inThread?: boolean;
  onReplyInThread?: (messageID: string) => void;
  // Optional pre-resolved user lookup. When supplied, ThreadActionBar
  // reads display names + avatars from here instead of issuing its own
  // /users/batch fetch — avoids N+1 batches across many thread bars.
  userMap?: { get(id: string): { displayName: string; avatarURL?: string; userStatus?: UserStatus } | undefined };
  // When true, renders the deep-link highlight ring. Driven by the
  // surrounding list's anchor effect; the surrounding list also
  // clears the flag after the flash window so the ring auto-removes.
  highlighted?: boolean;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MessageItem({
  message,
  authorName,
  authorAvatarURL,
  authorUserStatus,
  authorOnline,
  isOwn,
  channelId,
  channelSlug,
  conversationId,
  currentUserId,
  inThread,
  onReplyInThread,
  userMap,
  highlighted,
}: MessageItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // Visibility tracked in JS (not Tailwind group-hover) because Radix's
  // open dropdown changes pointer-events/focus and breaks CSS :hover
  // propagation on the row.
  const [hovered, setHovered] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const toolbarVisible = hovered || actionsMenuOpen;

  useEffect(() => {
    if (!actionsMenuOpen) return;
    const ownID = message.id;
    const onHover = (activeID: string) => {
      if (activeID !== ownID) {
        setActionsMenuOpen(false);
        setHovered(false);
      }
    };
    messageHoverListeners.add(onHover);
    return () => {
      messageHoverListeners.delete(onHover);
    };
  }, [actionsMenuOpen, message.id]);

  // ArrowUp on an empty composer asks the surrounding list's most
  // recent own message to enter edit mode. Registry-based dispatch
  // (one window listener + a Map keyed by id) keeps this O(1) per
  // event regardless of how many MessageItems are on screen, while
  // preserving the cross-scope decoupling of a window event.
  useEffect(() => {
    if (!isOwn || message.deleted || message.system) return;
    return registerEditMessageHandler(message.id, () => setIsEditing(true));
  }, [isOwn, message.id, message.deleted, message.system]);

  // Keep the inline edit visible — both on entry AND as the editor
  // grows while the user types more lines. The composer lives just
  // below the scroller, so without active tracking the bottom of the
  // edit area slides behind it as height grows.
  // - On entry: scrollIntoView after two frames so editor mount +
  //   attachment chip layout settle before measuring.
  // - During edit: a ResizeObserver re-scrolls on every height
  //   increase. Disconnects on cancel/save.
  useEffect(() => {
    if (!isEditing) return;
    const id = `msg-${message.id}`;
    const el = document.getElementById(id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
      });
    });
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (h > lastHeight + 0.5) {
        el.scrollIntoView({ block: 'nearest' });
      }
      lastHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isEditing, message.id]);
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage();
  const toggleReaction = useToggleReaction();
  const setPinned = useSetPinned();
  const { data: emojiMap } = useEmojiMap();
  const { openTag } = useTagOpen();

  function buildMessageLink(): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const slug = channelSlug ?? channelId;
    if (slug) return `${origin}${buildChannelHref(slug, message.id, message.parentMessageID)}`;
    if (conversationId) return `${origin}${buildConversationHref(conversationId, message.id, message.parentMessageID)}`;
    return `${origin}/#msg-${message.id}`;
  }

  async function handleCopyLink() {
    const link = buildMessageLink();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Fallback for environments without async clipboard (jsdom, older browsers).
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* swallow */ }
      ta.remove();
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  }

  function handleTogglePin() {
    setPinned.mutate({
      messageId: message.id,
      pinned: !message.pinned,
      channelId,
      conversationId,
    });
  }

  // When entering edit mode, hydrate the existing attachments so the
  // MessageInput can render them as draft chips (and let the user remove
  // any of them). We only fetch when the user actually starts editing.
  const editAttachmentIDs = isEditing ? (message.attachmentIDs ?? []) : [];
  const { map: editAttachmentMap } = useAttachmentsBatch(editAttachmentIDs);
  const initialEditDrafts: DraftAttachment[] = isEditing
    ? editAttachmentIDs
        .map((id): DraftAttachment | null => {
          const a = editAttachmentMap.get(id);
          if (!a) return null;
          return {
            id: a.id,
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          };
        })
        .filter((d): d is DraftAttachment => d !== null)
    : [];
  // Wait until existing attachments are hydrated before mounting the editor;
  // otherwise the editor mounts with an empty draft list and the user's first
  // save would silently strip every attachment off the message.
  const editorReady =
    !isEditing || editAttachmentIDs.length === 0 || initialEditDrafts.length === editAttachmentIDs.length;

  // Hand focus back to the main composer when an inline edit ends —
  // Escape, no-op submit, or successful save. Scoped by parentID +
  // inThread so a thread-reply edit doesn't yank the channel
  // composer's focus when both views are open simultaneously.
  function endEdit() {
    setIsEditing(false);
    dispatchFocusComposer({ parentID: message.parentID, inThread: !!inThread });
  }

  function handleEditSubmit(value: MessageInputValue) {
    const same =
      value.body === message.body &&
      value.attachmentIDs.length === (message.attachmentIDs ?? []).length &&
      value.attachmentIDs.every((id, idx) => id === (message.attachmentIDs ?? [])[idx]);
    if (same) {
      endEdit();
      return;
    }
    if (!value.body.trim() && value.attachmentIDs.length === 0) {
      endEdit();
      return;
    }
    editMessage.mutate(
      {
        messageId: message.id,
        body: value.body,
        attachmentIDs: value.attachmentIDs,
        channelId,
        conversationId,
      },
      { onSuccess: endEdit },
    );
  }

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  function confirmDelete() {
    deleteMessage.mutate({ messageId: message.id, channelId, conversationId });
  }

  function handleReact(emoji: string) {
    toggleReaction.mutate({ messageId: message.id, emoji, channelId, conversationId });
  }

  const reactions = message.reactions ?? {};
  const reactionEntries = Object.entries(reactions).filter(([, users]) => users && users.length > 0);

  function renderReactionLabel(emoji: string): string {
    return emoji;
  }

  function renderReactionVisual(emoji: string) {
    return <EmojiGlyph emoji={emoji} customMap={emojiMap} />;
  }

  const REACTOR_LIST_MAX = 20;
  function formatReactors(userIDs: string[]): string {
    const head = userIDs.slice(0, REACTOR_LIST_MAX);
    const names = head.map((id) => {
      if (id === currentUserId) return 'You';
      return userMap?.get(id)?.displayName ?? 'Unknown';
    });
    const extra = userIDs.length - head.length;
    return extra > 0 ? `${names.join(', ')} and ${extra} more` : names.join(', ');
  }

  return (
    <div
      id={`msg-${message.id}`}
      data-message-id={message.id}
      onMouseEnter={() => {
        setHovered(true);
        notifyMessageHovered(message.id);
      }}
      onMouseLeave={() => setHovered(false)}
      className={`relative flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 ${
        message.pinned ? 'border-l-2 border-amber-500 pl-2' : ''
      } ${highlighted ? 'ring-1 ring-amber-400/50 rounded-md' : ''}`}
    >
      <UserHoverCard
        userId={message.authorID}
        displayName={authorName}
        avatarURL={authorAvatarURL}
        userStatus={authorUserStatus}
        online={authorOnline}
        currentUserId={currentUserId}
        showInlineStatus={false}
      >
        <UserAvatar
          displayName={authorName}
          avatarURL={authorAvatarURL}
          online={authorOnline}
          className="mt-0.5 h-9 w-9 cursor-pointer"
          dotClassName="h-2.5 w-2.5"
        />
      </UserHoverCard>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <UserHoverCard
            userId={message.authorID}
            displayName={authorName}
            avatarURL={authorAvatarURL}
            userStatus={authorUserStatus}
            online={authorOnline}
            currentUserId={currentUserId}
          >
            <span className="cursor-pointer text-sm font-semibold">{authorName}</span>
          </UserHoverCard>
          <Tooltip>
            <TooltipTrigger
              className="text-xs text-muted-foreground cursor-default"
              render={<time dateTime={message.createdAt} />}
            >
              {formatTime(message.createdAt)}
            </TooltipTrigger>
            <TooltipContent>
              {formatLongDateTime(message.createdAt)}
            </TooltipContent>
          </Tooltip>
          {message.editedAt && (
            <span className="text-xs text-muted-foreground">(edited)</span>
          )}
          {message.pinned && (
            <span
              className="inline-flex items-center gap-0.5 text-xs text-amber-600"
              aria-label="Pinned"
            >
              <Pin className="h-3 w-3" />
              Pinned
            </span>
          )}
        </div>

        {isEditing ? (
          editorReady ? (
            <div className="mt-1" data-testid="inline-edit">
              <MessageInput
                key={`edit-${message.id}`}
                variant="inline"
                initialBody={message.body}
                initialDrafts={initialEditDrafts}
                onSend={handleEditSubmit}
                onCancel={endEdit}
                disabled={editMessage.isPending}
                placeholder="Edit message..."
                submitLabel="Save"
                // Pull focus into the inline editor on mount —
                // entering edit mode via ArrowUp from the channel
                // composer should land the caret in the edit field
                // directly so the user can keep typing.
                focusKey={message.id}
              />
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Loading…</p>
          )
        ) : message.deleted ? (
          <p
            data-testid="message-deleted-placeholder"
            className="mt-0.5 text-sm italic text-muted-foreground"
          >
            (Message deleted)
          </p>
        ) : (
          <>
            <div className="text-sm prose-message">
              {renderMarkdown(message.body, {
                emojiMap,
                currentUserId,
                onTagClick: openTag,
                renderUserMention: (userId, displayName, _isSelf, pill) => (
                  <UserHoverCard
                    key={`mention-${userId}-${message.id}`}
                    userId={userId}
                    displayName={displayName}
                    currentUserId={currentUserId}
                  >
                    {pill}
                  </UserHoverCard>
                ),
              })}
            </div>
            {(() => {
              if (message.noUnfurl) return null;
              // First URL in the body (skipping code) gets a preview
              // card. Capped at one to keep messages compact.
              const urls = extractURLs(message.body);
              return urls[0] ? (
                <UnfurlCard
                  url={urls[0]}
                  messageId={message.id}
                  channelId={channelId}
                  conversationId={conversationId}
                  isAuthor={isOwn}
                />
              ) : null;
            })()}
            {message.attachmentIDs && message.attachmentIDs.length > 0 && (
              <MessageAttachments
                ids={message.attachmentIDs}
                authorName={authorName}
                authorAvatarURL={authorAvatarURL}
                postedIn={
                  channelSlug
                    ? `~${channelSlug}`
                    : conversationId
                      ? 'Direct message'
                      : undefined
                }
                postedAt={message.createdAt}
              />
            )}
            {reactionEntries.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1" role="list" aria-label="Reactions">
                {reactionEntries.map(([emoji, users]) => {
                  const reactedByMe = currentUserId ? users.includes(currentUserId) : false;
                  return (
                    <Tooltip key={emoji}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            role="listitem"
                            data-testid="reaction-badge"
                            onClick={() => handleReact(emoji)}
                            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm hover:bg-muted ${
                              reactedByMe ? 'border-primary bg-primary/10' : 'bg-background'
                            }`}
                            aria-label={`${renderReactionLabel(emoji)} ${users.length}, ${reactedByMe ? 'reacted' : 'react'}`}
                            aria-pressed={reactedByMe}
                          />
                        }
                      >
                        {renderReactionVisual(emoji)}
                        <span className="text-sm text-muted-foreground">{users.length}</span>
                      </TooltipTrigger>
                      <TooltipContent
                        data-testid="reaction-tooltip"
                        className="flex max-w-[16rem] flex-col items-center gap-1.5 px-4 py-3 text-center"
                      >
                        <EmojiGlyph emoji={emoji} customMap={emojiMap} size="xl" />
                        <span className="text-xs leading-snug">
                          <span className="font-medium">{formatReactors(users)}</span>
                          <span className="text-muted-foreground"> reacted with </span>
                          <span className="font-medium">{renderReactionLabel(emoji)}</span>
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
                <EmojiPicker
                  onSelect={handleReact}
                  trigger={
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
                      aria-label="Add another reaction"
                    >
                      <SmilePlus className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
              </div>
            )}
            {!inThread && message.replyCount !== undefined && message.replyCount > 0 && (
              <ThreadActionBar
                rootMessageID={message.id}
                replyCount={message.replyCount}
                recentReplyAuthorIDs={message.recentReplyAuthorIDs}
                lastReplyAt={message.lastReplyAt}
                onClick={(id) => onReplyInThread?.(id)}
                userMap={userMap}
              />
            )}
          </>
        )}
      </div>

      {!isEditing && !message.deleted && (
        <div
          className="absolute right-2 -top-3 flex items-center gap-0.5 bg-background border rounded-md shadow-sm transition-opacity"
          style={{ opacity: toolbarVisible ? 1 : 0 }}
          data-actions-pinned={actionsMenuOpen ? 'true' : 'false'}
          data-actions-visible={toolbarVisible ? 'true' : 'false'}
          role="toolbar"
          aria-label="Message actions"
        >
          <EmojiPicker
            onSelect={handleReact}
            trigger={
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Add reaction">
                <SmilePlus className="h-3.5 w-3.5" />
              </Button>
            }
          />
          {!inThread && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Reply in thread"
              onClick={() => onReplyInThread?.(message.id)}
            >
              <MessageSquareReply className="h-3.5 w-3.5" />
            </Button>
          )}
          {/* modal={false} so other rows still receive mouseEnter while
              this menu is open — needed by the close-on-hover listener
              and the row's own :hover state. */}
          <DropdownMenu modal={false} open={actionsMenuOpen} onOpenChange={setActionsMenuOpen}>
            <DropdownMenuTrigger
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-accent"
              aria-label="More actions"
              data-testid="message-actions-trigger"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={handleCopyLink}
                aria-label="Copy link to message"
              >
                <LinkIcon className="mr-2 h-4 w-4" />
                {linkCopied ? 'Link copied' : 'Copy link'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleTogglePin}
                aria-label={message.pinned ? 'Unpin message' : 'Pin message'}
              >
                {message.pinned ? (
                  <>
                    <PinOff className="mr-2 h-4 w-4" /> Unpin
                  </>
                ) : (
                  <>
                    <Pin className="mr-2 h-4 w-4" /> Pin
                  </>
                )}
              </DropdownMenuItem>
              {isOwn && (
                <>
                  <DropdownMenuItem onClick={() => setIsEditing(true)}>
                    <Pencil className="mr-2 h-4 w-4" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteConfirmOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete message?"
        description="This message will be removed for everyone. Attachments stop being shared too. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        testIDPrefix="message-delete-confirm"
      />
    </div>
  );
}
