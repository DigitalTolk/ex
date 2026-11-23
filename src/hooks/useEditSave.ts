import { useCallback } from 'react';
import { useEditMessage } from '@/hooks/useMessages';
import { showToast } from '@/lib/toast';
import { EDIT_SAVE_FAILED } from '@/lib/edit-save';
import type { Message } from '@/types';

export interface EditedMessage {
  body: string;
  attachmentIDs: string[];
}

// useEditSave saves an edit made in a composer (a phone edits in the chat's
// own composer, not inline): one rule for every view that does it. It returns
// the save, so the composer keeps the text and files until it lands; a
// refused save says so and leaves the edit open with everything in it. An
// unchanged edit, or one emptied of everything, just closes.
export function useEditSave(
  parent: { channelId?: string; conversationId?: string },
  close: () => void,
) {
  const editMessage = useEditMessage();
  const save = editMessage.mutateAsync;
  const { channelId, conversationId } = parent;
  const saveEdit = useCallback(
    (message: Message, value: EditedMessage): Promise<unknown> | undefined => {
      const current = message.attachmentIDs ?? [];
      const same =
        value.body === message.body &&
        value.attachmentIDs.length === current.length &&
        value.attachmentIDs.every((id, i) => id === current[i]);
      if (same || (!value.body.trim() && value.attachmentIDs.length === 0)) {
        close();
        return undefined;
      }
      return save({ messageId: message.id, body: value.body, attachmentIDs: value.attachmentIDs, channelId, conversationId }).then(
        close,
        (err: unknown) => {
          showToast(EDIT_SAVE_FAILED);
          throw err;
        },
      );
    },
    [save, close, channelId, conversationId],
  );
  return { saveEdit, saving: editMessage.isPending };
}
