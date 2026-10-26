import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SmilePlus, MoreHorizontal, AlarmClock, Eye, Pin, Zap, type LucideIcon } from 'lucide-react';
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
import { LazyReminderDialog as ReminderDialog } from '@/components/chat/LazyReminderDialog';
import { WatcherDialog } from '@/components/chat/WatcherDialog';
import { NotSentMark } from '@/components/chat/MessageSendState';
import { useMessageRowData, useProvidedMessageRowData, type MessageRowData } from '@/hooks/useMessageRowData';
import { EmojiPicker } from '@/components/EmojiPicker';
import { UserHoverCard } from '@/components/UserHoverCard';
import { UserAvatar } from '@/components/UserAvatar';
import { useEditMessage, useToggleReaction } from '@/hooks/useMessages';
import { renderMarkdown } from '@/lib/markdown';
import { isEmojiOnlyMessage } from '@/lib/emoji-shortcodes';
import { recordEmojiUse } from '@/lib/emoji-frequency';
import { padQuickReactions } from '@/lib/quick-reactions';
import { triggerReactionHaptic } from '@/lib/haptics';
import { blurActiveInput } from '@/lib/blur-input';
import { showToast } from '@/lib/toast';
import { MESSAGE_LONG_PRESS_MS, useLongPress } from '@/hooks/useLongPress';
import { useTagOpen } from '@/context/TagSearchContext';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { ThreadActionBar } from '@/components/chat/ThreadActionBar';
import { UnfurlCard } from '@/components/chat/UnfurlCard';
import { MessageRichAttachments } from '@/components/chat/MessageRichAttachments';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { extractURLs, formatLongDateTime, formatRelative } from '@/lib/format';
import { registerEditMessageHandler } from '@/lib/window-events';
import { openRunDrawer } from '@/stores/run-drawer';
import { ArtifactCard } from '@/components/chat/ArtifactCard';
import { TaskCard } from '@/components/chat/TaskCard';
import { parseArtifactMarker } from '@/lib/artifact-marker';
import { parseTaskMarker } from '@/lib/task-marker';
import { hasDesignMarkers } from '@/lib/design-markers';
import { DesignMarkers } from '@/components/projects/DesignMarkers';
import { useIsMobile } from '@/hooks/useIsMobile';
import { deviceKind, isHoverPointer } from '@/lib/device';
import { isKeyboardModality, startInputModalityTracking } from '@/lib/input-modality';
import { usePointerDevice } from '@/hooks/usePointerDevice';
import { motion } from 'motion/react';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';
import { useIsOnline } from '@/stores/presence';
import { useMessageActions, type MessageAction } from '@/components/chat/useMessageActions';
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

// The sheet's sections settle in one after another, a beat apart, so the
// eye lands on the reactions first. Short enough never to feel like waiting.
function sheetSection(index: number) {
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.18, delay: 0.04 * index },
  };
}

// SheetTile is one of the long-press sheet's everyday actions: an icon over
// a short label, four to a row, so the sheet stays under half the screen.
function SheetTile({
  icon: Icon,
  label,
  ariaLabel,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  ariaLabel: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="flex h-20 min-w-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl bg-muted text-xs font-medium transition-transform active:scale-95"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-background shadow-xs">
        <Icon className="h-4 w-4" />
      </span>
      {label}
    </button>
  );
}

// The toolbar is the only part of a row that follows the pointer, so hover
// and focus-within live in this little store and only RowHoverGate (around
// the toolbar) subscribes to it: the row itself never re-renders for a hover.
// A row render re-runs every tooltip, hover card and reaction chip in it, a
// dozen components, and that used to happen for every row the pointer
// crossed. The row uses React's onPointerEnter/onPointerLeave, which treat
// a portal (the emoji picker, a tooltip) as inside the row, so moving the
// pointer into a picker keeps the toolbar mounted. Pointer events, not mouse
// events: a finger's tap makes the browser replay mouse events, and only the
// pointer event's own type tells a tap from a hover (isHoverPointer).
// `data-hovered` on the row drives the CSS-only hover reveals (a grouped
// row's clock time); tracked in JS rather than Tailwind group-hover because
// an open dropdown changes pointer-events and focus and breaks CSS :hover on
// the row.
interface RowHoverState {
  hovered: boolean;
  focusWithin: boolean;
}
// Focus inside a row pins its toolbar so a keyboard user can Tab to it. But a
// mouse click focuses buttons too (Chrome), so clicking a quick reaction kept
// that row's toolbar up after the pointer moved on and the next row hovered
// showed a second one. Only keyboard-driven focus pins (lib/input-modality,
// where Escape doesn't count: closing a menu opened by a click must not pin
// the row's toolbar open around the button focus returns to).
// The handlers read the row element off the event (currentTarget), so the
// store needs no refs and the row never writes one during render.
function createRowHoverStore() {
  startInputModalityTracking();
  let state: RowHoverState = { hovered: false, focusWithin: false };
  // The row last entered, so a hover ended from elsewhere (another row took
  // the pointer while this one's menu was open) can drop its flag too.
  let row: HTMLDivElement | null = null;
  const listeners = new Set<() => void>();
  const update = (next: Partial<RowHoverState>) => {
    state = { ...state, ...next };
    for (const cb of listeners) cb();
  };
  return {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => state,
    enter: (event: PointerEvent<HTMLDivElement>) => {
      if (!isHoverPointer(event.pointerType)) return;
      row = event.currentTarget;
      row.dataset.hovered = 'true';
      update({ hovered: true });
      notifyMessageHovered(String(row.dataset.messageId));
    },
    leave: () => {
      if (row) delete row.dataset.hovered;
      update({ hovered: false });
    },
    focus: () => {
      if (isKeyboardModality()) update({ focusWithin: true });
    },
    blur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) update({ focusWithin: false });
    },
  };
}
type RowHoverStore = ReturnType<typeof createRowHoverStore>;

function RowHoverGate({
  store,
  messageId,
  pinned,
  disabled,
  children,
}: {
  store: RowHoverStore;
  messageId: string;
  // An open "..." menu keeps the toolbar even once the pointer has left.
  pinned: boolean;
  // Editing, deleted and pending rows have no toolbar.
  disabled: boolean;
  children: () => ReactNode;
}) {
  const { hovered, focusWithin } = useSyncExternalStore(store.subscribe, store.get);
  // Another row taking the pointer ends this one's hover, whether or not
  // the browser delivered a mouseleave here (an open menu can swallow it).
  useEffect(() => {
    if (!hovered && !pinned) return;
    const onHover = (activeID: string) => {
      if (activeID !== messageId) store.leave();
    };
    messageHoverListeners.add(onHover);
    return () => {
      messageHoverListeners.delete(onHover);
    };
  }, [hovered, pinned, messageId, store]);
  if (disabled || !(hovered || focusWithin || pinned)) return null;
  return <>{children()}</>;
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
  // Read-only parent (an archived channel): the row offers only actions that
  // don't change the chat — copy, mark unread, remind — and shows reactions
  // without letting them toggle.
  readOnly?: boolean;
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
  // This root's thread has replies the viewer hasn't read: its reply bar
  // says so.
  threadHasNew?: boolean;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// formatShortTime is the clock alone ("10:45", no AM/PM) — what fits a
// continuation row's avatar-wide gutter; the full time is in its tooltip.
// One formatter for the module: building one per row per render showed up in
// the send-path profile.
const shortTimeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function formatShortTime(dateStr: string): string {
  return shortTimeFormat
    .formatToParts(new Date(dateStr))
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
}

// One reaction chip. Tap toggles the viewer's reaction; the "who reacted"
// list lives in a hover tooltip, which touch can't reach — so on touch devices
// (phones and iPads alike) a LONG-PRESS surfaces the same reactor list as a
// toast instead. Split out of the render loop because the long-press needs its
// own hook instance per chip.
function ReactionChip({
  reactedByMe,
  ariaLabel,
  reactorsText,
  isTouch,
  onToggle,
  disabled,
  tooltipContent,
  children,
}: {
  reactedByMe: boolean;
  ariaLabel: string;
  // Pre-formatted "Alice, Bob reacted with 👍" line for the mobile toast.
  reactorsText: string;
  isTouch: boolean;
  onToggle: () => void;
  // Read-only (archived channel): the chip still shows who reacted but
  // doesn't toggle.
  disabled?: boolean;
  tooltipContent: ReactNode;
  children: ReactNode;
}) {
  const longPress = useLongPress({
    enabled: isTouch,
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
              if (disabled || longPress.shouldSuppressClick()) return;
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
            // A filled chip with a firm outline, so it stands off the
            // message (and a hovered row) instead of melting into it; your
            // own reaction stays the strongest, outlined in the accent.
            className={`flex items-center gap-1 rounded-full border px-1.5 py-0 text-sm text-foreground transition-colors mobile:px-2 mobile:py-0.5 ${
              reactedByMe
                ? 'border-primary bg-primary/15 hover:bg-primary/20'
                : 'border-border-strong/60 bg-muted hover:border-border-strong'
            }`}
            aria-label={ariaLabel}
            aria-pressed={reactedByMe}
            aria-disabled={disabled || undefined}
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
  rowData,
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
  readOnly,
  onReplyInThread,
  onEditMessage,
  userMap,
  highlighted,
  onContentHeightChange,
  quickReactions,
  threadHasNew,
}: MessageItemProps & { rowData: MessageRowData }) {
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
  // A touch SCREEN keeps the long-press gestures armed at every width, even
  // when a trackpad is attached — an iPad user reaches for the screen anyway.
  const isTouch = deviceKind() === 'touch';
  // A mouse/trackpad brings the hover toolbar back (the `touch:hidden` class
  // drops with the root `device-touch` class), so the secondary-click stand-in
  // for it is not needed and the native selection behaviour stays.
  const pointerDevice = usePointerDevice();
  const touchOnly = isTouch && !pointerDevice;
  const [isEditing, setIsEditing] = useState(false);
  // Hover and focus-within live in the row's hover store (read only by the
  // toolbar's RowHoverGate); the "..." menu's open state is the row's, as
  // the menu items are its.
  const [hoverStore] = useState(() => createRowHoverStore());
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  // The toolbar's add-reaction picker is a portal: while it is open the
  // toolbar must stay mounted whatever the pointer does, or the picker goes
  // with it.
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [mobileActionsSuppressed, setMobileActionsSuppressed] = useState(false);
  const [mobileReactionPickerOpen, setMobileReactionPickerOpen] = useState(false);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const mobileActionsSheetRef = useRef<HTMLDivElement>(null);
  const canEdit = isOwn && !disableEditing && !readOnly;
  // Delete, pin and watch change the chat; an archived one is read-only.
  const canModify = !readOnly;
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
      if (activeID !== ownID) setActionsMenuOpen(false);
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
  const toggleReaction = useToggleReaction();
  const { emojiMap, watchers: parentWatchers, pickTokens } = rowData;
  const { openTag } = useTagOpen();

  // Watcher badge: the viewer's own thread-scoped watchers on THIS message
  // (one query per list, see MessageRowData); match by threadRootID so only
  // the watched thread's root message is badged.
  const myWatchers = useMemo(
    () => (parentWatchers ?? []).filter((w) => w.threadRootID === message.id),
    [parentWatchers, message.id],
  );
  const [manageWatchersOpen, setManageWatchersOpen] = useState(false);

  // Everything that can be done to the message, for the desktop menu and the
  // mobile sheet alike.
  const { actions, reminderPresets, deleteDialog, reminderDialog, watcherDialog } = useMessageActions({
    message,
    channelId,
    channelSlug,
    conversationId,
    currentUserId,
    inThread,
    isOwn,
    canEdit,
    canModify,
    startEdit,
    onReplyInThread,
  });

  // Touch long-press opens the mobile action sheet via the SHARED
  // useLongPress gesture (MESSAGE_LONG_PRESS_MS hold; touch/pen only; scroll drift past the
  // small threshold or release cancels; the haptic fires inside the hook).
  // This used to be a hand-rolled copy of the same pattern — keep the one
  // implementation in the hook.
  // An optimistic row (still sending, or failed) has no actions yet: it isn't
  // a real message until the server confirms it.
  const pendingState = message.pendingState;
  const mobileActionsAvailable = !isEditing && !message.deleted && !message.system && !pendingState;
  function openMobileActions() {
    // Opening the action bar should dismiss the keyboard if the composer had
    // focus, so the sheet isn't fighting the keyboard.
    blurActiveInput();
    setMobileActionsSuppressed(false);
    setMobileActionsOpen(true);
    notifyMessageHovered(message.id);
  }
  const longPress = useLongPress({
    enabled: mobileActionsAvailable,
    delayMs: MESSAGE_LONG_PRESS_MS,
    onLongPress: openMobileActions,
  });
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

  // A sheet action puts the sheet away first, then runs.
  function runFromSheet(action: MessageAction) {
    closeMobileActions();
    action.run();
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

  function handleReact(emoji: string) {
    toggleReaction.mutate({ messageId: message.id, emoji, channelId, conversationId });
  }

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
      className="fixed inset-0 z-[120] select-none [-webkit-touch-callout:none] [-webkit-user-select:none]"
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
        className={`absolute inset-x-0 bottom-0 flex max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] flex-col overflow-hidden rounded-t-xl border-x-0 border-b-0 border-t bg-popover text-popover-foreground shadow-lg md:mx-auto md:max-w-lg md:border-x ${mobileActionsSuppressed ? 'hidden' : ''}`}
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
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-1"
        >
        {/* One-tap reactions first: the most-used emojis, then the full picker. */}
        {canModify && (
        <motion.div className="mb-3 flex items-center gap-2" {...sheetSection(0)}>
          <div
            className="flex min-w-0 flex-1 items-center justify-between rounded-full bg-muted p-1"
            data-testid="mobile-quick-reactions"
          >
            {padQuickReactions(quickReactions).map((emoji) => (
              <button
                key={`sheet-quick-${emoji}`}
                type="button"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90 active:bg-background"
                aria-label={`React with ${emoji}`}
                onClick={() => {
                  triggerReactionHaptic();
                  void recordEmojiUse(emoji);
                  handleReact(emoji);
                  closeMobileActions();
                }}
              >
                <EmojiGlyph emoji={emoji} customMap={emojiMap} size="md" />
              </button>
            ))}
          </div>
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
            triggerClassName="shrink-0"
            trigger={
              <button
                type="button"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-muted transition-transform active:scale-90"
                aria-label="Add reaction"
              >
                <SmilePlus className="h-5 w-5" />
              </button>
            }
          />
        </motion.div>
        )}
        {/* The everyday actions as tiles, Reply leading as the CTA. */}
        <motion.div
          className={`mb-3 grid gap-2 ${inThread || !canModify ? 'grid-cols-3' : 'grid-cols-4'}`}
          data-testid="mobile-primary-actions"
          {...sheetSection(1)}
        >
          {actions.reply && (
            <Button
              type="button"
              className="h-20 min-w-0 flex-1 flex-col gap-1.5 rounded-2xl px-1 text-xs font-medium transition-transform active:scale-95 mobile:h-20 mobile:px-1 mobile:text-xs"
              onClick={() => runFromSheet(actions.reply!)}
              aria-label={actions.reply.ariaLabel}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15">
                <actions.reply.icon className="h-4 w-4" />
              </span>
              {actions.reply.label}
            </Button>
          )}
          {/* No "copied" swap on mobile — the sheet closes on tap, so the
              label change would never be visible. The reminder tile goes
              straight to the custom time; the quick times are the desktop
              submenu's. */}
          {[actions.copyText, actions.copyLink, actions.remind].map((action) => (
            <SheetTile
              key={action.label}
              icon={action.icon}
              label={action.label}
              ariaLabel={action.ariaLabel!}
              onClick={() => runFromSheet(action)}
              testId={action === actions.remind ? 'mobile-remind' : undefined}
            />
          ))}
        </motion.div>
        {/* Everything else as a short list. */}
        <motion.div className="flex flex-col divide-y divide-border/60 rounded-2xl bg-muted" {...sheetSection(2)}>
          {[actions.activity, actions.pin, actions.markUnread, actions.watch, actions.edit, actions.delete].map(
            (action) =>
              action && (
                <button
                  key={action.label}
                  type="button"
                  className={action.destructive ? 'flex items-center gap-3 px-4 py-3 text-left text-sm text-destructive' : 'flex items-center gap-3 px-4 py-3 text-left text-sm'}
                  onClick={() => runFromSheet(action)}
                  aria-label={action.ariaLabel}
                  data-testid={action.testId ? `mobile-${action.testId}` : undefined}
                >
                  <action.icon className="h-4 w-4" />
                  {action.label}
                </button>
              ),
          )}
        </motion.div>
        </div>
      </motion.div>
      )}
    </div>
  ) : null;

  return (
    <div
      id={`msg-${message.id}`}
      data-message-id={message.id}
      onPointerEnter={hoverStore.enter}
      onFocus={hoverStore.focus}
      onBlur={hoverStore.blur}
      {...longPress.handlers}
      onPointerLeave={() => {
        longPress.cancel();
        hoverStore.leave();
      }}
      onContextMenu={(event) => {
        // Without a pointing device there is no hover toolbar to reach, so a
        // secondary click (an iPad keyboard case, or Android's long-press
        // contextmenu) stands in for it and opens the action sheet.
        if (!touchOnly) return;
        event.preventDefault();
        if (mobileActionsAvailable) openMobileActions();
      }}
      // The avatar sits in a column beside the message; gap-3 to the text,
      // matched by px-3 so it sits balanced inside the row. A new group's
      // extra room goes above it only, so every line of one author is the
      // same distance apart, and every new author the same distance from
      // the lines before, however many there were.
      className={`group relative flex items-start gap-3 rounded-md px-3 mobile:gap-2 mobile:px-2 ${firstInGroup ? 'pt-3 pb-0.5' : 'py-0.5'} hover:bg-chat-hover ${
        message.pinned ? 'border-l-2 border-pinned pl-2.5' : ''
      } ${highlighted ? 'ring-1 ring-inset ring-amber-400/50 rounded-md' : ''} touch:select-none touch:touch-pan-y touch:[-webkit-touch-callout:none] touch:[-webkit-user-select:none]`}
      data-pending={pendingState}
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
          // The avatar's own width, matching the grouped rows' time column
          // (w-9) so the text lines up on every row; its top is level with
          // the name line's.
          triggerClassName="inline-flex w-9 shrink-0 cursor-pointer items-center justify-center"
        >
          {message.webhookIconEmoji ? (
            <div
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-muted"
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
              className="h-9 w-9 cursor-pointer"
              dotSize={10}
              initialsClassName="text-sm font-medium"
            />
          )}
        </UserHoverCard>
      ) : (
        // Grouped rows: a column the avatar's width, so the text lines up with
        // the first row, showing the clock time on hover (full time in the
        // tooltip). One text line tall, so it never makes the row taller.
        <div className="relative w-9 shrink-0 select-none text-center text-xs leading-5" data-testid="group-time-gutter">
          <Tooltip>
            <TooltipTrigger
              className={`cursor-default whitespace-nowrap tabular-nums text-muted-foreground transition-opacity ${
                // Hidden under the failed mark: kept at opacity 0 too, so it
                // can't flash while fading back out once the mark goes.
                pendingState === 'failed' ? 'invisible opacity-0' : 'opacity-0 group-data-[hovered=true]:opacity-100'
              }`}
              render={<time dateTime={message.createdAt} />}
            >
              {formatShortTime(message.createdAt)}
            </TooltipTrigger>
            <TooltipContent>{formatLongDateTime(message.createdAt)}</TooltipContent>
          </Tooltip>
          {pendingState === 'failed' && (
            // Laid over the (hidden) time so the gutter keeps its exact size.
            <span className="absolute inset-x-0 top-0 flex h-5 items-center justify-center">
              <NotSentMark message={message} />
            </span>
          )}
        </div>
      )}
      <div className="min-w-0 flex-1" data-testid="message-text-column">
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
              className="rounded bg-muted px-1 text-xs font-semibold uppercase leading-4 tracking-wide text-muted-foreground"
              aria-label="Bot"
            >
              BOT
            </span>
          )}
          {message.agentInvokerID && (
            // Shared agents post on someone's behalf — say whose ("gg · for
            // Bob"), mirroring the "bob's gg" naming agents see in context.
            // With a run link, the badge doubles as the door to the run
            // drawer (timeline, artifacts, spend) — but run logs are
            // invoker-only, so the door only opens on your own runs.
            <button
              type="button"
              disabled={!message.agentRunID || message.agentInvokerID !== currentUserId}
              onClick={() =>
                message.agentRunID &&
                message.agentInvokerID === currentUserId &&
                openRunDrawer(message.agentRunID)
              }
              title={
                message.agentRunID && message.agentInvokerID === currentUserId
                  ? 'Show agent activity'
                  : undefined
              }
              className={`shrink-0 rounded bg-muted px-1 text-xs font-medium leading-4 text-muted-foreground ${
                message.agentRunID && message.agentInvokerID === currentUserId
                  ? 'cursor-pointer hover:bg-accent hover:text-foreground'
                  : ''
              }`}
              aria-label={`Invoked by ${userMap?.get(message.agentInvokerID)?.displayName ?? 'a teammate'}`}
            >
              for {userMap?.get(message.agentInvokerID)?.displayName ?? 'a teammate'}
            </button>
          )}
          {(message.agentSkills ?? []).map((skill) => (
            // Skills the run used — visible to the whole thread (unlike the
            // run's activity log, which is invoker-only).
            <span
              key={`skill-${skill}`}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 text-xs font-medium leading-4 text-muted-foreground"
              title="Skill used in this run"
              aria-label={`Used skill ${skill}`}
            >
              <Zap className="h-3 w-3" aria-hidden="true" />
              {skill}
            </span>
          ))}
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
          {pendingState === 'failed' && <NotSentMark message={message} showLabel />}
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
            {pendingState === 'sending' && (
              // Outside .prose-message: its sibling-margin rule would push
              // the text down while sending.
              <span role="status" className="sr-only" data-testid="message-sending">
                Sending
              </span>
            )}
            {/* Sending: the text is greyed until the server confirms it. */}
            <div
              className={`text-sm prose-message transition-colors duration-150 ${
                pendingState === 'sending' ? 'text-muted-foreground' : ''
              }`}
            >
              <MessageBody
                message={message}
                emojiMap={emojiMap}
                pickTokens={pickTokens}
                currentUserId={currentUserId}
                onContentHeightChange={onContentHeightChange}
                openTag={openTag}
                // Grouped rows have no header (that's where the header rows
                // show "(edited)"), so the marker rides the end of the text's
                // last line instead, Slack-style.
                trailing={
                  !firstInGroup && message.editedAt ? (
                    <span data-testid="grouped-edited-marker" className="ml-1 text-xs text-muted-foreground">
                      (edited)
                    </span>
                  ) : undefined
                }
              />
            </div>
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
            {hasDesignMarkers(message.body) && (
              <DesignMarkers
                body={message.body}
                attachmentIDs={message.attachmentIDs}
                channelId={channelId}
                conversationId={conversationId}
                messageID={message.id}
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
                      isTouch={isTouch}
                      disabled={!canModify}
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
                {canModify && (
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
                )}
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
                hasNew={threadHasNew}
                webhookAuthor={
                  isWebhook ? { displayName: displayAuthorName, avatarURL: message.webhookAvatarURL } : undefined
                }
              />
            )}
          </>
        )}
      </div>

      {/* Mounted only while shown: the toolbar carries three pickers, a menu
          and their hooks, and mounting it for every row (at opacity 0) was the
          largest cost of scrolling and of switching chats. The delete confirm
          and the reminder/watcher dialogs live outside it, so closing the menu
          doesn't unmount them. */}
      <RowHoverGate
        store={hoverStore}
        messageId={message.id}
        pinned={actionsMenuOpen || reactionPickerOpen}
        disabled={isEditing || !!message.deleted || !!pendingState}
      >
        {() => (
        <div
          className="absolute right-2 -top-3 flex items-center gap-0.5 rounded-md border border-border bg-background shadow-sm dark:border-border-strong touch:hidden"
          data-actions-pinned={actionsMenuOpen ? 'true' : 'false'}
          data-actions-visible="true"
          role="toolbar"
          aria-label="Message actions"
        >
          {canModify && (quickReactions ?? []).slice(0, 3).map((emoji) => (
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
          {canModify && (
          <EmojiPicker
            onSelect={handleReact}
            onOpenChange={setReactionPickerOpen}
            trigger={
              <Tooltip>
                <TooltipTrigger render={<Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Add reaction" />}>
                  <SmilePlus className="h-4 w-4" />
                </TooltipTrigger>
                <TooltipContent>Add reaction</TooltipContent>
              </Tooltip>
            }
          />
          )}
          {actions.reply && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={actions.reply.ariaLabel}
                    onClick={actions.reply.run}
                  />
                }
              >
                <actions.reply.icon className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent>{actions.reply.ariaLabel}</TooltipContent>
            </Tooltip>
          )}
          {/* modal={false} so other rows still receive mouseEnter while
              this menu is open — needed by the close-on-hover listener
              and the row's own :hover state. */}
          <DropdownMenu modal={false} open={actionsMenuOpen} onOpenChange={setActionsMenuOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-accent"
                    aria-label="More actions"
                    data-testid="message-actions-trigger"
                  />
                }
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent>More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-44">
              {/* Static labels: the menu closes on click, so a "… copied"
                  swap would never be seen on desktop. */}
              {[actions.activity, actions.copyLink, actions.copyText, actions.pin, actions.markUnread].map(
                (action) => action && <MenuAction key={action.label} action={action} />,
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="remind-me-trigger">
                  <AlarmClock className="mr-2 h-4 w-4" /> Remind me
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {reminderPresets.map((preset) => (
                    <DropdownMenuItem key={preset.key} onClick={preset.run} data-testid={`remind-${preset.key}`}>
                      {preset.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={actions.remind.run} data-testid="remind-custom">
                    Custom…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {[actions.watch, actions.edit, actions.delete].map(
                (action) => action && <MenuAction key={action.label} action={action} />,
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        )}
      </RowHoverGate>
      {mobileActionsOverlay ? createPortal(mobileActionsOverlay, document.body) : null}
      {/* Mounted on demand like the reminder/watcher dialogs: a dialog per
          row was a measurable share of scrolling cost. */}
      {deleteDialog.open && (
      <ConfirmDialog
        open
        onOpenChange={deleteDialog.setOpen}
        title="Delete message?"
        description="This message will be removed for everyone. Attachments stop being shared too. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={deleteDialog.confirm}
        testIDPrefix="message-delete-confirm"
      />
      )}
      {reminderDialog.open && (
        <ReminderDialog
          open
          onOpenChange={reminderDialog.setOpen}
          initialValue={reminderDialog.seed}
          onConfirm={reminderDialog.schedule}
        />
      )}
      {watcherDialog.open && (
        <WatcherDialog
          open
          onOpenChange={watcherDialog.setOpen}
          parentID={message.parentID}
          parentType={message.parentType === 'conversation' ? 'conversation' : 'channel'}
          threadRootID={message.parentMessageID || message.id}
        />
      )}
      {manageWatchersOpen && myWatchers.length > 0 && (
        <WatcherDialog
          open
          onOpenChange={(o) => {
            /* istanbul ignore else -- the dialog never calls onOpenChange(true) */
            if (!o) setManageWatchersOpen(false);
          }}
          parentID={message.parentID}
          parentType={message.parentType === 'conversation' ? 'conversation' : 'channel'}
          threadRootID={message.parentMessageID || message.id}
          editingRows={myWatchers}
        />
      )}
    </div>
  );
}

// A desktop "More actions" item from a message action descriptor.
function MenuAction({ action }: { action: MessageAction }) {
  return (
    <DropdownMenuItem
      onClick={action.run}
      aria-label={action.ariaLabel}
      data-testid={action.testId}
      variant={action.destructive ? 'destructive' : undefined}
    >
      <action.icon className="mr-2 h-4 w-4" /> {action.label}
    </DropdownMenuItem>
  );
}

// Standalone (no MessageRowDataProvider above): fetch the shared row data
// here, once per row, as every row used to.
function StandaloneMessageItem(props: MessageItemProps) {
  const parentType: 'channel' | 'conversation' = props.channelId
    ? 'channel'
    : props.conversationId || props.message.parentType === 'conversation'
      ? 'conversation'
      : 'channel';
  const rowData = useMessageRowData(parentType, props.message.parentID);
  return <MessageItemImpl {...props} rowData={rowData} />;
}

// Memoised so a re-render of a parent that renders many rows (notably
// ThreadPanel, which maps MessageItem directly without an intermediate
// memoised row) only re-renders the rows whose props actually changed. In the
// main MessageList each row already sits behind a memoised MessageRow; this
// guards the other call sites.
export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  const provided = useProvidedMessageRowData();
  return provided ? <MessageItemImpl {...props} rowData={provided} /> : <StandaloneMessageItem {...props} />;
});

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
  // Known /pick tokens (installed connectors + workspace skills) render as
  // pills in the SENT message too — the token stays meaningful after send
  // instead of degrading to plain text the moment it leaves the composer.
  pickTokens: ReadonlySet<string>;
  currentUserId?: string;
  onContentHeightChange?: () => void;
  openTag: (tag: string) => void;
  // Rendered at the end of the body's last line (see RenderOpts.trailing).
  trailing?: ReactNode;
}

const MessageBody = memo(function MessageBody({
  message,
  emojiMap,
  pickTokens,
  currentUserId,
  onContentHeightChange,
  openTag,
  trailing,
}: MessageBodyProps) {
  // Marker syntax is plain text anyone can type, so a card renders only for
  // a post an agent run made (agentRunID is stamped by the server, never
  // taken from the client); anything else stays the markdown it is.
  // Artifact marker messages render as a compact expand/download card
  // instead of markdown — the marker is machine syntax, not prose — and only
  // when the run that posted it is the run the artifact belongs to.
  const artifactMarker = parseArtifactMarker(message.body);
  if (artifactMarker && message.agentRunID === artifactMarker.runID) {
    return <ArtifactCard marker={artifactMarker} />;
  }
  // Coding-task card markers (the root of a task thread) render as a live
  // task card: flair, state, links, and the requester's sign-off.
  const taskMarker = parseTaskMarker(message.body);
  if (taskMarker && message.agentRunID) {
    return <TaskCard marker={taskMarker} messageId={message.id} currentUserId={currentUserId} />;
  }
  return (
    <>
      {renderMarkdown(message.body, {
        tree: message.rendered,
        pickTokens,
        emojiMap,
        largeEmoji: isEmojiOnlyMessage(message.body, emojiMap),
        currentUserId,
        onMediaLoad: onContentHeightChange,
        onTagClick: openTag,
        trailing,
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
