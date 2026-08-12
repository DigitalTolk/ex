import { useMemo, useState } from 'react';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { Message } from '@/types';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';

// The mobile edit-composer's attachment plumbing, shared by ChannelView and
// ConversationView (it was a character-for-character duplicated block — the
// review's measured twin hotspot). On mobile, editing happens in the main
// composer, which needs the message's existing attachments resolved into
// draft chips; on desktop the inline editor owns its own state, so the
// resolve is skipped entirely (activeEditingMessage stays null).
export function useEditingMessage(
  parentID: string | undefined,
  parentType: 'channel' | 'conversation',
) {
  const isMobile = useIsMobile();
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const activeEditingMessage = isMobile ? editingMessage : null;
  const editAttachmentIDs = useMemo(
    () => activeEditingMessage?.attachmentIDs ?? [],
    [activeEditingMessage],
  );
  // Pass the access context so the server authorizes the resolve — without
  // it the batch returns nothing, the edit composer opens with no attachment
  // chips, and saving would wipe the message's attachments.
  const { map: editAttachmentMap, isLoading: editAttachmentsLoading } = useAttachmentsBatch(
    editAttachmentIDs,
    activeEditingMessage
      ? { parentID, parentType, messageID: activeEditingMessage.id }
      : undefined,
  );
  const editDraftAttachments = useMemo<DraftAttachment[]>(
    () =>
      editAttachmentIDs
        .map((id): DraftAttachment | null => {
          const att = editAttachmentMap.get(id);
          if (!att) return null;
          return {
            id: att.id,
            filename: att.filename,
            contentType: att.contentType,
            size: att.size,
            progress: 1,
            ...(att.url ? { url: att.url } : {}),
            ...(att.squareThumbnailURL ? { squareThumbnailURL: att.squareThumbnailURL } : {}),
          };
        })
        .filter((att): att is DraftAttachment => att !== null),
    [editAttachmentIDs, editAttachmentMap],
  );
  // Don't open the edit composer until the chips resolved — saving with an
  // unresolved list would wipe the message's attachments.
  const editReady =
    !editingMessage || editAttachmentIDs.length === 0 || !editAttachmentsLoading;

  return {
    editingMessage,
    setEditingMessage,
    activeEditingMessage,
    editDraftAttachments,
    editReady,
  };
}
