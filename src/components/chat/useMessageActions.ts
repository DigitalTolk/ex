import { useMemo, useState } from 'react';
import {
  AlarmClock,
  Bot,
  Copy,
  Eye,
  Link as LinkIcon,
  Mail,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useDeleteMessage, useSetPinned } from '@/hooks/useMessages';
import { useCreateReminder } from '@/hooks/useActivity';
import { useMarkUnread } from '@/hooks/useMarkUnread';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { computeReminderTime, REMINDER_PRESETS, toLocalInputValue, type ReminderPresetKey } from '@/lib/reminder-times';
import { openRunDrawer, openThreadDrawer } from '@/stores/run-drawer';
import type { Message } from '@/types';

// One message action, as both surfaces offer it: the desktop "More actions"
// menu (and toolbar) and the phone's long-press sheet render the same
// descriptors, so an action can't exist on one and be forgotten on the other.
export interface MessageAction {
  label: string;
  // The accessible name, where it says more than the label.
  ariaLabel?: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
  testId?: string;
}

export interface MessageActionsInput {
  message: Message;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  currentUserId?: string;
  inThread?: boolean;
  isOwn: boolean;
  canEdit: boolean;
  // Delete, pin, watch, react and reply change the chat; an archived one is
  // read-only.
  canModify: boolean;
  startEdit: () => void;
  onReplyInThread?: (messageId: string) => void;
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

// useMessageActions owns what can be done to a message — the actions, the
// mutations behind them and the dialogs they open — and leaves only the
// layout to each surface. An action that does not apply is undefined.
export function useMessageActions({
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
}: MessageActionsInput) {
  const deleteMessage = useDeleteMessage();
  const setPinned = useSetPinned();
  const createReminder = useCreateReminder();
  const markUnread = useMarkUnread();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false);
  const [reminderSeed, setReminderSeed] = useState('');
  const [watcherDialogOpen, setWatcherDialogOpen] = useState(false);

  // The parent TYPE comes from the view rendering the row (channelId /
  // conversationId), not message.parentType: that field is only present on
  // live WebSocket frames — messages loaded from the list API don't carry
  // it — so falling back to "channel" sent DM reminders as channel reminders,
  // which the server rejects (403) as "no access". message.parentType stays
  // the fallback for rows rendered outside a channel/conversation view.
  const parentType: 'channel' | 'conversation' = channelId
    ? 'channel'
    : conversationId || message.parentType === 'conversation'
      ? 'conversation'
      : 'channel';

  // A thread ROOT opens the whole thread's activity, any other message opens
  // its own run. Run LOGS are invoker-only server-side, so a run posted for
  // someone else gets no affordance at all (a thread root stays — the server
  // filters it to the caller's own runs).
  const activityTarget = useMemo<{ kind: 'thread' } | { kind: 'run'; runID: string } | null>(() => {
    if (!message.parentMessageID && (message.replyCount ?? 0) > 0) return { kind: 'thread' };
    if (message.agentRunID && (!message.agentInvokerID || message.agentInvokerID === currentUserId)) {
      return { kind: 'run', runID: message.agentRunID };
    }
    return null;
  }, [message.parentMessageID, message.replyCount, message.agentRunID, message.agentInvokerID, currentUserId]);

  // One builder so the preset (mutate) and custom-dialog (mutateAsync) paths
  // can't drift on the payload shape. The reminder target derives from the
  // message itself, with the channel slug carried for the deep link.
  const reminderInput = (when: Date) => ({
    messageID: message.id,
    parentID: message.parentID,
    parentType,
    channelSlug,
    remindAt: when.toISOString(),
  });

  function buildMessageLink(): string {
    const origin = window.location.origin;
    const slug = channelSlug ?? channelId;
    if (slug) return `${origin}${buildChannelHref(slug, message.id, message.parentMessageID)}`;
    if (conversationId) return `${origin}${buildConversationHref(conversationId, message.id, message.parentMessageID)}`;
    return `${origin}/#msg-${message.id}`;
  }

  const actions: {
    reply?: MessageAction;
    copyText: MessageAction;
    copyLink: MessageAction;
    remind: MessageAction;
    activity?: MessageAction;
    pin?: MessageAction;
    markUnread?: MessageAction;
    watch?: MessageAction;
    edit?: MessageAction;
    delete?: MessageAction;
  } = {
    reply:
      !inThread && canModify
        ? {
            label: 'Reply',
            ariaLabel: 'Reply in thread',
            icon: MessageSquareReply,
            run: () => onReplyInThread?.(message.id),
          }
        : undefined,
    // Copy the raw markdown body (mention tokens like `@[id|name]` intact) so
    // pasting it back into the composer re-creates the mention pills / renders
    // mentions on send — and so it round-trips as the same markdown.
    copyText: {
      label: 'Copy text',
      ariaLabel: 'Copy message text',
      icon: Copy,
      run: () => void copyToClipboard(message.body),
    },
    copyLink: {
      label: 'Copy link',
      ariaLabel: 'Copy link to message',
      icon: LinkIcon,
      run: () => void copyToClipboard(buildMessageLink()),
    },
    // The custom time: the dialog mounts fresh with a seed computed here (an
    // event handler) so the clock read stays out of render, defaulting to the
    // "in 1 hour" preset so the field reuses the quick-picks' time math.
    remind: {
      label: 'Remind me',
      ariaLabel: 'Remind me about this message',
      icon: AlarmClock,
      run: () => {
        setReminderSeed(toLocalInputValue(computeReminderTime('in1h', new Date())));
        setReminderDialogOpen(true);
      },
    },
    activity: activityTarget
      ? {
          label: 'Show activity',
          ariaLabel: 'Show agent activity',
          icon: Bot,
          run: () => {
            if (activityTarget.kind === 'thread') openThreadDrawer(message.parentID, message.id);
            else openRunDrawer(activityTarget.runID);
          },
        }
      : undefined,
    pin: canModify
      ? {
          label: message.pinned ? 'Unpin' : 'Pin',
          ariaLabel: message.pinned ? 'Unpin message' : 'Pin message',
          icon: message.pinned ? PinOff : Pin,
          run: () =>
            setPinned.mutate({ messageId: message.id, pinned: !message.pinned, channelId, conversationId }),
        }
      : undefined,
    // "Mark as unread" rewinds the chat to this message (a thread reply: the
    // thread). Not offered on a thread's root inside the thread view, where it
    // would rewind the whole channel instead of the thread being read.
    markUnread: !(inThread && !message.parentMessageID)
      ? {
          label: 'Mark as unread',
          ariaLabel: 'Mark as unread',
          icon: Mail,
          testId: 'mark-unread',
          run: () => markUnread.mutate({ parentID: message.parentID, parentType, messageID: message.id }),
        }
      : undefined,
    watch: canModify
      ? {
          label: 'Watch thread…',
          ariaLabel: 'Add a watcher to this thread',
          icon: Eye,
          testId: 'watch-thread',
          run: () => setWatcherDialogOpen(true),
        }
      : undefined,
    edit: isOwn && canModify && canEdit ? { label: 'Edit', icon: Pencil, run: startEdit } : undefined,
    delete:
      isOwn && canModify
        ? { label: 'Delete', icon: Trash2, destructive: true, run: () => setDeleteConfirmOpen(true) }
        : undefined,
  };

  // The quick reminder times (desktop submenu).
  const reminderPresets = REMINDER_PRESETS.map((preset: { key: ReminderPresetKey; label: string }) => ({
    ...preset,
    run: () => createReminder.mutate(reminderInput(computeReminderTime(preset.key, new Date()))),
  }));

  return {
    actions,
    reminderPresets,
    deleteDialog: {
      open: deleteConfirmOpen,
      setOpen: setDeleteConfirmOpen,
      confirm: () =>
        deleteMessage.mutate({
          messageId: message.id,
          parentMessageID: message.parentMessageID,
          channelId,
          conversationId,
        }),
    },
    reminderDialog: {
      open: reminderDialogOpen,
      setOpen: setReminderDialogOpen,
      seed: reminderSeed,
      // The custom dialog awaits the result so it can confirm (close) on
      // success and surface the error (stay open) on failure — scheduling is
      // never silent there.
      schedule: (when: Date) => createReminder.mutateAsync(reminderInput(when)).then(() => undefined),
    },
    watcherDialog: { open: watcherDialogOpen, setOpen: setWatcherDialogOpen },
  };
}
