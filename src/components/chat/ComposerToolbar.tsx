import type { ReactNode, RefObject } from 'react';
import {
  Send,
  Paperclip,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Quote,
  List,
  ListOrdered,
  Link as LinkIcon,
  Smile,
  X,
  Save,
  Clock,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ScheduleSendMenu } from '@/components/chat/ScheduleSendMenu';
import { Button } from '@/components/ui/button';
import { EmojiPicker } from '@/components/EmojiPicker';
import { GiphyPicker, type PickedGIF } from '@/components/GiphyPicker';
import type { ActiveFormat, WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';

interface ComposerToolbarProps {
  editorRef: RefObject<WysiwygEditorHandle | null>;
  activeFormats: Set<ActiveFormat>;
  isMobile: boolean;
  isEditingMode: boolean;
  hideCodeButton?: boolean;
  giphyEnabled: boolean;
  giphyAPIKey: string;
  isUploading: boolean;
  // Send (and schedule) live at the toolbar's end.
  showSend: boolean;
  scheduledCount: number;
  canSend: boolean;
  submitLabel?: string;
  onOpenLinkDialog: () => void;
  onPickerOpenChange: (open: boolean) => void;
  onAttach: () => void;
  onSend: () => void;
  // Present when the message can be sent later instead.
  onSchedule?: (sendAt: Date) => Promise<void>;
  onCancel?: () => void;
}

// ComposerToolbar is the row under the message field: formatting buttons,
// emoji and GIF pickers, attach, and — depending on the composer — Send with
// its schedule options, or an edit box's Cancel / Save.
export function ComposerToolbar({
  editorRef,
  activeFormats: active,
  isMobile,
  isEditingMode,
  hideCodeButton,
  giphyEnabled,
  giphyAPIKey,
  isUploading,
  showSend,
  scheduledCount,
  canSend,
  submitLabel,
  onOpenLinkDialog,
  onPickerOpenChange,
  onAttach,
  onSend,
  onSchedule,
  onCancel,
}: ComposerToolbarProps) {
  function insertEmojiShortcode(emoji: string) {
    editorRef.current?.insertText(emoji + ' ');
    // Refocus synchronously, inside the pick tap's gesture, so iOS reopens
    // the keyboard. A deferred focus (rAF/microtask) loses the user-gesture
    // context and the keyboard stays closed.
    editorRef.current?.focus();
  }

  function insertGiphyGIF(gif: PickedGIF) {
    // Store only GIPHY's stable content ID plus dimensions for layout.
    // Media URLs are resolved directly from GIPHY at render time so
    // saved messages don't cache returned media URLs.
    /* istanbul ignore next -- insertGiphyGIF is only invoked by the GiphyPicker's onSelect; exercising the width/height ternary arms requires the full GIPHY-fetch picker integration (covered in GiphyPicker.browser.test), not reachable from MessageInput's own tests. */
    const dims = gif.width && gif.height ? ` =${gif.width}x${gif.height}` : '';
    editorRef.current?.insertText(`![GIPHY](giphy:${gif.id}${dims}) `);
    // Synchronous refocus (inside the pick gesture) reopens the iOS keyboard.
    editorRef.current?.focus();
  }

  // No divider between the message field and the formatting buttons — the
  // spec composer has the toolbar sit flush under the input, not separated
  // by an hr/border.
  return (
    <div
      className="flex items-center gap-0.5 overflow-x-auto px-2 py-1 [scrollbar-width:none]"
      role="toolbar"
      aria-label="Formatting"
      data-toolbar-placement="bottom"
      onMouseDown={(event) => {
        /* istanbul ignore next -- the handler is bound to the toolbar element, so a mousedown that reaches it always has a target contained by currentTarget; the false arm is defensive. */
        if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
      }}
      onPointerDown={(event) => {
        /* istanbul ignore next -- as above, a pointerdown reaching the toolbar handler always has a contained target; the false arm is defensive. */
        if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
      }}
    >
      <ToolbarBtn label="Bold (Ctrl+B)" active={active.has('bold')} onClick={() => editorRef.current?.applyMark('bold')}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
      <ToolbarBtn label="Italic (Ctrl+I)" active={active.has('italic')} onClick={() => editorRef.current?.applyMark('italic')}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
      <ToolbarBtn label="Strikethrough" active={active.has('strike')} onClick={() => editorRef.current?.applyMark('strike')}><Strikethrough className="h-3.5 w-3.5" /></ToolbarBtn>
      {!isEditingMode && !hideCodeButton && (
        <ToolbarBtn label="Code (Ctrl+E)" active={active.has('code')} onClick={() => editorRef.current?.applyMark('code')}><Code className="h-3.5 w-3.5" /></ToolbarBtn>
      )}
      {!isMobile && (
        <>
          <ToolbarBtn label="Quote" active={active.has('quote')} onClick={() => editorRef.current?.applyBlock('quote')}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="List" active={active.has('ul')} onClick={() => editorRef.current?.applyBlock('ul')}><List className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Numbered list" active={active.has('ol')} onClick={() => editorRef.current?.applyBlock('ol')}><ListOrdered className="h-3.5 w-3.5" /></ToolbarBtn>
        </>
      )}
      {/* DELIBERATELY desktop-only (like Quote/lists above): the mobile
          toolbar has very little width and Link was judged the least
          important formatting control there (Mobile fixes (7), #95). Do not
          re-add it on mobile — [text](url) remains typeable. */}
      {!isMobile && (
        <ToolbarBtn label="Link" onClick={onOpenLinkDialog}><LinkIcon className="h-3.5 w-3.5" /></ToolbarBtn>
      )}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <EmojiPicker
        onSelect={insertEmojiShortcode}
        mode="shortcode"
        onOpenChange={onPickerOpenChange}
        trigger={
          <ToolbarBtn label="Emoji"><Smile className="h-3.5 w-3.5" /></ToolbarBtn>
        }
      />
      {giphyEnabled && (
        <GiphyPicker
          apiKey={giphyAPIKey}
          onSelect={insertGiphyGIF}
          onOpenChange={onPickerOpenChange}
          trigger={
            // The word, not a picture: no icon reads as "GIF" at this size.
            // Sized as an icon, not as text: as tall as the icons beside it
            // (a 12px line in a 1px border), below the 12px text floor on
            // purpose, and no heavier than their strokes.
            <ToolbarBtn label="GIF">
              <span
                // eslint-disable-next-line no-restricted-syntax -- the GIF label is sized as an icon, the one approved exception to the type floor
                className="rounded-sm border border-current px-0.5 text-[10px] font-medium leading-3"
                aria-hidden="true"
                data-testid="composer-gif-label"
              >
                GIF
              </span>
            </ToolbarBtn>
          }
        />
      )}
      <button
        type="button"
        onClick={onAttach}
        disabled={isUploading}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 mobile:h-9 mobile:w-9"
        aria-label="Attach file"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </button>
      {showSend && (
        <>
          <span className="ml-auto" aria-hidden />
          {scheduledCount > 0 && (
            // Quiet way back to what's queued here; never moves the layout.
            <Link
              to="/drafts?tab=scheduled"
              className="mr-2 flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="composer-scheduled-link"
            >
              <Clock className="h-3.5 w-3.5" aria-hidden />
              {scheduledCount} scheduled
            </Link>
          )}
          {onSchedule && isMobile ? (
            // Phone: one round Send — tap sends, press and hold for the
            // schedule options (no ⌄ beside it).
            // (No picker-open hook: that drops the keyboard for full-screen
            // pickers, and this one keeps it up.)
            <ScheduleSendMenu
              disabled={!canSend}
              onSchedule={onSchedule}
              hold={{ onSend, label: 'Send message', children: <Send className="h-4 w-4" /> }}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:pointer-events-none dark:bg-brand dark:text-brand-foreground ${
                canSend ? '' : 'opacity-40'
              }`}
            />
          ) : onSchedule ? (
            // One button, split: Send, and ⌄ to send later instead — a single
            // shape and colour with a thin inset divider.
            <div
              // Nothing to send: the same colours, faded — never a lighter tint.
              className={`flex h-7 shrink-0 items-stretch overflow-hidden rounded-md bg-foreground text-background transition-opacity dark:bg-brand dark:text-brand-foreground mobile:h-9 mobile:rounded-full ${
                canSend ? '' : 'opacity-40'
              }`}
              data-testid="split-send"
            >
              {/* A plain button: the wrapper alone colours the control (the
                  Button component would add its own fill to this half). */}
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className="flex h-full w-7 items-center justify-center hover:bg-background/15 disabled:pointer-events-none mobile:w-9"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
              <span aria-hidden className="my-1.5 w-px bg-current opacity-30" />
              <ScheduleSendMenu
                disabled={!canSend}
                onSchedule={onSchedule}
                onOpenChange={onPickerOpenChange}
                className="flex h-full w-5 items-center justify-center hover:bg-background/15 disabled:pointer-events-none mobile:w-7"
              />
            </div>
          ) : (
            <Button
              onClick={onSend}
              disabled={!canSend}
              size="icon"
              className="h-7 w-7 rounded-md bg-foreground text-background hover:bg-foreground/85 dark:bg-brand dark:text-brand-foreground dark:hover:bg-brand-hover dark:disabled:bg-brand-disabled dark:disabled:text-brand-foreground mobile:h-9 mobile:w-9 mobile:rounded-full"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </>
      )}
      {isEditingMode && (
        <>
          <span className="ml-auto" aria-hidden />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          {onCancel && (
            <Button
              onClick={onCancel}
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md mobile:h-9 mobile:w-9"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          <Button
            onClick={onSend}
            disabled={!canSend}
            size="icon"
            className="h-7 w-7 rounded-md bg-foreground text-background hover:bg-foreground/85 dark:bg-brand dark:text-brand-foreground dark:hover:bg-brand-hover mobile:h-9 mobile:w-9 mobile:rounded-full"
            aria-label={submitLabel ?? 'Send message'}
          >
            <Save className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  );
}

function ToolbarBtn({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active ? 'true' : undefined}
      className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted mobile:h-9 mobile:w-9 mobile:shrink-0 ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  );
}
