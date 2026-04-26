import { useState, useRef, useCallback, useMemo } from 'react';
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
  X,
} from 'lucide-react';
import { useEffect } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { EmojiPicker } from '@/components/EmojiPicker';
import { AttachmentChip, type DraftAttachment } from '@/components/chat/AttachmentChip';
import { uploadAttachment, useDeleteDraftAttachment } from '@/hooks/useAttachments';
import { isImageContentType } from '@/lib/file-helpers';
import { renderMarkdown } from '@/lib/markdown';
import { useEmojiMap } from '@/hooks/useEmoji';

export interface MessageInputValue {
  body: string;
  attachmentIDs: string[];
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
}

// Detects whether the body contains anything that would render differently
// from plain text. We avoid the "preview shows the same thing as the input"
// flicker by hiding the preview until there's something worth rendering.
function hasFormatting(body: string): boolean {
  if (!body.trim()) return false;
  return (
    /\*\*[^*]+\*\*/.test(body) ||
    /(^|[^*])\*[^*\n]+\*/.test(body) ||
    /~~[^~]+~~/.test(body) ||
    /`[^`\n]+`/.test(body) ||
    /\[[^\]]+\]\([^)\s]+\)/.test(body) ||
    /(^|\n)#{1,6}\s+/.test(body) ||
    /(^|\n)>\s+/.test(body) ||
    /(^|\n)[-*]\s+/.test(body) ||
    /(^|\n)\d+[.)]\s+/.test(body) ||
    /(^|\n)```/.test(body) ||
    /:[a-z0-9_+-]+:/i.test(body) ||
    /https?:\/\//.test(body)
  );
}

export function MessageInput({
  onSend,
  onCancel,
  disabled = false,
  placeholder = 'Type a message...',
  initialBody = '',
  initialDrafts = [],
  submitLabel,
  variant = 'composer',
  focusKey,
}: MessageInputProps) {
  const [body, setBody] = useState(initialBody);
  const [drafts, setDrafts] = useState<DraftAttachment[]>(initialDrafts);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteDraft = useDeleteDraftAttachment();
  const { data: emojiMap } = useEmojiMap();
  const showPreview = useMemo(() => hasFormatting(body), [body]);

  const canSend = (body.trim() !== '' || drafts.length > 0) && !disabled && !isUploading;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend({ body: body.trim(), attachmentIDs: drafts.map((d) => d.id) });
    if (variant === 'inline') return; // parent unmounts the inline edit
    drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    setBody('');
    setDrafts([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    queueMicrotask(() => {
      textareaRef.current?.focus();
    });
  }, [canSend, body, drafts, onSend, variant]);

  // Cleanup any object URLs still attached to drafts when the composer
  // unmounts (e.g. user navigates away mid-compose).
  useEffect(() => {
    return () => {
      drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-focus the textarea whenever focusKey changes — used by callers to
  // refocus on channel/DM/group switch without remounting this component.
  useEffect(() => {
    if (focusKey === undefined) return;
    queueMicrotask(() => {
      textareaRef.current?.focus();
    });
  }, [focusKey]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); applyWrap('**', '**'); return; }
      if (k === 'i') { e.preventDefault(); applyWrap('*', '*'); return; }
      if (k === 'e') { e.preventDefault(); applyWrap('`', '`'); return; }
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setBody(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  function applyWrap(prefix: string, suffix: string) {
    const el = textareaRef.current;
    if (!el) {
      setBody((b) => b + prefix + suffix);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const before = body.slice(0, start);
    const sel = body.slice(start, end) || 'text';
    const after = body.slice(end);
    setBody(before + prefix + sel + suffix + after);
    queueMicrotask(() => {
      const pos = before.length + prefix.length;
      el.focus();
      el.setSelectionRange(pos, pos + sel.length);
    });
  }

  function applyLine(prefix: string) {
    const el = textareaRef.current;
    if (!el) {
      setBody((b) => (b ? b + '\n' : '') + prefix);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const lineStart = body.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    setBody(body.slice(0, lineStart) + prefix + body.slice(lineStart));
    queueMicrotask(() => {
      const pos = lineStart + prefix.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function applyLink() {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const sel = body.slice(start, end) || 'text';
    const before = body.slice(0, start);
    const after = body.slice(end);
    setBody(before + `[${sel}](https://)` + after);
    queueMicrotask(() => {
      el?.focus();
      const urlPos = before.length + sel.length + 3;
      el?.setSelectionRange(urlPos, urlPos + 8);
    });
  }

  function insertEmojiShortcode(emoji: string) {
    const el = textareaRef.current;
    const insert = emoji + ' ';
    if (!el) { setBody((b) => b + insert); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + insert + body.slice(end));
    queueMicrotask(() => {
      const pos = start + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setUploadError('');
    setIsUploading(true);
    try {
      const newDrafts = await Promise.all(
        files.map(async (file): Promise<DraftAttachment> => {
          const init = await uploadAttachment(file);
          return {
            id: init.id,
            filename: init.filename,
            contentType: init.contentType,
            size: init.size,
            localURL: isImageContentType(file.type) ? URL.createObjectURL(file) : undefined,
          };
        }),
      );
      setDrafts((d) => [...d, ...newDrafts]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }

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
      <div className="rounded-lg border bg-muted/40 dark:bg-input/30 focus-within:ring-1 focus-within:ring-ring">
        <div className="flex items-center gap-0.5 border-b px-2 py-1" role="toolbar" aria-label="Formatting">
          <ToolbarBtn label="Bold (Ctrl+B)" onClick={() => applyWrap('**', '**')}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Italic (Ctrl+I)" onClick={() => applyWrap('*', '*')}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Strikethrough" onClick={() => applyWrap('~~', '~~')}><Strikethrough className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Code (Ctrl+E)" onClick={() => applyWrap('`', '`')}><Code className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Link" onClick={applyLink}><LinkIcon className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Quote" onClick={() => applyLine('> ')}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="List" onClick={() => applyLine('- ')}><List className="h-3.5 w-3.5" /></ToolbarBtn>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <EmojiPicker
            onSelect={insertEmojiShortcode}
            mode="shortcode"
            trigger={
              <ToolbarBtn label="Emoji"><Smile className="h-3.5 w-3.5" /></ToolbarBtn>
            }
          />
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
          <Textarea
            ref={textareaRef}
            value={body}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={isUploading ? 'Uploading…' : placeholder}
            className="min-h-[60px] max-h-[200px] resize-none rounded-none border-0 bg-transparent px-0 py-1 shadow-none dark:bg-transparent focus-visible:ring-0 focus-visible:border-transparent"
            rows={3}
            aria-label="Message input"
            autoFocus
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

        {showPreview && (
          <div
            className="border-t bg-muted/30 px-3 py-2"
            data-testid="message-input-preview"
            aria-label="Live message preview"
          >
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Preview
            </p>
            <div className="text-sm">{renderMarkdown(body, { emojiMap })}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted"
    >
      {children}
    </button>
  );
}
