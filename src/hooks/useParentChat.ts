import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MessageInputValue } from '@/components/chat/MessageInput';
import { useEditMessage, useSendMessage } from '@/hooks/useMessages';
import { useComposerSchedule } from '@/hooks/useScheduledMessages';
import { useDraftAttachmentChips, useDraftForScope, useSaveDraft } from '@/hooks/useDrafts';
import { useEditingMessage } from '@/hooks/useEditingMessage';
import { useReadSession } from '@/hooks/useReadSession';
import { markParentRead } from '@/lib/mark-read';
import { clearActiveParent, setActiveParent, type ParentKind } from '@/stores/active-parent';

interface ComposedMessage {
  body: string;
  attachmentIDs: string[];
}

interface UseParentChatOptions {
  kind: ParentKind;
  // The open channel or conversation; undefined while it loads.
  id: string | undefined;
  userID: string | undefined;
  // Runs before a new message is sent (the channel's non-member invite check).
  beforeSend?: (value: ComposedMessage) => void;
}

// useParentChat is what an open channel or conversation shares: it registers
// the chat as this tab's active parent (stores/active-parent — read by unread,
// notification suppression and the tab election), runs its read session
// (useReadSession, reading through markParentRead), and wires the composer:
// send, edit, draft and schedule.
export function useParentChat({ kind, id, userID, beforeSend }: UseParentChatOptions) {
  const queryClient = useQueryClient();
  const sendMessage = useSendMessage(
    kind === 'channel' ? { channelId: id, authorID: userID } : { conversationId: id, authorID: userID },
  );
  const schedule = useComposerSchedule({ parentID: id, parentType: kind });
  const draftScope = useMemo(() => ({ parentID: id, parentType: kind }), [id, kind]);
  const { data: draft } = useDraftForScope(draftScope);
  const draftAttachments = useDraftAttachmentChips(draft?.attachmentIDs);
  const editing = useEditingMessage(id, kind);
  const { editingMessage, setEditingMessage } = editing;
  const editMessage = useEditMessage();
  const saveDraftMutate = useSaveDraft().mutate;

  const handleDraftChange = useCallback(
    (value: MessageInputValue, options?: { notify?: boolean; keepalive?: boolean }) => {
      if (!id) return;
      saveDraftMutate({
        parentID: id,
        parentType: kind,
        body: value.body,
        attachmentIDs: value.attachmentIDs,
        // Keystroke saves persist silently; the focus-loss flush (notify)
        // is what surfaces the draft in the sidebar.
        silent: !options?.notify,
        keepalive: options?.keepalive,
      });
    },
    [id, kind, saveDraftMutate],
  );

  const sendMutate = sendMessage.mutate;
  const handleSendMessage = useCallback(
    (value: ComposedMessage) => {
      beforeSend?.(value);
      // Draft lifecycle (condemn at mutate, cache patch-out on success,
      // rollback on error) is owned by useSendMessage — the send IS the
      // draft-clearing event; nothing draft-specific to do here.
      sendMutate(value);
    },
    [beforeSend, sendMutate],
  );

  const editMutate = editMessage.mutate;
  const handleEditMessage = useCallback(
    (value: ComposedMessage) => {
      /* v8 ignore next 2 -- only wired as the composer's onSend while an edit is open (activeEditingMessage, hence editingMessage, is set), so it never runs without one */
      /* istanbul ignore next -- see v8 note above */
      if (!editingMessage) return;
      const currentAttachmentIDs = editingMessage.attachmentIDs ?? [];
      const same =
        value.body === editingMessage.body &&
        value.attachmentIDs.length === currentAttachmentIDs.length &&
        value.attachmentIDs.every((attID, idx) => attID === currentAttachmentIDs[idx]);
      // An unchanged edit, or one emptied of everything, just closes.
      if (same || (!value.body.trim() && value.attachmentIDs.length === 0)) {
        setEditingMessage(null);
        return;
      }
      editMutate(
        {
          messageId: editingMessage.id,
          body: value.body,
          attachmentIDs: value.attachmentIDs,
          ...(kind === 'channel' ? { channelId: id } : { conversationId: id }),
        },
        { onSuccess: () => setEditingMessage(null) },
      );
    },
    [editMutate, editingMessage, id, kind, setEditingMessage],
  );

  // The open chat is this tab's active parent until it closes.
  useEffect(() => {
    if (!id) return;
    const parent = { kind, id };
    setActiveParent(parent);
    return () => clearActiveParent(parent);
  }, [id, kind]);

  // Opening reads the chat but keeps a "New messages" line where you left
  // off; after that it reads only while you follow along at the bottom (see
  // useReadSession).
  const markRead = useCallback(
    (openedID: string) => void markParentRead(queryClient, { kind, id: openedID }),
    [kind, queryClient],
  );
  const readSession = useReadSession(kind, id, markRead);

  // A different chat starts with no open edit.
  useEffect(() => setEditingMessage(null), [id, setEditingMessage]);

  return {
    sendMessage,
    schedule,
    draft,
    draftAttachments,
    editing,
    editMessage,
    handleDraftChange,
    handleSendMessage,
    handleEditMessage,
    readSession,
  };
}
