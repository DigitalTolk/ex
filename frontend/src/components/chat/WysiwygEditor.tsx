import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { htmlToMarkdown, markdownToEditableHtml } from '@/lib/wysiwyg';

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
}

// We use document.execCommand for inline marks: deprecated in the spec
// but universally implemented and the simplest way to get correct
// selection-aware toggling without a full editor framework like Lexical.
export const WysiwygEditor = forwardRef<WysiwygEditorHandle, Props>(function WysiwygEditor(
  { initialBody = '', onChange, onSubmit, onCancel, placeholder, disabled, ariaLabel = 'Message input', className = '' },
  ref,
) {
  const elRef = useRef<HTMLDivElement>(null);
  const lastEmittedMarkdownRef = useRef<string>('');

  useEffect(() => {
    if (!elRef.current) return;
    elRef.current.innerHTML = markdownToEditableHtml(initialBody);
    lastEmittedMarkdownRef.current = initialBody;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function emitChange() {
    if (!elRef.current) return;
    const md = htmlToMarkdown(elRef.current);
    if (md === lastEmittedMarkdownRef.current) return;
    lastEmittedMarkdownRef.current = md;
    onChange?.(md);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
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
    <div
      ref={elRef}
      role="textbox"
      contentEditable={!disabled}
      suppressContentEditableWarning
      aria-label={ariaLabel}
      data-placeholder={placeholder ?? ''}
      onInput={emitChange}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      className={
        'wysiwyg-editor min-h-[60px] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words text-sm focus:outline-none ' +
        (disabled ? 'opacity-50 cursor-not-allowed ' : '') +
        className
      }
    />
  );
});
