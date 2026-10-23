import { useCallback, type RefObject } from 'react';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';
import type { WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY_CHARS,
  countCodepoints,
} from '@/lib/limits';
import { normalizeEmojiInBody } from '@/lib/emoji-shortcodes';
import type { MessageInputValue } from './MessageInput';
import type { SlashCommandOutcome } from './useSlashCommands';

interface ComposerSubmitOptions {
  editorRef: RefObject<WysiwygEditorHandle | null>;
  body: string;
  drafts: DraftAttachment[];
  disabled: boolean;
  isUploading: boolean;
  variant: 'composer' | 'inline';
  isMobile: boolean;
  submitLabel?: string;
  onSend: (value: MessageInputValue) => void;
  onSchedule?: (value: MessageInputValue, sendAt: Date) => Promise<void>;
  submitCommand: (trimmed: string, hasAttachments: boolean) => SlashCommandOutcome;
  clearDraft: () => void;
  collapseMobileComposer: () => void;
}

// useComposerSubmit checks whether the composed message may go and sends it
// (Enter, Send, Save) or schedules it, then empties the composer — always
// from the editor's current text, never from the last render's copy.
export function useComposerSubmit({
  editorRef,
  body,
  drafts,
  disabled,
  isUploading,
  variant,
  isMobile,
  submitLabel,
  onSend,
  onSchedule,
  submitCommand,
  clearDraft,
  collapseMobileComposer,
}: ComposerSubmitOptions) {
  // Codepoint cap mirrors the backend rule: the user pastes "🚀🚀🚀…",
  // each emoji is one user-visible char, and we count it as one — not
  // as four bytes or two UTF-16 units.
  const bodyCodepoints = countCodepoints(body);
  const bodyOverLimit = bodyCodepoints > MAX_MESSAGE_BODY_CHARS;
  const attachmentsOverLimit = drafts.length > MAX_ATTACHMENTS_PER_MESSAGE;

  const sendable = useCallback(
    (text: string) =>
      (text.trim() !== '' || drafts.length > 0) &&
      !disabled &&
      !isUploading &&
      countCodepoints(text) <= MAX_MESSAGE_BODY_CHARS &&
      !attachmentsOverLimit,
    [drafts.length, disabled, isUploading, attachmentsOverLimit],
  );
  const canSend = sendable(body);
  // What the editor holds now, for sending. `body` is the last render's copy:
  // the re-render a keystroke schedules can still be pending when Enter or a
  // tap on Send arrives (a busy browser handles input first), and sending it
  // dropped the last characters typed — or made a Save see a changed edit as
  // unchanged and close without saving it.
  const currentBody = useCallback(() => editorRef.current?.getMarkdown() ?? body, [body, editorRef]);

  // clearAfterSubmit empties the composer once its message has gone (sent or
  // scheduled), then either folds the phone composer (and an edit box) away
  // or puts the caret back for the next message.
  const clearAfterSubmit = useCallback(() => {
    clearDraft();
    if (isMobile || submitLabel) {
      collapseMobileComposer();
      return;
    }
    queueMicrotask(() => editorRef.current?.focus());
  }, [clearDraft, isMobile, submitLabel, collapseMobileComposer, editorRef]);

  const handleSend = useCallback(() => {
    const text = currentBody();
    if (!sendable(text)) return;
    const trimmed = text.trim();
    const command = submitCommand(trimmed, drafts.length > 0);
    if (command === 'busy') return;
    if (command === 'not-a-command') {
      onSend({ body: normalizeEmojiInBody(trimmed), attachmentIDs: drafts.map((d) => d.id) });
    }
    if (variant === 'inline') return; // parent unmounts the inline edit
    clearAfterSubmit();
  }, [sendable, currentBody, drafts, onSend, variant, submitCommand, clearAfterSubmit]);

  // handleSchedule sends the composed message later. The composer clears only
  // once it's scheduled, so a failure keeps the text.
  const handleSchedule = useCallback(async (sendAt: Date) => {
    const text = currentBody();
    /* istanbul ignore next -- the schedule menu only renders with onSchedule and is disabled while !canSend; defensive */
    if (!sendable(text) || !onSchedule) return;
    await onSchedule({ body: normalizeEmojiInBody(text.trim()), attachmentIDs: drafts.map((d) => d.id) }, sendAt);
    clearAfterSubmit();
  }, [sendable, currentBody, onSchedule, drafts, clearAfterSubmit]);

  return { canSend, bodyCodepoints, bodyOverLimit, attachmentsOverLimit, handleSend, handleSchedule };
}
