import { useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import {
  Send,
  Paperclip,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link as LinkIcon,
  List,
  Quote,
  Smile,
  ImagePlay,
  X,
} from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmojiPicker } from '@/components/EmojiPicker';
import { GiphyPicker, type PickedGIF } from '@/components/GiphyPicker';
import { useWorkspaceSettings } from '@/hooks/useSettings';
import { AttachmentChip, type DraftAttachment } from '@/components/chat/AttachmentChip';
import { uploadAttachment, useDeleteDraftAttachment } from '@/hooks/useAttachments';
import { isImageContentType } from '@/lib/file-helpers';
import { WysiwygEditor, type WysiwygEditorHandle, type ActiveFormat } from '@/components/chat/WysiwygEditor';
import { sendWS } from '@/lib/ws-sender';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY_CHARS,
  countCodepoints,
} from '@/lib/limits';
import { normalizeEmojiInBody } from '@/lib/emoji-shortcodes';
import { isHttpUrl } from '@/lib/utils';
import { dispatchEditMessage, onFocusComposer } from '@/lib/window-events';

const TYPING_PING_INTERVAL_MS = 3000;

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
  onCancel?: () => void;
  disabled?: boolean;
  placeholder?: string;
  initialBody?: string;
  initialDrafts?: DraftAttachment[];
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
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput({
  onSend,
  onCancel,
  disabled = false,
  placeholder = 'Type a message...',
  initialBody = '',
  initialDrafts = [],
  submitLabel,
  variant = 'composer',
  focusKey,
  typingParentID,
  typingParentType,
  typingThreadRootID,
  lastOwnMessageId,
}, ref) {
  const [body, setBody] = useState(initialBody);
  const [drafts, setDrafts] = useState<DraftAttachment[]>(initialDrafts);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const editorRef = useRef<WysiwygEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingPingRef = useRef(0);
  const deleteDraft = useDeleteDraftAttachment();
  // Toolbar pressed-state tracking. Driven by Lexical's
  // registerUpdateListener so a toolbar click flips the pressed state
  // immediately — selectionchange only fires when the caret moves and
  // would lag behind format toggles by one keystroke.
  const [active, setActive] = useState<Set<ActiveFormat>>(new Set());
  useEffect(() => {
    return editorRef.current?.subscribeActiveFormats?.(setActive);
  }, []);
  const { data: settings } = useWorkspaceSettings();
  const giphyEnabled = settings?.giphyEnabled ?? false;

  // Link dialog state. Opening the dialog calls editor.beginLinkEdit
  // which captures the current selection (Lexical loses selection when
  // focus moves to the modal), so the eventual commit can apply the
  // link to the right text.
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const openLinkDialog = useCallback(() => {
    const { selectedText } = editorRef.current?.beginLinkEdit?.() ?? { selectedText: '' };
    setLinkText(selectedText);
    setLinkUrl('');
    setLinkDialogOpen(true);
  }, []);
  const submitLinkDialog = useCallback(() => {
    const url = linkUrl.trim();
    // isHttpUrl is the same gate PasteLinkPlugin uses — blocks
    // javascript:/data:/vbscript: schemes regardless of what the
    // browser's <input type="url"> accepts.
    if (!isHttpUrl(url)) return;
    const text = linkText.trim() || url;
    editorRef.current?.commitLinkEdit?.(url, text);
    setLinkDialogOpen(false);
    queueMicrotask(() => editorRef.current?.focus());
  }, [linkUrl, linkText]);

  // Throttled typing emit. Other clients show "<user> is typing" for 5s
  // after the most recent ping; we re-ping every 3s while the user is
  // still composing. We deliberately don't ping on every keystroke —
  // that would flood the WebSocket on long messages.
  const emitTyping = useCallback(() => {
    if (!typingParentID || !typingParentType) return;
    const now = Date.now();
    if (now - lastTypingPingRef.current < TYPING_PING_INTERVAL_MS) return;
    lastTypingPingRef.current = now;
    const frame: Record<string, string> = {
      type: 'typing',
      parentID: typingParentID,
      parentType: typingParentType,
    };
    if (typingThreadRootID) frame.parentMessageID = typingThreadRootID;
    sendWS(frame);
  }, [typingParentID, typingParentType, typingThreadRootID]);

  // ArrowUp in an empty composer asks the surrounding list to put the
  // user's most recent loaded message into edit mode (Slack/iMessage
  // parity). Disabled when there's no candidate or when the composer
  // is itself an inline edit (initialBody non-empty).
  const requestEditLast = useCallback((): boolean => {
    if (!lastOwnMessageId || initialBody) return false;
    dispatchEditMessage({ messageId: lastOwnMessageId });
    return true;
  }, [lastOwnMessageId, initialBody]);

  // Codepoint cap mirrors the backend rule: the user pastes "🚀🚀🚀…",
  // each emoji is one user-visible char, and we count it as one — not
  // as four bytes or two UTF-16 units.
  const bodyCodepoints = countCodepoints(body);
  const bodyOverLimit = bodyCodepoints > MAX_MESSAGE_BODY_CHARS;
  const attachmentsOverLimit = drafts.length > MAX_ATTACHMENTS_PER_MESSAGE;

  const canSend =
    (body.trim() !== '' || drafts.length > 0) &&
    !disabled &&
    !isUploading &&
    !bodyOverLimit &&
    !attachmentsOverLimit;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const normalized = normalizeEmojiInBody(body.trim());
    onSend({ body: normalized, attachmentIDs: drafts.map((d) => d.id) });
    if (variant === 'inline') return; // parent unmounts the inline edit
    drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    setBody('');
    setDrafts([]);
    editorRef.current?.setMarkdown('');
    queueMicrotask(() => editorRef.current?.focus());
  }, [canSend, body, drafts, onSend, variant]);

  useEffect(() => {
    return () => {
      drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusKey === undefined) return;
    queueMicrotask(() => editorRef.current?.focus());
  }, [focusKey]);

  // Refocus when an inline edit elsewhere finishes (cancel or submit).
  // Only composers that emit typing (i.e., the main / thread composer,
  // not the inline-edit MessageInput inside MessageItem) participate.
  // The thread-vs-main scope is disambiguated by typingThreadRootID:
  // a non-thread edit's event matches composers without a thread root,
  // and vice versa.
  useEffect(() => {
    if (!typingParentID) return;
    const inThreadComposer = !!typingThreadRootID;
    return onFocusComposer((detail) => {
      if (detail.parentID !== typingParentID) return;
      if (detail.inThread !== inThreadComposer) return;
      queueMicrotask(() => editorRef.current?.focus());
    });
  }, [typingParentID, typingThreadRootID]);

  function insertEmojiShortcode(emoji: string) {
    editorRef.current?.insertText(emoji + ' ');
  }

  function insertGiphyGIF(gif: PickedGIF) {
    // ![title](url =WxH) reserves the layout box at first paint so
    // the chat list doesn't shift when the GIF decodes — the same
    // explicit-dimensions rule attachments already follow.
    const safeTitle = (gif.title || 'GIF').replace(/[[\]]/g, '');
    const sizeSuffix = gif.width > 0 && gif.height > 0 ? ` =${gif.width}x${gif.height}` : '';
    editorRef.current?.insertText(`![${safeTitle}](${gif.url}${sizeSuffix}) `);
  }

  async function uploadFiles(allFiles: File[]) {
    if (allFiles.length === 0) return;
    // Trim to the per-message cap before uploading. Surface a friendly
    // warning if the user tried to attach more — better UX than letting
    // the upload finish and then 400-ing on send.
    const remaining = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - drafts.length);
    const files = allFiles.slice(0, remaining);
    if (allFiles.length > remaining) {
      setUploadError(
        `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message. Skipped ${
          allFiles.length - remaining
        }.`,
      );
    } else {
      setUploadError('');
    }
    if (files.length === 0) return;
    setIsUploading(true);

    // Render a chip for every selected file *before* any network I/O so
    // the user sees N progress bars immediately instead of one-at-a-time
    // as each file's SHA / presign call resolves. We track the chip by a
    // local placeholder id, then swap to the server id when init returns.
    const tempIDs = files.map((_, i) => `pending-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`);
    setDrafts((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: tempIDs[i],
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        localURL: isImageContentType(file.type) ? URL.createObjectURL(file) : undefined,
        progress: 0,
      })),
    ]);

    // Concurrency-capped pool. Promise.all would dispatch all uploads at
    // once; cap at 4 so we stay polite to the upload endpoint and don't
    // saturate upstream bandwidth on bulk drops. Per-file failures are
    // captured (allSettled-style) so one bad file doesn't abort siblings.
    const POOL = 4;
    const errors: string[] = [];
    let cursor = 0;
    const runOne = async (idx: number) => {
      const file = files[idx];
      const tempID = tempIDs[idx];
      // currentID flips from the temp id to the server-issued id once
      // init resolves. Progress callbacks use this so they can find the
      // chip whether or not the swap has happened yet.
      let currentID = tempID;
      try {
        await uploadAttachment(file, {
          onInit: (init) => {
            // Swap the temp id for the real one. If the server already
            // had the bytes (alreadyExists), progress jumps to 1.
            currentID = init.id;
            setDrafts((prev) =>
              prev.map((d) =>
                d.id === tempID
                  ? {
                      ...d,
                      id: init.id,
                      filename: init.filename,
                      contentType: init.contentType,
                      size: init.size,
                      progress: init.alreadyExists ? 1 : d.progress ?? 0,
                    }
                  : d,
              ),
            );
          },
          onProgress: (fraction) => {
            // Match by the live id — temp before init, server-issued after.
            setDrafts((prev) =>
              prev.map((d) => (d.id === currentID ? { ...d, progress: fraction } : d)),
            );
          },
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Upload failed');
        // Drop the failed chip — keep siblings intact. Match by the
        // current id, which may be the temp id (init never resolved)
        // or the server id (init succeeded but the PUT failed).
        setDrafts((prev) => {
          const target = prev.find((d) => d.id === currentID);
          if (target?.localURL) URL.revokeObjectURL(target.localURL);
          return prev.filter((d) => d.id !== currentID);
        });
      }
    };
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= files.length) return;
        await runOne(i);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker));
      if (errors.length > 0) {
        setUploadError(errors.length === 1 ? errors[0] : `${errors.length} uploads failed: ${errors[0]}`);
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await uploadFiles(files);
  }

  useImperativeHandle(ref, () => ({ uploadFiles }));

  async function removeDraft(id: string) {
    const target = drafts.find((d) => d.id === id);
    if (target?.localURL) URL.revokeObjectURL(target.localURL);
    setDrafts((d) => d.filter((x) => x.id !== id));
    try {
      await deleteDraft.mutateAsync(id);
    } catch {
      // Best-effort delete — if the server says it's still referenced
      // (SHA dedup against another message), we silently ignore.
    }
  }

  return (
    <div className={variant === 'inline' ? 'p-0' : 'border-t p-3'}>
      {uploadError && (
        <div className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {uploadError}
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
      <div className="rounded-lg border bg-muted/40 dark:bg-input/30 focus-within:ring-1 focus-within:ring-ring">
        <div className="flex items-center gap-0.5 border-b px-2 py-1" role="toolbar" aria-label="Formatting">
          <ToolbarBtn label="Bold (Ctrl+B)" active={active.has('bold')} onClick={() => editorRef.current?.applyMark('bold')}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Italic (Ctrl+I)" active={active.has('italic')} onClick={() => editorRef.current?.applyMark('italic')}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Strikethrough" active={active.has('strike')} onClick={() => editorRef.current?.applyMark('strike')}><Strikethrough className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Code (Ctrl+E)" active={active.has('code')} onClick={() => editorRef.current?.applyMark('code')}><Code className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Link" onClick={openLinkDialog}><LinkIcon className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Quote" active={active.has('quote')} onClick={() => editorRef.current?.applyBlock('quote')}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="List" active={active.has('ul')} onClick={() => editorRef.current?.applyBlock('ul')}><List className="h-3.5 w-3.5" /></ToolbarBtn>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <EmojiPicker
            onSelect={insertEmojiShortcode}
            mode="shortcode"
            trigger={
              <ToolbarBtn label="Emoji"><Smile className="h-3.5 w-3.5" /></ToolbarBtn>
            }
          />
          {giphyEnabled && (
            <GiphyPicker
              onSelect={insertGiphyGIF}
              trigger={
                <ToolbarBtn label="GIF"><ImagePlay className="h-3.5 w-3.5" /></ToolbarBtn>
              }
            />
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="ml-auto h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
            aria-label="Attach file"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileUpload}
            aria-label="File input"
          />
        </div>

        {drafts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b p-2" aria-label="Draft attachments">
            {drafts.map((d) => (
              <AttachmentChip key={d.id} att={d} onRemove={() => removeDraft(d.id)} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 px-3 py-2">
          <WysiwygEditor
            ref={editorRef}
            initialBody={initialBody}
            onChange={(md) => {
              setBody(md);
              emitTyping();
            }}
            onSubmit={handleSend}
            onCancel={onCancel}
            onPasteFiles={uploadFiles}
            onArrowUpEmpty={requestEditLast}
            placeholder={isUploading ? 'Uploading…' : placeholder}
            ariaLabel="Message input"
            className="flex-1"
          />
          <div className="flex shrink-0 items-center gap-1">
            {onCancel && (
              <Button
                onClick={onCancel}
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-md"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            <Button
              onClick={handleSend}
              disabled={!canSend}
              size={submitLabel ? 'sm' : 'icon'}
              className={submitLabel ? 'h-8 rounded-md' : 'h-8 w-8 rounded-md'}
              aria-label={submitLabel ?? 'Send message'}
            >
              {submitLabel ? submitLabel : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent aria-label="Insert link">
          <DialogHeader>
            <DialogTitle>Insert link</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitLinkDialog();
            }}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-text">Text</Label>
              <Input
                id="link-text"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                placeholder="Link text"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-url">URL</Label>
              <Input
                id="link-url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://example.com"
                autoFocus
                required
                type="url"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setLinkDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isHttpUrl(linkUrl.trim())}>
                Insert
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function ToolbarBtn({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active ? 'true' : undefined}
      className={`h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  );
}
