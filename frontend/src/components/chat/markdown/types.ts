// Imperative handle + format types for the message composer. The name
// `WysiwygEditorHandle` is kept for continuity (MessageInput and its toolbar
// were written against it); the implementation is now the CodeMirror
// MarkdownEditor, whose document is raw markdown.

export type ActiveFormat = 'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'ul' | 'ol';

export interface LinkEditState {
  /** Plain text content of the captured selection — empty if collapsed. */
  selectedText: string;
}

export interface WysiwygEditorHandle {
  applyMark: (mark: 'bold' | 'italic' | 'strike' | 'code') => void;
  applyBlock: (block: 'quote' | 'ul' | 'ol') => void;
  /**
   * Capture the current selection so a follow-up commitLinkEdit call can apply
   * the link to it after focus moves to a dialog. Call before opening the
   * link dialog.
   */
  beginLinkEdit: () => LinkEditState;
  /**
   * Apply the link to the previously captured selection. If the selection was
   * collapsed (no selected text), inserts `displayText` at the caret and links it.
   */
  commitLinkEdit: (url: string, displayText: string) => void;
  insertText: (text: string) => void;
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  focusEnd: () => void;
  blur: () => void;
  getElement: () => HTMLDivElement | null;
  getActiveFormats: () => Set<ActiveFormat>;
  /**
   * Subscribe to format changes. Fires on every editor state change (selection
   * move OR format toggle). Returns the unsubscribe function.
   */
  subscribeActiveFormats: (cb: (active: Set<ActiveFormat>) => void) => () => void;
}
