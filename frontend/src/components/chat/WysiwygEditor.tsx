import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { htmlToMarkdown, markdownToEditableHtml } from '@/lib/wysiwyg';
import { MentionAutocomplete, type MentionSuggestion } from './MentionAutocomplete';
import { EmojiAutocomplete, type EmojiSuggestion } from './EmojiAutocomplete';

// detectAutocompleteTrigger scans backward from the caret in the focused
// text node for the nearest occurrence of `trigger`, then asks the
// caller's predicate whether the typed query is still valid (e.g. no
// whitespace for mentions, shortcode-character only for emoji). Returns
// the query and the Range covering trigger+query so a pick can replace
// it atomically. Reuses host across @mention and :emoji autocompletes.
function detectAutocompleteTrigger(
  host: HTMLElement | null,
  trigger: string,
  isValidQuery: (query: string) => boolean,
): { query: string; range: Range } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const focus = sel.getRangeAt(0);
  if (!host?.contains(focus.startContainer)) return null;
  if (focus.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const text = (focus.startContainer.textContent ?? '').slice(0, focus.startOffset);
  const triggerAt = text.lastIndexOf(trigger);
  if (triggerAt < 0) return null;
  // Reject mid-word triggers ("a@b" email parts, "http://", "8:30 am" …).
  if (triggerAt > 0 && /\S/.test(text.charAt(triggerAt - 1))) return null;

  const query = text.slice(triggerAt + 1);
  if (!isValidQuery(query)) return null;

  const range = document.createRange();
  range.setStart(focus.startContainer, triggerAt);
  range.setEnd(focus.startContainer, focus.startOffset);
  return { query, range };
}

// Whitespace closes the @ popover — single names only.
const isValidMentionQuery = (query: string) => !/\s/.test(query);

// Emoji shortcodes are alphanumeric/_/+/-; a second `:` would close one.
const EMOJI_SHORTCODE_RE = /^[a-z0-9_+-]+$/i;
const isValidEmojiQuery = (query: string) =>
  !query.includes(':') && EMOJI_SHORTCODE_RE.test(query);

export interface WysiwygEditorHandle {
  /** Apply a formatting command to the current selection. */
  applyMark: (mark: 'bold' | 'italic' | 'strike' | 'code') => void;
  /** Apply a block command at the cursor / over the current selection. */
  applyBlock: (block: 'quote' | 'ul' | 'ol') => void;
  /** Wrap the current selection in a hyperlink, prompting for the URL. */
  applyLink: () => void;
  /** Insert raw text at the cursor. Used by the emoji picker. */
  insertText: (text: string) => void;
  /** Read the current content as markdown. */
  getMarkdown: () => string;
  /** Replace the editor content with the given markdown. */
  setMarkdown: (md: string) => void;
  /** Focus the editor. */
  focus: () => void;
}

interface Props {
  initialBody?: string;
  onChange?: (markdown: string) => void;
  // Submit on Enter (without Shift). Receives the current markdown.
  onSubmit?: (markdown: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  disabled?: boolean;
  // ariaLabel for the editable region — keep stable so tests can latch on.
  ariaLabel?: string;
  className?: string;
  // Receives File items from a paste event (screenshots, Finder copies).
  // When present, file pastes suppress the default text-paste path.
  onPasteFiles?: (files: File[]) => void;
}

// We use document.execCommand for inline marks: deprecated in the spec
// but universally implemented and the simplest way to get correct
// selection-aware toggling without a full editor framework like Lexical.
export const WysiwygEditor = forwardRef<WysiwygEditorHandle, Props>(function WysiwygEditor(
  { initialBody = '', onChange, onSubmit, onCancel, placeholder, disabled, ariaLabel = 'Message input', className = '', onPasteFiles },
  ref,
) {
  const elRef = useRef<HTMLDivElement>(null);
  const lastEmittedMarkdownRef = useRef<string>('');
  // Mirror of the in-editor caret/selection captured while the editor
  // has focus. The toolbar buttons (emoji picker, file attach,
  // formatting) take focus when clicked, which clears the live
  // window.getSelection() inside the editor — execCommand and
  // Range-based mutations would silently no-op without this. We
  // restore from the ref before any imperative method runs.
  const lastRangeRef = useRef<Range | null>(null);

  // Mention autocomplete state. The trigger range is captured at the
  // moment the user typed "@" so we can replace the typed query atomically
  // when they pick a suggestion.
  const [mentionState, setMentionState] = useState<{
    query: string;
    anchorRect: DOMRect | null;
    range: Range;
  } | null>(null);
  const [emojiState, setEmojiState] = useState<{
    query: string;
    anchorRect: DOMRect | null;
    range: Range;
  } | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    elRef.current.innerHTML = markdownToEditableHtml(initialBody);
    lastEmittedMarkdownRef.current = initialBody;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capture the live caret while it lives inside the editor. We
  // listen on document because selection events don't bubble through
  // a normal DOM listener — `selectionchange` fires on document only.
  useEffect(() => {
    function track() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!elRef.current?.contains(range.startContainer)) return;
      lastRangeRef.current = range.cloneRange();
    }
    document.addEventListener('selectionchange', track);
    return () => document.removeEventListener('selectionchange', track);
  }, []);

  // restoreEditorSelection focuses the editor and re-applies the last
  // captured caret. Falls back to "caret at the end of the editor"
  // when the user has never put their cursor in the editor — that's
  // what the user expects when they click the emoji button on a
  // freshly-mounted composer.
  function restoreEditorSelection() {
    const el = elRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = lastRangeRef.current;
    if (range && el.contains(range.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    // No prior caret in the editor — drop it at the end.
    const fallback = document.createRange();
    fallback.selectNodeContents(el);
    fallback.collapse(false);
    sel.removeAllRanges();
    sel.addRange(fallback);
  }

  function emitChange() {
    if (!elRef.current) return;
    const md = htmlToMarkdown(elRef.current);
    if (md === lastEmittedMarkdownRef.current) return;
    lastEmittedMarkdownRef.current = md;
    onChange?.(md);
  }

  function refreshMention() {
    const trig = detectAutocompleteTrigger(elRef.current, '@', isValidMentionQuery);
    if (!trig) {
      setMentionState((prev) => (prev === null ? prev : null));
      return;
    }
    // jsdom doesn't always implement Range.getBoundingClientRect — guard
    // so the popover still opens (just unanchored) in test environments.
    let rect: DOMRect | null;
    try {
      rect = trig.range.getBoundingClientRect();
    } catch {
      rect = null;
    }
    setMentionState({ query: trig.query, anchorRect: rect, range: trig.range });
  }

  function refreshEmoji() {
    const trig = detectAutocompleteTrigger(elRef.current, ':', isValidEmojiQuery);
    if (!trig) {
      setEmojiState((prev) => (prev === null ? prev : null));
      return;
    }
    let rect: DOMRect | null;
    try {
      rect = trig.range.getBoundingClientRect();
    } catch {
      rect = null;
    }
    setEmojiState({ query: trig.query, anchorRect: rect, range: trig.range });
  }

  function pickEmoji(s: EmojiSuggestion) {
    if (!emojiState || !elRef.current) return;
    const range = emojiState.range;
    range.deleteContents();
    const tail = document.createTextNode(`:${s.name}: `);
    range.insertNode(tail);
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(tail);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    setEmojiState(null);
    emitChange();
  }

  function pickMention(s: MentionSuggestion) {
    if (!mentionState || !elRef.current) return;
    const range = mentionState.range;
    range.deleteContents();
    if (s.kind === 'user') {
      const span = document.createElement('span');
      span.className = 'mention';
      span.setAttribute('data-user-id', s.id);
      span.setAttribute('data-mention-name', s.displayName);
      span.setAttribute('contenteditable', 'false');
      span.textContent = `@${s.displayName}`;
      range.insertNode(span);
      // Drop a trailing space and place the caret after it so typing
      // resumes naturally.
      const tail = document.createTextNode(' ');
      span.parentNode?.insertBefore(tail, span.nextSibling);
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.setStartAfter(tail);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } else {
      // Group mention is plain text — the renderer turns it into a pill.
      const tail = document.createTextNode(`@${s.group} `);
      range.insertNode(tail);
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.setStartAfter(tail);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setMentionState(null);
    emitChange();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Mention and emoji popovers each own Up/Down/Enter/Tab/Escape
    // while open — those keys must not fall through to the editor
    // (no submit-on-Enter while picking a suggestion).
    if (mentionState || emojiState) {
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'Enter' ||
        e.key === 'Tab' ||
        e.key === 'Escape'
      ) {
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const md = elRef.current ? htmlToMarkdown(elRef.current) : '';
      onSubmit?.(md);
      return;
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); document.execCommand('bold'); emitChange(); return; }
      if (k === 'i') { e.preventDefault(); document.execCommand('italic'); emitChange(); return; }
      if (k === 'e') {
        e.preventDefault();
        wrapSelectionInTag('code');
        emitChange();
        return;
      }
    }
  }

  // Wrap the current selection (or insert an empty placeholder) in the
  // given tag. Used for inline-code which has no native execCommand.
  function wrapSelectionInTag(tag: string) {
    const sel = window.getSelection();
    if (!sel || !elRef.current) return;
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const wrapper = document.createElement(tag);
    if (range.collapsed) {
      wrapper.textContent = 'code';
      range.insertNode(wrapper);
      // Place cursor at the end.
      range.setStartAfter(wrapper);
      range.setEndAfter(wrapper);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    }
  }

  useImperativeHandle(ref, () => ({
    applyMark(mark) {
      switch (mark) {
        case 'bold':
          document.execCommand('bold');
          break;
        case 'italic':
          document.execCommand('italic');
          break;
        case 'strike':
          document.execCommand('strikeThrough');
          break;
        case 'code':
          wrapSelectionInTag('code');
          break;
      }
      emitChange();
    },
    applyBlock(block) {
      switch (block) {
        case 'ul':
          document.execCommand('insertUnorderedList');
          break;
        case 'ol':
          document.execCommand('insertOrderedList');
          break;
        case 'quote':
          // execCommand('formatBlock', false, 'blockquote') is supported
          // by every major browser; we use it instead of inserting "> "
          // so the visual rendering matches what the user will see.
          document.execCommand('formatBlock', false, 'blockquote');
          break;
      }
      emitChange();
    },
    applyLink() {
      const url = window.prompt('URL') ?? '';
      if (!url) return;
      document.execCommand('createLink', false, url);
      emitChange();
    },
    insertText(text) {
      // Toolbar buttons (emoji picker etc.) take focus before this
      // runs. Restore the editor's caret first so execCommand
      // actually has a target to insert into.
      restoreEditorSelection();
      document.execCommand('insertText', false, text);
      emitChange();
    },
    getMarkdown() {
      if (!elRef.current) return '';
      return htmlToMarkdown(elRef.current);
    },
    setMarkdown(md) {
      if (!elRef.current) return;
      elRef.current.innerHTML = markdownToEditableHtml(md);
      lastEmittedMarkdownRef.current = md;
      onChange?.(md);
    },
    focus() {
      elRef.current?.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [onChange]);

  // Help avoid the "void" of an empty contentEditable showing nothing —
  return (
    <>
      <div
        ref={elRef}
        role="textbox"
        contentEditable={!disabled}
        suppressContentEditableWarning
        aria-label={ariaLabel}
        data-placeholder={placeholder ?? ''}
        onInput={() => {
          emitChange();
          refreshMention();
          refreshEmoji();
        }}
        onKeyUp={() => {
          refreshMention();
          refreshEmoji();
        }}
        onKeyDown={handleKeyDown}
        onPaste={(e) => {
          if (!onPasteFiles) return;
          const items = e.clipboardData?.items;
          if (!items) return;
          const files: File[] = [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind !== 'file') continue;
            const f = it.getAsFile();
            if (f) files.push(f);
          }
          if (files.length === 0) return;
          // Some clipboards pair the file with text/html (alt text from
          // a screenshot tool). preventDefault keeps that out of the body.
          e.preventDefault();
          onPasteFiles(files);
        }}
        onBlur={() => {
          setMentionState(null);
          setEmojiState(null);
        }}
        tabIndex={0}
        className={
          'wysiwyg-editor min-h-[60px] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words text-sm focus:outline-none ' +
          (disabled ? 'opacity-50 cursor-not-allowed ' : '') +
          className
        }
      />
      {mentionState && (
        <MentionAutocomplete
          query={mentionState.query}
          anchorRect={mentionState.anchorRect}
          onPick={pickMention}
          onDismiss={() => setMentionState(null)}
        />
      )}
      {emojiState && (
        <EmojiAutocomplete
          query={emojiState.query}
          anchorRect={emojiState.anchorRect}
          onPick={pickEmoji}
          onDismiss={() => setEmojiState(null)}
        />
      )}
    </>
  );
});
