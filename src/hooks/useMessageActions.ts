import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Message } from '@/types';

// Interactive attachment actions (Mattermost's interactive messages). Clicking a
// button or picking from a select calls the integration that posted the
// attachment; the server holds the callback URL and never sends it here, so the
// client only ever names the action's id.

export interface InvokeActionInput {
  parentType: 'channel' | 'conversation';
  parentID: string;
  messageID: string;
  actionID: string;
  /** The chosen value, for a select action. */
  selectedOption?: string;
}

export interface ActionResult {
  /** Text for the invoking user only — never posted into the chat. */
  ephemeral_text?: string;
  /** The updated post, when the integration rewrote it. Also arrives over the
   *  WebSocket as message.edited, so no cache write is needed here. */
  message?: Message;
}

export function useInvokeMessageAction() {
  return useMutation({
    mutationFn: ({ parentType, parentID, messageID, actionID, selectedOption }: InvokeActionInput) =>
      apiFetch<ActionResult>(
        `/api/v1/${parentType === 'channel' ? 'channels' : 'conversations'}/${encodeURIComponent(parentID)}` +
          `/messages/${encodeURIComponent(messageID)}/actions/${encodeURIComponent(actionID)}`,
        {
          method: 'POST',
          body: JSON.stringify({ selected_option: selectedOption ?? '' }),
        },
      ),
  });
}
