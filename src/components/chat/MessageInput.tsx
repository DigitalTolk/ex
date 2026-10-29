import { useRef, useCallback, useImperativeHandle, forwardRef, type ReactNode } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useEventCallback } from '@/hooks/useEventCallback';
import { Button } from '@/components/ui/button';
import { AttachmentChip, type DraftAttachment } from '@/components/chat/AttachmentChip';
import { MarkdownComposer, type WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_BODY_CHARS } from '@/lib/limits';
import { dispatchEditMessage } from '@/lib/window-events';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useAutoFocusTextInput, useSubmitOnEnter } from '@/hooks/useHardwareKeyboard';
import { ComposerToolbar } from './ComposerToolbar';
import { ComposerLinkDialog } from './ComposerLinkDialog';
import { useCancelOnOutsidePointer } from './useCancelOnOutsidePointer';
import { useComposerDraft } from './useComposerDraft';
import { useComposerExpansion } from './useComposerExpansion';
import { useComposerFocus } from './useComposerFocus';
import { useComposerInView } from './useComposerInView';
import { useComposerSubmit } from './useComposerSubmit';
import { useComposerToolbarState } from './useComposerToolbarState';
import { useComposerUploads } from './useComposerUploads';
import { useLinkDialog } from './useLinkDialog';
import { useSlashCommands } from './useSlashCommands';
import { useTypingPing } from './useTypingPing';

export interface MessageInputValue {
  body: string;
  attachmentIDs: string[];
}

// Imperative API exposed via forwardRef so the surrounding chat view can
// route drag-and-dropped files through the same upload pipeline as the
// paperclip button.
export interface MessageInputHandle {
  uploadFiles: (files: File[]) => Promise<void>;
}

interface MessageInputProps {
  onSend: (value: MessageInputValue) => void;
  // Send the composed message later instead: shows a ⌄ beside Send. Resolves
  // once scheduled (the composer then clears like a send); rejects to keep
  // the text.
  onSchedule?: (value: MessageInputValue, sendAt: Date) => Promise<void>;
  // How many messages are scheduled from this composer's chat or thread — a
  // quiet link to them sits beside Send.
  scheduledCount?: number;
  onCancel?: () => void;
  disabled?: boolean;
  placeholder?: string;
  initialBody?: string;
  initialDrafts?: DraftAttachment[];
  // `notify` distinguishes a focus-loss flush (true → surface the draft in
  // the sidebar) from a keystroke save (omitted/false → persist silently).
  // `keepalive` marks a teardown flush (pagehide): the save should ride a
  // keepalive fetch so it survives the page dying.
  onDraftChange?: (value: MessageInputValue, options?: { notify?: boolean; keepalive?: boolean }) => void;
  cancelOnOutsidePointer?: boolean;
  hideCodeButton?: boolean;
  submitLabel?: string;
  // When true, the input renders compactly without a top border (used by
  // inline edit mode inside MessageItem).
  variant?: 'composer' | 'inline';
  // When provided, the textarea is auto-focused whenever this value
  // changes — used to re-focus the composer after the user navigates to a
  // different channel/conversation/group without unmounting the component.
  focusKey?: string;
  // When set, the composer emits "typing" frames over the WebSocket
  // (throttled to once every 3s) so other clients can render a "<user>
  // is typing" indicator. Inline edit doesn't pass this — typing while
  // editing an existing message is private.
  typingParentID?: string;
  typingParentType?: 'channel' | 'conversation';
  // When the composer is the thread reply box, this is the root message
  // ID. Including it in the typing frame lets receivers route the
  // indicator into ThreadPanel rather than the main MessageList. Absent
  // for the main composer.
  typingThreadRootID?: string;
  // ID of the user's most recent message currently loaded in the
  // surrounding list. ArrowUp on an empty composer triggers an inline
  // edit on this message via the `ex:edit-message` window event;
  // omitted (or undefined) disables the shortcut.
  lastOwnMessageId?: string;
  // Whether this composer is docked at the bottom of the viewport (the
  // main channel/conversation composer). Only then should it reserve
  // home-indicator space via env(safe-area-inset-bottom). In-list
  // composers (e.g. the /threads ThreadCards) are mid-page, so that inset
  // just adds a dead ~34px gap below them — they pass false.
  bottomInset?: boolean;
  // Rendered inside the composer's padded wrapper, directly above the input
  // box — used for the "<user> is typing" indicator so it sits glued to the
  // input (the wrapper's top padding becomes the gap to the message list
  // above the indicator) instead of floating in that padding as an outside
  // sibling. Only the composer variant renders it.
  aboveInput?: ReactNode;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput({
  onSend,
  onSchedule,
  scheduledCount = 0,
  onCancel,
  disabled = false,
  placeholder = 'Type a message...',
  initialBody = '',
  initialDrafts = [],
  submitLabel,
  variant = 'composer',
  bottomInset = true,
  focusKey,
  typingParentID,
  typingParentType,
  typingThreadRootID,
  lastOwnMessageId,
  onDraftChange,
  cancelOnOutsidePointer,
  hideCodeButton,
  aboveInput,
}, ref) {
  const editorRef = useRef<WysiwygEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { activeFormats, giphyAPIKey, giphyEnabled } = useComposerToolbarState(editorRef);
  const isMobile = useIsMobile();
  const submitOnEnter = useSubmitOnEnter();
  const autoFocusTextInput = useAutoFocusTextInput();
  const isEditingMode = submitLabel !== undefined || onCancel !== undefined;
  const suppressAutoFocus = !autoFocusTextInput && variant === 'composer';

  const { body, drafts, setDrafts, handleEditorChange, markLocallyEdited, clearDraft } = useComposerDraft({
    editorRef,
    variant,
    focusKey,
    initialBody,
    initialDrafts,
    onDraftChange,
    suppressAutoFocus,
  });
  const { isUploading, uploadError, uploadFiles, handleFileUpload, removeDraft } = useComposerUploads({
    drafts,
    setDrafts,
    markLocallyEdited,
  });
  const {
    editorFocused,
    setEditorFocused,
    compactMobileComposer,
    showToolbar,
    showToolbarSend,
    toolbarEverShown,
    collapseMobileComposer,
    handleToolbarPickerOpenChange,
  } = useComposerExpansion({
    editorRef,
    isMobile,
    variant,
    isEditingMode,
    hasContent: body.trim() !== '' || drafts.length > 0,
  });
  useComposerFocus({
    editorRef,
    variant,
    editorFocused,
    focusKey,
    suppressAutoFocus,
    typingParentID,
    typingThreadRootID,
  });
  useCancelOnOutsidePointer(rootRef, !!cancelOnOutsidePointer && isMobile && isEditingMode, onCancel);
  useComposerInView(rootRef, editorFocused);
  const { slashCommands, commandError, pendingCommand, submitCommand } = useSlashCommands({
    variant,
    submitLabel,
    onCancel,
    typingParentID,
    typingParentType,
    typingThreadRootID,
  });
  const emitTyping = useTypingPing(typingParentID, typingParentType, typingThreadRootID);
  const linkDialog = useLinkDialog(editorRef);
  const { canSend, bodyCodepoints, bodyOverLimit, attachmentsOverLimit, handleSend, handleSchedule } = useComposerSubmit({
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
  });

  // ArrowUp in an empty composer asks the surrounding list to put the
  // user's most recent loaded message into edit mode (Slack/iMessage
  // parity). Disabled when there's no candidate or when the composer
  // is itself an inline edit (initialBody non-empty).
  const requestEditLast = useCallback((): boolean => {
    if (!lastOwnMessageId || initialBody) return false;
    dispatchEditMessage({ messageId: lastOwnMessageId });
    return true;
  }, [lastOwnMessageId, initialBody]);

  useImperativeHandle(ref, () => ({ uploadFiles }));

  // Stable identities for what the toolbar, editor and pickers are handed.
  // Several read state that changes on every keystroke (the text, the draft
  // chips), which made them new functions per keystroke and re-rendered the
  // whole toolbar — format buttons, emoji and GIF pickers, the send/schedule
  // menu — on every character typed.
  const sendNow = useEventCallback(handleSend);
  const scheduleNow = useEventCallback(handleSchedule);
  const pickerOpenChange = useEventCallback(handleToolbarPickerOpenChange);
  const pasteFiles = useEventCallback(uploadFiles);
  const attach = useCallback(() => fileInputRef.current?.click(), []);
  const editorChange = useEventCallback((md: string) => {
    handleEditorChange(md);
    emitTyping();
  });

  const toolbar = (
    <ComposerToolbar
      editorRef={editorRef}
      activeFormats={activeFormats}
      isMobile={isMobile}
      isEditingMode={isEditingMode}
      hideCodeButton={hideCodeButton}
      giphyEnabled={giphyEnabled}
      giphyAPIKey={giphyAPIKey}
      isUploading={isUploading}
      showSend={showToolbarSend}
      scheduledCount={scheduledCount}
      canSend={canSend}
      submitLabel={submitLabel}
      onOpenLinkDialog={linkDialog.openDialog}
      onPickerOpenChange={pickerOpenChange}
      onAttach={attach}
      onSend={sendNow}
      onSchedule={onSchedule ? scheduleNow : undefined}
      onCancel={onCancel}
    />
  );

  return (
    <div
      ref={rootRef}
      className={
        variant === 'inline'
          ? 'p-0'
          // Centred column, lined up with the messages above (MessageList).
          : `relative mx-auto w-full max-w-4xl bg-background p-3 mobile:pt-1.5 ${
              // env(safe-area-inset-bottom) on iOS does not reset to 0 when
              // the keyboard is up, leaving a wasted ~34px gap between the
              // composer and the keyboard. Drop the inset while focused
              // (keyboard up) and only reserve the home-indicator space
              // when the composer is idle.
              editorFocused || !bottomInset
                ? 'mobile:pb-1'
                : 'mobile:pb-[max(0.25rem,var(--bottom-safe-inset,env(safe-area-inset-bottom)))]'
            } ${
              // Wider tiers keep the p-3 gutter but clear the iPad home
              // indicator (the inset is 0 on desktop, so max() is a no-op).
              bottomInset ? 'not-mobile:pb-[max(0.75rem,env(safe-area-inset-bottom))]' : ''
            } ${compactMobileComposer && !editorFocused ? 'mobile:px-4' : 'mobile:px-2'}`
      }
      data-composer-focused={editorFocused ? 'true' : 'false'}
    >
      {uploadError && (
        <div className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {uploadError}
        </div>
      )}
      {commandError && (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
          data-testid="command-error"
        >
          {commandError}
        </div>
      )}
      {pendingCommand && (
        <div
          className="mb-2 flex items-center gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"
          role="status"
          data-testid="command-pending"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Running /{pendingCommand}…
        </div>
      )}
      {bodyOverLimit && (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
          data-testid="message-body-too-long"
        >
          Message is {bodyCodepoints}/{MAX_MESSAGE_BODY_CHARS} characters. Trim it down to send.
        </div>
      )}
      {attachmentsOverLimit && (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
          data-testid="message-attachments-too-many"
        >
          Up to {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message — remove a few to send.
        </div>
      )}
      {/* `relative` wrapper anchors the typing-indicator overlay to the
          composer BOX, not the padded root. Anchoring to the root made
          `bottom-full` sit at the root's top edge — a full `p-3` (12px)
          above the composer box, which read as a ~10px floating gap. This
          wrapper hugs the box so the overlay sits directly on top of it. */}
      <div className="relative">
        {variant === 'composer' && aboveInput && (
          // Overlay, not normal flow: floats in the free space just above the
          // composer (`bottom-full` = bottom edge sits on this wrapper's — and
          // therefore the box's — top edge) so showing / hiding the "<user> is
          // typing" line never pushes the input box or changes the composer's
          // height. pointer-events-none so it can't intercept clicks on the
          // message underneath.
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full"
            data-testid="composer-above-input-overlay"
          >
            {aboveInput}
          </div>
        )}
        <div className="rounded-2xl border border-border-strong/50 bg-typing-field shadow-sm transition-colors focus-within:border-border-strong mobile:overflow-hidden mobile:rounded-[1.75rem]" data-message-composer>
        {drafts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b p-2" aria-label="Draft attachments">
            {drafts.map((d) => (
              <AttachmentChip key={d.id} att={d} onRemove={() => removeDraft(d.id)} />
            ))}
          </div>
        )}

        <div
          className={`flex gap-2 px-3 py-2 mobile:transition-[padding] mobile:duration-200 mobile:ease-out ${
            compactMobileComposer
              // Compact mobile composer (idle): row sized to match
              // the 36px send button so the input text vertically
              // centres against the button. `pl-4 pr-1.5` pulls the
              // send chip close to the rounded edge — `px-3` left a
              // noticeable gap that read as misalignment. Vertical
              // padding stays at `py-0.5` (2px) so the total height
              // (36 + 4 = 40px) fits inside the iPhone-composer
              // ≤42px contract the browser test locks down.
              ? 'items-center mobile:py-0.5 mobile:pl-4 mobile:pr-1.5'
              : 'items-end mobile:pt-3'
          }`}
        >
          <MarkdownComposer
            ref={editorRef}
            initialBody={initialBody}
            onChange={editorChange}
            onSubmit={sendNow}
            onCancel={onCancel}
            submitOnEnter={submitOnEnter}
            onPasteFiles={pasteFiles}
            onArrowUpEmpty={requestEditLast}
            onLinkShortcut={linkDialog.openDialog}
            placeholder={isUploading ? 'Uploading…' : placeholder}
            ariaLabel="Message input"
            // Enables member / special / not-in-channel grouping in the
            // @-mention typeahead. Only a channel composer has a channel
            // roster; DMs (and the typing-less edit box) pass nothing.
            mentionChannelId={typingParentType === 'channel' ? typingParentID : undefined}
            slashCommands={slashCommands}
            className="flex-1"
            editorClassName={
              compactMobileComposer
                // Match the editor height to the row (36px) and use
                // `leading-9` (36px) so the single line of text /
                // placeholder vertically centers against the round
                // send button on the right.
                ? 'mobile:!min-h-9 mobile:!max-h-9 mobile:overflow-hidden mobile:leading-9'
                : ''
            }
            onFocusChange={isMobile && variant === 'composer' ? setEditorFocused : undefined}
          />
          {!isEditingMode && !showToolbarSend && (() => {
            /* istanbul ignore next -- this standalone send button only renders when showToolbarSend is false, which on mobile coincides with the compact idle composer, so compactMobileComposer is always true here; the non-compact size arm is unreachable. */
            const sendSize = compactMobileComposer ? 'mobile:h-9 mobile:w-9' : 'mobile:h-11 mobile:w-11';
            return (
            <div className="flex shrink-0 self-end items-center gap-1">
              <Button
                onClick={sendNow}
                disabled={!canSend}
                size="icon"
                className={`h-8 w-8 rounded-md bg-foreground text-background hover:bg-foreground/85 dark:bg-brand dark:text-brand-foreground dark:hover:bg-brand-hover mobile:rounded-full ${sendSize}`}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            );
          })()}
        </div>
          {variant === 'composer' && isMobile ? (
            // Phone: the toolbar is always mounted and grows open from the
            // bottom when the composer is focused, instead of popping in.
            <div
              className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                showToolbar ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
              inert={showToolbar ? undefined : true}
              data-testid="composer-toolbar-reveal"
            >
              <div className="min-h-0 overflow-hidden">{toolbarEverShown && toolbar}</div>
            </div>
          ) : (
            showToolbar && toolbar
          )}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileUpload}
        aria-label="File input"
      />
      <ComposerLinkDialog dialog={linkDialog} isMobile={isMobile} />
    </div>
  );
});
