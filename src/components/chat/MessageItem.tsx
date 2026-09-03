import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Copy, Pencil, Trash2, SmilePlus, MessageSquareReply, MoreHorizontal, Pin, PinOff, Link as LinkIcon, AlarmClock, Eye } from 'lucide-react';
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReminderDialog } from '@/components/chat/ReminderDialog';
import { WatcherDialog, type EditingWatcher } from '@/components/chat/WatcherDialog';
import { useCreateReminder } from '@/hooks/useActivity';
import { useParentWatchers, useAgents, type WatchActionMode } from '@/hooks/useAgents';
import { REMINDER_PRESETS, computeReminderTime, toLocalInputValue, type ReminderPresetKey } from '@/lib/reminder-times';
import { EmojiPicker } from '@/components/EmojiPicker';
import { UserHoverCard } from '@/components/UserHoverCard';
import { UserAvatar } from '@/components/UserAvatar';
import { useEditMessage, useDeleteMessage, useToggleReaction, useSetPinned } from '@/hooks/useMessages';
import { useEmojiMap } from '@/hooks/useEmoji';
import { renderMarkdown } from '@/lib/markdown';
import { isEmojiOnlyMessage } from '@/lib/emoji-shortcodes';
import { recordEmojiUse } from '@/lib/emoji-frequency';
import { blurActiveInput } from '@/lib/blur-input';
import { showToast } from '@/lib/toast';
import { useLongPress } from '@/hooks/useLongPress';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { useTagOpen } from '@/context/TagSearchContext';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { ThreadActionBar } from '@/components/chat/ThreadActionBar';
import { UnfurlCard } from '@/components/chat/UnfurlCard';
import { MessageRichAttachments } from '@/components/chat/MessageRichAttachments';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { extractURLs, formatLongDateTime, formatRelative } from '@/lib/format';
import { registerEditMessageHandler } from '@/lib/window-events';
import { openRunDrawer, openThreadDrawer } from '@/stores/run-drawer';
import { ArtifactCard } from '@/components/chat/ArtifactCard';
import { TaskCard } from '@/components/chat/TaskCard';
import { parseArtifactMarker } from '@/lib/artifact-marker';
import { parseTaskMarker } from '@/lib/task-marker';
import { useIsMobile } from '@/hooks/useIsMobile';
import { motion } from 'motion/react';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';
import { useIsOnline } from '@/stores/presence';
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
  // First message of an author group. When false the row renders compact:
  // the avatar + name + timestamp header are replaced by a hover-only
  // timestamp in the avatar gutter, and vertical padding tightens — the
  // Slack/Mattermost "consecutive messages" grouping. Each message is still
  // a full, independently-hoverable row (own action bar, reactions, edit).
  // Defaults to true so standalone usages render a full header.
  firstInGroup?: boolean;
  authorName: string;
  authorAvatarURL?: string;
  authorUserStatus?: UserStatus;
  isOwn: boolean;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  currentUserId?: string;
  inThread?: boolean;
  disableEditing?: boolean;
  onReplyInThread?: (messageID: string) => void;
  onEditMessage?: (message: Message) => void;
  // Optional pre-resolved user lookup. When supplied, ThreadActionBar
  // reads display names + avatars from here instead of issuing its own
  // /users/batch fetch — avoids N+1 batches across many thread bars.
  userMap?: { get(id: string): { displayName: string; avatarURL?: string; userStatus?: UserStatus } | undefined };
  // When true, renders the deep-link highlight ring. Driven by the
  // surrounding list's anchor effect; the surrounding list also
  // clears the flag after the flash window so the ring auto-removes.
  highlighted?: boolean;
  onContentHeightChange?: () => void;
  // The viewer's most-used emoji (shortcodes), shown as one-tap reaction
  // shortcuts in the hover action bar. Empty/omitted → no shortcuts.
  quickReactions?: string[];
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// One reaction chip. Tap toggles the viewer's reaction; the "who reacted"
// list lives in a hover tooltip, which touch can't reach — so on mobile a
// LONG-PRESS surfaces the same reactor list as a toast instead. Split out of
// the render loop because the long-press needs its own hook instance per chip.
function ReactionChip({
  reactedByMe,
  ariaLabel,
  reactorsText,
  isMobile,
  onToggle,
  tooltipContent,
  children,
}: {
  reactedByMe: boolean;
  ariaLabel: string;
  // Pre-formatted "Alice, Bob reacted with 👍" line for the mobile toast.
  reactorsText: string;
  isMobile: boolean;
  onToggle: () => void;
  tooltipContent: ReactNode;
  children: ReactNode;
}) {
  const longPress = useLongPress({
    enabled: isMobile,
    onLongPress: () => showToast(reactorsText, 'success'),
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="listitem"
            data-testid="reaction-badge"
            onClick={() => {
              // The release of a long-press fires a click; swallow it so
              // peeking at the reactor list doesn't also toggle the reaction.
              if (longPress.shouldSuppressClick()) return;
              onToggle();
            }}
            onPointerDown={(e) => {
              // Keep the ROW's long-press (message action sheet) from arming
              // on a chip press — the chip's own long-press shows reactors.
              e.stopPropagation();
              longPress.handlers.onPointerDown(e);
            }}
            onPointerMove={longPress.handlers.onPointerMove}
            onPointerUp={longPress.handlers.onPointerUp}
            onPointerLeave={longPress.handlers.onPointerLeave}
            onPointerCancel={longPress.handlers.onPointerCancel}
            className={`flex items-center gap-1 rounded-full border px-1.5 py-0 text-sm hover:bg-muted mobile:px-2 mobile:py-0.5 ${
              reactedByMe ? 'border-primary bg-primary/10' : 'bg-background'
            }`}
            aria-label={ariaLabel}
            aria-pressed={reactedByMe}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        data-testid="reaction-tooltip"
        className="flex w-[16rem] flex-col items-center gap-1.5 px-4 py-3 text-center"
      >
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
}

function MessageItemImpl({
  message,
  firstInGroup = true,
  authorName,
  authorAvatarURL,
  authorUserStatus,
  isOwn,
  channelId,
  channelSlug,
  conversationId,
  currentUserId,
  inThread,
  disableEditing,
  onReplyInThread,
  onEditMessage,
  userMap,
  highlighted,
  onContentHeightChange,
  quickReactions,
}: MessageItemProps) {
  const isWebhook = !!message.webhookUsername;
  // Per-author presence subscription: only rows whose author actually
  // flipped re-render on a presence event, instead of every visible row
  // re-rendering because the whole userMap was rebuilt from the online
  // set. Webhook rows keep `undefined` — the integration is not a user,
  // so the avatar renders no availability notch at all.
  const authorPresence = useIsOnline(message.authorID);
  const authorOnline = isWebhook ? undefined : authorPresence;
  const displayAuthorName = message.webhookUsername || authorName;
  // Webhook posts must NOT borrow the creator's avatar — show the
  // integration's own avatar (override URL or initials of its username),
  // never the creator's profile image.
  const displayAuthorAvatarURL = isWebhook ? message.webhookAvatarURL : authorAvatarURL;
  // For webhook posts the profile dropdown is the minimal integration card
  // attributed to the creator (authorName resolves to the creator).
  const integrationOwnerName = isWebhook ? authorName : undefined;
  const isMobile = useIsMobile();
  const [isEditing, setIsEditing] = useState(false);
  // Visibility tracked in JS (not Tailwind group-hover) because Radix's
  // open dropdown changes pointer-events/focus and breaks CSS :hover
  // propagation on the row.
  const [hovered, setHovered] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [mobileActionsSuppressed, setMobileActionsSuppressed] = useState(false);
  const [mobileReactionPickerOpen, setMobileReactionPickerOpen] = useState(false);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const mobileActionsSheetRef = useRef<HTMLDivElement>(null);
  const toolbarVisible = hovered || actionsMenuOpen;
  const canEdit = isOwn && !disableEditing;
  const startEdit = useCallback(() => {
    /* istanbul ignore next -- startEdit is only wired (edit registry + the Edit menu item) behind `canEdit`, so it is never invoked when canEdit is false; this is a defensive re-check. */
    if (!canEdit) return;
    if (isMobile) {
      onEditMessage?.(message);
    } else {
      setIsEditing(true);
    }
  }, [canEdit, isMobile, message, onEditMessage]);

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
    if (!canEdit || message.deleted || message.system) return;
    return registerEditMessageHandler(message.id, startEdit);
  }, [canEdit, message.id, message.deleted, message.system, startEdit]);

  // Desktop keeps the classic inline edit. Mobile routes editing to the
  // bottom composer, because inline editors get cramped behind the keyboard.
  useEffect(() => {
    if (!isEditing) return;
    const id = `msg-${message.id}`;
    const el = document.getElementById(id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
      });
    });
    /* istanbul ignore next -- el resolves the row's own #msg-<id> (always present) and ResizeObserver exists in every supported browser, so this early-return guard is dead defensive. */
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      /* istanbul ignore next -- fires only when the inline editor grows taller than its initial measured height, a layout side-effect the headless test environment can't deterministically reproduce. */
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
  const createReminder = useCreateReminder();
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false);
  const [watcherDialogOpen, setWatcherDialogOpen] = useState(false);
  const [reminderSeed, setReminderSeed] = useState('');
  const { data: emojiMap } = useEmojiMap();
  const { openTag } = useTagOpen();

  // The reminder target derives from the message itself (its parentID is always
  // set), with the channel slug carried for the deep link. Every message can take
  // a reminder.
  const reminderTarget = {
    parentID: message.parentID,
    parentType: message.parentType === 'conversation' ? ('conversation' as const) : ('channel' as const),
    channelSlug,
  };

  // Watcher badge: the viewer's own thread-scoped watchers on THIS message.
  // One query per parent (react-query dedupes across rows); we match by
  // threadRootID so only the watched thread's root message is badged.
  const { data: parentWatchers } = useParentWatchers(reminderTarget.parentType, message.parentID);
  const { data: agentRoster } = useAgents();
  const myWatchers = useMemo(
    () => (parentWatchers ?? []).filter((w) => w.threadRootID === message.id),
    [parentWatchers, message.id],
  );
  const [manageWatchersOpen, setManageWatchersOpen] = useState(false);
  // The thread's watchers as the dialog's editable list (resolve agent id →
  // slug + display name from the roster).
  const editingWatchers = useMemo<EditingWatcher[]>(
    () =>
      myWatchers.map((w) => {
        const agent = agentRoster?.find((a) => a.id === w.agentID);
        return {
          id: w.id,
          slug: agent?.slug ?? '',
          agentName: agent?.displayName ?? 'an agent',
          instruction: w.instruction ?? '',
          actionMode: (w.actionMode ?? 'notify') as WatchActionMode,
        };
      }),
    [myWatchers, agentRoster],
  );

  // One builder so the preset (mutate) and custom-dialog (mutateAsync) paths
  // can't drift on the payload shape.
  const reminderInput = (when: Date) => ({
    messageID: message.id,
    ...reminderTarget,
    remindAt: when.toISOString(),
  });

  const scheduleReminder = (when: Date) => {
    createReminder.mutate(reminderInput(when));
  };

  // The custom dialog awaits the result so it can confirm (close) on success and
  // surface the error (stay open) on failure — scheduling is never silent there.
  const scheduleReminderAsync = (when: Date) =>
    createReminder.mutateAsync(reminderInput(when)).then(() => undefined);

  const handleReminderPreset = (key: ReminderPresetKey) => {
    scheduleReminder(computeReminderTime(key, new Date()));
  };

  const openCustomReminder = () => {
    // Compute the seed here (an event handler) so the clock read stays out of
    // render, then mount the dialog fresh with it. Defaults to the "in 1 hour"
    // preset so the field reuses the same tested time math as the quick-picks.
    setReminderSeed(toLocalInputValue(computeReminderTime('in1h', new Date())));
    setReminderDialogOpen(true);
  };

  // Mobile closes the action sheet as it opens the reminder popup.
  const handleMobileRemindCustom = () => {
    openCustomReminder();
    closeMobileActions();
  };

  function buildMessageLink(): string {
    /* istanbul ignore next -- SSR guard: this is a browser-only app, so window is always defined; the empty-origin arm is unreachable. */
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const slug = channelSlug ?? channelId;
    if (slug) return `${origin}${buildChannelHref(slug, message.id, message.parentMessageID)}`;
    if (conversationId) return `${origin}${buildConversationHref(conversationId, message.id, message.parentMessageID)}`;
    return `${origin}/#msg-${message.id}`;
  }

  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for environments without async clipboard (jsdom, older browsers).
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* swallow */ }
      ta.remove();
    }
  }

  async function handleCopyLink() {
    await copyToClipboard(buildMessageLink());
  }

  async function handleCopyText() {
    // Copy the raw markdown body (mention tokens like `@[id|name]` intact) so
    // pasting it back into the composer re-creates the mention pills / renders
    // mentions on send — and so it round-trips as the same markdown.
    await copyToClipboard(message.body);
  }

  function handleTogglePin() {
    setPinned.mutate({
      messageId: message.id,
      pinned: !message.pinned,
      channelId,
      conversationId,
    });
  }

  function closeMobileActions() {
    longPress.cancel();
    setMobileActionsOpen(false);
    setMobileActionsSuppressed(false);
    setMobileReactionPickerOpen(false);
  }
  // Pass mobileActionsOpen: MessageItem stays mounted while the sheet toggles,
  // so the gesture must re-initialise on each open (otherwise a swipe-dismiss
  // leaves it latched off-screen and it won't reopen).
  const { dismissing: swipeDismissing, motionProps: mobileActionsMotion } = useSwipeDismiss(
    'down',
    closeMobileActions,
    mobileActionsOpen,
  );
  // Back on mobile dismisses the long-press action sheet instead of leaving
  // the channel.
  useMobileBackClose(mobileActionsOpen, closeMobileActions);
  const setMobileActionsNode = useCallback((node: HTMLDivElement | null) => {
    mobileActionsSheetRef.current = node;
  }, []);

  function handleMobileReply() {
    closeMobileActions();
    onReplyInThread?.(message.id);
  }

  function handleMobileTogglePin() {
    closeMobileActions();
    handleTogglePin();
  }

  function handleMobileEdit() {
    closeMobileActions();
    onEditMessage?.(message);
  }

  const editAttachmentIDs = isEditing ? (message.attachmentIDs ?? []) : [];
  // Pass the access context so the server authorizes the resolve — without
  // it the batch returns nothing, the edit composer opens with no attachment
  // chips, and saving would wipe the message's attachments.
  const { map: editAttachmentMap, isLoading: editAttachmentsLoading } = useAttachmentsBatch(
    editAttachmentIDs,
    isEditing
      ? {
          parentID: channelId ?? conversationId,
          parentType: channelId ? 'channel' : 'conversation',
          messageID: message.id,
        }
      : undefined,
  );
  const initialEditDrafts: DraftAttachment[] = isEditing
    ? editAttachmentIDs
        .map((id): DraftAttachment | null => {
          const attachment = editAttachmentMap.get(id);
          if (!attachment) return null;
          return {
            id: attachment.id,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
            url: attachment.url,
            squareThumbnailURL: attachment.squareThumbnailURL,
          };
        })
        .filter((draft): draft is DraftAttachment => draft !== null)
    : [];
  const editorReady =
    !isEditing || editAttachmentIDs.length === 0 || !editAttachmentsLoading;

  function endEdit() {
    setIsEditing(false);
  }

  function handleEditSubmit(value: MessageInputValue) {
    const currentAttachmentIDs = message.attachmentIDs ?? [];
    // Defense against the de-link race: only trust the composer's attachment
    // list when every original attachment actually loaded into it. If some
    // didn't (resolve failed/raced), send `undefined` so the server preserves
    // the originals instead of replacing them with an incomplete list.
    const attachmentsFullyLoaded = initialEditDrafts.length === currentAttachmentIDs.length;
    const nextAttachmentIDs = attachmentsFullyLoaded ? value.attachmentIDs : undefined;
    const same =
      value.body === message.body &&
      attachmentsFullyLoaded &&
      value.attachmentIDs.length === currentAttachmentIDs.length &&
      value.attachmentIDs.every((id, idx) => id === currentAttachmentIDs[idx]);
    /* istanbul ignore next -- the composer disables Save when the body is empty and there are no attachments, so the trimmed-empty arm of this guard is never reached from the UI; only the `same` arm fires. */
    if (same || (!value.body.trim() && value.attachmentIDs.length === 0)) {
      endEdit();
      return;
    }
    editMessage.mutate(
      {
        messageId: message.id,
        body: value.body,
        attachmentIDs: nextAttachmentIDs,
        channelId,
        conversationId,
      },
      { onSuccess: endEdit },
    );
  }

  function handleMobileDelete() {
    closeMobileActions();
    setDeleteConfirmOpen(true);
  }

  function handleMobileCopyLink() {
    closeMobileActions();
    void handleCopyLink();
  }

  function handleMobileCopyText() {
    closeMobileActions();
    void handleCopyText();
  }

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  function confirmDelete() {
    deleteMessage.mutate({
      messageId: message.id,
      parentMessageID: message.parentMessageID,
      channelId,
      conversationId,
    });
  }

  function handleReact(emoji: string) {
    toggleReaction.mutate({ messageId: message.id, emoji, channelId, conversationId });
  }

  // Touch long-press opens the mobile action sheet via the SHARED
  // useLongPress gesture (420ms hold; touch/pen only; scroll drift past the
  // small threshold or release cancels; the haptic fires inside the hook).
  // This used to be a hand-rolled copy of the same pattern — keep the one
  // implementation in the hook.
  const longPress = useLongPress({
    enabled: !isEditing && !message.deleted && !message.system,
    delayMs: 420,
    onLongPress: () => {
      // Long-pressing to open the action bar should dismiss the keyboard
      // if the composer had focus, so the sheet isn't fighting the keyboard.
      blurActiveInput();
      setMobileActionsSuppressed(false);
      setMobileActionsOpen(true);
      notifyMessageHovered(message.id);
    },
  });
  useTransientOverlayCleanup(mobileActionsOpen, { rootRef: mobileActionsRef, lockScroll: true });

  // The unfurl scan walks the whole body; memoize so it only runs when the
  // body changes, not on unrelated re-renders.
  const bodyURLs = useMemo(() => extractURLs(message.body), [message.body]);

  // Recomputed only when the reactions map changes, not on every re-render
  // (presence/hover ticks would otherwise re-filter on each paint).
  const reactionEntries = useMemo(
    () => Object.entries(message.reactions ?? {}).filter(([, users]) => users && users.length > 0),
    [message.reactions],
  );

  function renderReactionLabel(emoji: string): string {
    return emoji;
  }

  function renderReactionVisual(emoji: string) {
    // Mobile uses the smaller glyph so the chip (with its touch padding)
    // stays no taller than the add-reaction button — same proportions the
    // desktop chip keeps with the md glyph and zero vertical padding.
    return <EmojiGlyph emoji={emoji} customMap={emojiMap} size={isMobile ? 'sm' : 'md'} />;
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

  const mobileActionsOverlay = !isEditing && !message.deleted && (mobileActionsOpen || mobileReactionPickerOpen) ? (
    <div
      ref={mobileActionsRef}
      className="fixed inset-0 z-[120] select-none [-webkit-touch-callout:none] [-webkit-user-select:none] md:hidden"
      role="presentation"
      onContextMenu={(event) => event.preventDefault()}
    >
      {!mobileActionsSuppressed && (
        <button
          type="button"
          className="absolute inset-0 bg-black/35"
          aria-label="Close message actions"
          onClick={closeMobileActions}
        />
      )}
      {mobileActionsOpen && (
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        className={`absolute inset-x-0 bottom-0 flex max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] flex-col overflow-hidden rounded-t-xl border-x-0 border-b-0 border-t bg-popover text-popover-foreground shadow-lg ${mobileActionsSuppressed ? 'hidden' : ''}`}
        data-testid="mobile-message-actions"
        data-actions-suppressed={mobileActionsSuppressed ? 'true' : 'false'}
        data-swipe-dismissing={String(swipeDismissing)}
        ref={setMobileActionsNode}
        {...mobileActionsMotion}
      >
        {/* Grab handle: the guaranteed swipe-to-dismiss surface. touch-action
            none keeps the browser from claiming the gesture as a native
            scroll; the menu body below scrolls natively when it overflows. */}
        <div
          className="flex shrink-0 items-center justify-center pb-2 pt-2"
          style={{ touchAction: 'none' }}
          aria-hidden="true"
          data-sheet-drag="true"
          data-testid="sheet-grab-handle"
        >
          <div className="h-1 w-9 rounded-full bg-border-strong" />
        </div>
        <div
          data-swipe-scroll="true"
          className="min-h-0 flex-1 overflow-y-auto p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-0"
        >
        {!inThread && (
          <Button
            type="button"
            className="mb-2 h-12 w-full justify-start gap-3 text-base mobile:h-14"
            onClick={handleMobileReply}
            aria-label="Reply in thread"
          >
            <MessageSquareReply className="h-5 w-5" />
            Reply in thread
          </Button>
        )}
        <EmojiPicker
          onSelect={(emoji) => {
            handleReact(emoji);
            closeMobileActions();
          }}
          onOpenChange={(open) => {
            setMobileReactionPickerOpen(open);
            if (open) {
              setMobileActionsSuppressed(true);
            } else {
              closeMobileActions();
            }
          }}
          triggerClassName="block w-full"
          trigger={
            <button
              type="button"
              className="mb-2 flex h-12 w-full items-center gap-3 rounded-lg border px-3 text-left mobile:h-14"
              aria-label="Add reaction"
            >
              <SmilePlus className="h-4 w-4" />
              <span className="text-sm font-medium">Reaction</span>
            </button>
          }
        />
        <div className="flex flex-col rounded-lg border">
          {(message.agentRunID || (!message.parentMessageID && (message.replyCount ?? 0) > 0)) && (
            <button
              type="button"
              className="flex items-center gap-3 border-b px-3 py-4 text-left text-base"
              onClick={() => {
                setMobileActionsOpen(false);
                // A thread root opens the WHOLE thread's activity (every run
                // under it); any other message opens its own run.
                if (!message.parentMessageID && (message.replyCount ?? 0) > 0) openThreadDrawer(message.parentID, message.id);
                else openRunDrawer(/* istanbul ignore next -- the button's gate guarantees agentRunID */ message.agentRunID ?? '');
              }}
              aria-label="Show agent activity"
            >
              <Bot className="h-4 w-4" />
              Show activity
            </button>
          )}
          <button
            type="button"
            className="flex items-center gap-3 border-b px-3 py-4 text-left text-base"
            onClick={handleMobileCopyText}
            aria-label="Copy message text"
          >
            <Copy className="h-4 w-4" />
            Copy text
          </button>
          <button
            type="button"
            className="flex items-center gap-3 border-b px-3 py-4 text-left text-base"
            onClick={handleMobileCopyLink}
            aria-label="Copy link to message"
          >
            <LinkIcon className="h-4 w-4" />
            {/* No "copied" swap on mobile — the sheet closes on tap, so the
                label change would never be visible. */}
            Copy link
          </button>
          <button
            type="button"
            className="flex items-center gap-3 border-b px-3 py-4 text-left text-base"
            onClick={handleMobileTogglePin}
            aria-label={message.pinned ? 'Unpin message' : 'Pin message'}
          >
            {message.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            {message.pinned ? 'Unpin' : 'Pin'}
          </button>
          {isOwn && (
            <>
              {canEdit && (
                <button
                  type="button"
                  className="flex items-center gap-3 border-b px-3 py-4 text-left text-base"
                  onClick={handleMobileEdit}
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              )}
              <button
                type="button"
                className="flex items-center gap-3 px-3 py-4 text-left text-base text-destructive"
                onClick={handleMobileDelete}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            </>
          )}
        </div>
        {/* Single "Remind me" row. Tapping it closes the sheet and opens the
            ReminderDialog (a separate popup with the date/time selector) — the
            old inline preset list made this sheet tall enough to cover the
            whole screen on mobile. */}
        <button
          type="button"
          className="mt-2 flex w-full items-center gap-3 rounded-lg border px-3 py-4 text-left text-base"
          onClick={handleMobileRemindCustom}
          data-testid="mobile-remind"
          aria-label="Remind me about this message"
        >
          <AlarmClock className="h-4 w-4" />
          Remind me
        </button>
        </div>
      </motion.div>
      )}
    </div>
  ) : null;

  return (
    <div
      id={`msg-${message.id}`}
      data-message-id={message.id}
      onMouseEnter={() => {
        setHovered(true);
        notifyMessageHovered(message.id);
      }}
      onMouseLeave={() => setHovered(false)}
      {...longPress.handlers}
      onContextMenu={(event) => {
        if (!isMobile) return;
        event.preventDefault();
      }}
      className={`relative flex items-start gap-3 rounded-md px-2 ${firstInGroup ? 'py-1.5' : 'py-0.5'} hover:bg-chat-hover ${
        message.pinned ? 'border-l-2 border-pinned pl-2' : ''
      } ${highlighted ? 'ring-1 ring-inset ring-amber-400/50 rounded-md' : ''} mobile:select-none mobile:touch-pan-y mobile:[-webkit-touch-callout:none] mobile:[-webkit-user-select:none]`}
    >
      {firstInGroup ? (
        <UserHoverCard
          userId={message.authorID}
          displayName={displayAuthorName}
          avatarURL={displayAuthorAvatarURL}
          userStatus={authorUserStatus}
          online={authorOnline}
          currentUserId={currentUserId}
          showInlineStatus={false}
          integrationOwnerName={integrationOwnerName}
          // Match the continuation gutter width (w-14) so the body aligns
          // identically on first-in-group and grouped rows; the avatar
          // hugs the right of the wider left column so it sits close to the
          // text, leaving the extra breathing room on the far left.
          triggerClassName="inline-flex w-14 shrink-0 cursor-pointer items-center justify-end"
        >
          {message.webhookIconEmoji ? (
            <div
              className="mt-0.5 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-muted"
              aria-label={`:${message.webhookIconEmoji}:`}
              data-testid="webhook-emoji-avatar"
            >
              <EmojiGlyph emoji={`:${message.webhookIconEmoji}:`} customMap={emojiMap} size="lg" />
            </div>
          ) : (
            <UserAvatar
              displayName={displayAuthorName}
              avatarURL={displayAuthorAvatarURL}
              online={authorOnline}
              className="mt-0.5 h-9 w-9 cursor-pointer"
              dotSize={10}
            />
          )}
        </UserHoverCard>
      ) : (
        // Compact continuation: the left column matches the avatar slot
        // (w-12) so the body aligns with first-in-group rows, and reveals
        // the message time there on hover. Right-aligned so the time sits
        // under the right-hugging avatar, close to the text. Wide enough to
        // fit a readable 12px (text-xs) EU-style "15:55" on one line —
        // wrapping would reserve a second line of height on every grouped
        // row (even while invisible at opacity-0), bloating the list.
        <div className="w-14 shrink-0 select-none text-right" data-testid="group-time-gutter">
          <time
            dateTime={message.createdAt}
            className={`whitespace-nowrap text-xs leading-5 tabular-nums text-muted-foreground transition-opacity ${
              hovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {formatTime(message.createdAt)}
          </time>
        </div>
      )}

      <div className="flex-1 min-w-0">
        {firstInGroup && (
        <div className="flex items-baseline gap-2">
          <UserHoverCard
            userId={message.authorID}
            displayName={displayAuthorName}
            avatarURL={displayAuthorAvatarURL}
            userStatus={authorUserStatus}
            online={authorOnline}
            currentUserId={currentUserId}
            integrationOwnerName={integrationOwnerName}
            // min-w-0 lets the trigger shrink inside the header row so the
            // name truncates; the default inline-flex trigger has
            // min-width:auto and would push timestamp/badges off-screen on a
            // long (webhook) author name.
            triggerClassName="flex min-w-0 cursor-pointer items-center gap-1"
          >
            <span className="min-w-0 cursor-pointer truncate text-sm font-semibold">{displayAuthorName}</span>
          </UserHoverCard>
          {message.webhookUsername && (
            <span
              className="rounded bg-muted px-1 text-[10px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground"
              aria-label="Bot"
            >
              BOT
            </span>
          )}
          {message.agentInvokerID && (
            // Shared agents post on someone's behalf — say whose ("gg · for
            // Bob"), mirroring the "bob's gg" naming agents see in context.
            // With a run link, the badge doubles as the door to the run
            // drawer (timeline, artifacts, spend).
            <button
              type="button"
              disabled={!message.agentRunID}
              onClick={() => message.agentRunID && openRunDrawer(message.agentRunID)}
              title={message.agentRunID ? 'Show agent activity' : undefined}
              className={`shrink-0 rounded bg-muted px-1 text-[10px] font-medium leading-4 text-muted-foreground ${
                message.agentRunID ? 'cursor-pointer hover:bg-accent hover:text-foreground' : ''
              }`}
              aria-label={`Invoked by ${userMap?.get(message.agentInvokerID)?.displayName ?? 'a teammate'}`}
            >
              for {userMap?.get(message.agentInvokerID)?.displayName ?? 'a teammate'}
            </button>
          )}
          <Tooltip>
            <TooltipTrigger
              // Timestamp sits right after the author name (Slack-style),
              // separated by the header row's gap-2. shrink-0 + nowrap so a
              // relative label ("3 minutes ago") never wraps onto a second
              // row on narrow mobile headers — the author name (min-w-0,
              // truncate) is the element that gives way.
              className="shrink-0 whitespace-nowrap text-xs text-muted-foreground cursor-default"
              render={<time dateTime={message.createdAt} />}
            >
              {/* Threads have no day dividers, so an absolute clock time is
                  ambiguous about which day — show a relative "… ago" label. */}
              {inThread ? formatRelative(message.createdAt) : formatTime(message.createdAt)}
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
              className="inline-flex items-center gap-0.5 text-xs text-pinned"
              aria-label="Pinned"
            >
              <Pin className="h-3 w-3" />
              Pinned
            </span>
          )}
          {myWatchers.length > 0 && (
            <button
              type="button"
              onClick={() => setManageWatchersOpen(true)}
              className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary transition-colors hover:bg-primary/20"
              aria-label={`Watching — ${myWatchers.length} agent watcher${myWatchers.length > 1 ? 's' : ''} (click to manage)`}
              data-testid="watcher-indicator"
            >
              <Eye className="h-3 w-3" />
              Watching{myWatchers.length > 1 ? ` ·${myWatchers.length}` : ''}
            </button>
          )}
        </div>
        )}

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
              <MessageBody
                message={message}
                emojiMap={emojiMap}
                currentUserId={currentUserId}
                onContentHeightChange={onContentHeightChange}
                openTag={openTag}
              />
            </div>
            {/* Grouped rows have no header (that's where the header rows show
                "(edited)"), so an edit would otherwise be invisible — surface
                the marker under the body instead. */}
            {!firstInGroup && message.editedAt && (
              <span data-testid="grouped-edited-marker" className="text-xs text-muted-foreground">
                (edited)
              </span>
            )}
            {(() => {
              if (message.noUnfurl) return null;
              // First URL in the body (skipping code) gets a preview
              // card. Capped at one to keep messages compact.
              const urls = bodyURLs;
              return urls[0] ? (
                <UnfurlCard
                  url={urls[0]}
                  messageId={message.id}
                  channelId={channelId}
                  conversationId={conversationId}
                  isAuthor={isOwn}
                  onContentHeightChange={onContentHeightChange}
                />
              ) : null;
            })()}
            {message.attachmentIDs && message.attachmentIDs.length > 0 && (
	              <MessageAttachments
	                ids={message.attachmentIDs}
	                parentID={channelId ?? conversationId}
	                parentType={channelId ? 'channel' : conversationId ? 'conversation' : undefined}
	                messageID={message.id}
	                authorName={displayAuthorName}
                authorAvatarURL={displayAuthorAvatarURL}
                postedIn={
                  channelSlug
                    ? `~${channelSlug}`
                    : conversationId
                      ? 'Direct message'
                      : undefined
                }
                postedAt={message.createdAt}
                onContentHeightChange={onContentHeightChange}
              />
            )}
            <MessageRichAttachments attachments={message.messageAttachments} onContentHeightChange={onContentHeightChange} />
            {reactionEntries.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1" role="list" aria-label="Reactions">
                {reactionEntries.map(([emoji, users]) => {
                  const reactedByMe = currentUserId ? users.includes(currentUserId) : false;
                  return (
                    <ReactionChip
                      key={emoji}
                      reactedByMe={reactedByMe}
                      ariaLabel={`${renderReactionLabel(emoji)} ${users.length}, ${reactedByMe ? 'reacted' : 'react'}`}
                      reactorsText={`${formatReactors(users)} reacted with ${renderReactionLabel(emoji)}`}
                      isMobile={isMobile}
                      onToggle={() => handleReact(emoji)}
                      tooltipContent={
                        <>
                          <EmojiGlyph emoji={emoji} customMap={emojiMap} size="xl" />
                          <span className="text-xs leading-snug">
                            <span className="font-medium">{formatReactors(users)}</span>
                            <span className="text-muted-foreground"> reacted with </span>
                            <span className="font-medium">{renderReactionLabel(emoji)}</span>
                          </span>
                        </>
                      }
                    >
                      {renderReactionVisual(emoji)}
                      <span className="text-xs leading-5 text-muted-foreground tabular-nums">{users.length}</span>
                    </ReactionChip>
                  );
                })}
                <EmojiPicker
                  onSelect={handleReact}
                  triggerClassName="inline-flex items-center self-stretch"
                  trigger={
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-full min-h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
                      aria-label="Add another reaction"
                    >
                      <SmilePlus className="h-4 w-4" />
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
          className="absolute right-2 -top-3 flex items-center gap-0.5 rounded-md border bg-background shadow-sm transition-opacity mobile:hidden"
          style={{ opacity: toolbarVisible ? 1 : 0 }}
          data-actions-pinned={actionsMenuOpen ? 'true' : 'false'}
          data-actions-visible={toolbarVisible ? 'true' : 'false'}
          role="toolbar"
          aria-label="Message actions"
        >
          {(quickReactions ?? []).slice(0, 3).map((emoji) => (
            <Button
              key={`quick-${emoji}`}
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                // Reacting via a quick button is also an emoji "use" — record
                // it so the popular shelf reorders and refreshes live.
                void recordEmojiUse(emoji);
                handleReact(emoji);
              }}
            >
              <EmojiGlyph emoji={emoji} customMap={emojiMap} size="md" />
            </Button>
          ))}
          <EmojiPicker
            onSelect={handleReact}
            trigger={
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Add reaction">
                <SmilePlus className="h-4 w-4" />
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
              {(message.agentRunID || (!message.parentMessageID && (message.replyCount ?? 0) > 0)) && (
                <DropdownMenuItem
                  onClick={() =>
                    !message.parentMessageID && (message.replyCount ?? 0) > 0
                      ? openThreadDrawer(message.parentID, message.id)
                      : openRunDrawer(/* istanbul ignore next -- the menu item's gate guarantees agentRunID */ message.agentRunID ?? '')
                  }
                  aria-label="Show agent activity"
                >
                  <Bot className="mr-2 h-4 w-4" />
                  Show activity
                </DropdownMenuItem>
              )}
              {/* Static labels: the menu closes on click, so a "… copied"
                  swap would never be seen on desktop. */}
              <DropdownMenuItem
                onClick={handleCopyLink}
                aria-label="Copy link to message"
              >
                <LinkIcon className="mr-2 h-4 w-4" />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleCopyText}
                aria-label="Copy message text"
              >
                <Copy className="mr-2 h-4 w-4" />
                Copy text
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="remind-me-trigger">
                  <AlarmClock className="mr-2 h-4 w-4" /> Remind me
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {REMINDER_PRESETS.map((preset) => (
                    <DropdownMenuItem
                      key={preset.key}
                      onClick={() => handleReminderPreset(preset.key)}
                      data-testid={`remind-${preset.key}`}
                    >
                      {preset.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={openCustomReminder} data-testid="remind-custom">
                    Custom…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                onClick={() => setWatcherDialogOpen(true)}
                data-testid="watch-thread"
                aria-label="Add a watcher to this thread"
              >
                <Eye className="mr-2 h-4 w-4" /> Watch thread…
              </DropdownMenuItem>
              {isOwn && (
                <>
                  {canEdit && (
                    <DropdownMenuItem onClick={startEdit}>
                      <Pencil className="mr-2 h-4 w-4" /> Edit
                    </DropdownMenuItem>
                  )}
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
      {mobileActionsOverlay ? createPortal(mobileActionsOverlay, document.body) : null}
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
      {reminderDialogOpen && (
        <ReminderDialog
          open
          onOpenChange={setReminderDialogOpen}
          initialValue={reminderSeed}
          onConfirm={scheduleReminderAsync}
        />
      )}
      {watcherDialogOpen && (
        <WatcherDialog
          open
          onOpenChange={setWatcherDialogOpen}
          parentID={message.parentID}
          parentType={message.parentType === 'conversation' ? 'conversation' : 'channel'}
          threadRootID={message.parentMessageID || message.id}
        />
      )}
      {manageWatchersOpen && editingWatchers.length > 0 && (
        <WatcherDialog
          open
          onOpenChange={(o) => {
            /* istanbul ignore else -- the dialog never calls onOpenChange(true) */
            if (!o) setManageWatchersOpen(false);
          }}
          parentID={message.parentID}
          parentType={message.parentType === 'conversation' ? 'conversation' : 'channel'}
          threadRootID={message.parentMessageID || message.id}
          editingList={editingWatchers}
        />
      )}
    </div>
  );
}

// Memoised so a re-render of a parent that renders many rows (notably
// ThreadPanel, which maps MessageItem directly without an intermediate
// memoised row) only re-renders the rows whose props actually changed. In the
// main MessageList each row already sits behind a memoised MessageRow; this
// guards the other call sites.
export const MessageItem = memo(MessageItemImpl);

// MessageBody is a separately-memoized wrapper around renderMarkdown
// so that scroll-induced re-renders of MessageItem do not call into
// the hast hydrator (or rebuild the rendered React tree) unless one
// of the meaningful inputs actually changed. Without this memo the
// renderer ran on every parent re-render and — combined with the
// previously-fresh hast components map — caused every Giphy <video>
// in view to re-fetch its mp4 on every pixel of scroll.
interface MessageBodyProps {
  message: Message;
  emojiMap: Record<string, string> | undefined;
  currentUserId?: string;
  onContentHeightChange?: () => void;
  openTag: (tag: string) => void;
}

const MessageBody = memo(function MessageBody({
  message,
  emojiMap,
  currentUserId,
  onContentHeightChange,
  openTag,
}: MessageBodyProps) {
  // Artifact marker messages render as a compact expand/download card
  // instead of markdown — the marker is machine syntax, not prose.
  const artifactMarker = parseArtifactMarker(message.body);
  if (artifactMarker) {
    return <ArtifactCard marker={artifactMarker} />;
  }
  // Coding-task card markers (the root of a task thread) render as a live
  // task card: flair, state, links, and the requester's sign-off.
  const taskMarker = parseTaskMarker(message.body);
  if (taskMarker) {
    return <TaskCard marker={taskMarker} currentUserId={currentUserId} />;
  }
  return (
    <>
      {renderMarkdown(message.body, {
        tree: message.rendered,
        emojiMap,
        largeEmoji: isEmojiOnlyMessage(message.body, emojiMap),
        currentUserId,
        onMediaLoad: onContentHeightChange,
        onTagClick: openTag,
        renderUserMention: (userId, displayName, _isSelf, pill) => (
          <UserHoverCard
            key={`mention-${userId}-${message.id}`}
            userId={userId}
            displayName={displayName}
            currentUserId={currentUserId}
            showInlineStatus={false}
            triggerClassName="inline cursor-pointer align-baseline"
          >
            {pill}
          </UserHoverCard>
        ),
      })}
    </>
  );
});
