import { useImperativeHandle, useRef, type Ref } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { $exportMarkdown } from '../markdown-export';
import {
  $createParagraphNode,
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  FORMAT_TEXT_COMMAND,
  type RangeSelection,
} from 'lexical';
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from '@lexical/list';
import { $isQuoteNode, $createQuoteNode } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import { TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $findMatchingParent } from '@lexical/utils';
import { EX_TRANSFORMERS } from '../transformers';

export type ActiveFormat = 'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'ul' | 'ol';

export interface LinkEditState {
  /** Plain text content of the captured selection — empty if collapsed. */
  selectedText: string;
}

export interface WysiwygEditorHandle {
  applyMark: (mark: 'bold' | 'italic' | 'strike' | 'code') => void;
  applyBlock: (block: 'quote' | 'ul' | 'ol') => void;
  /**
   * Capture the current selection so a follow-up commitLink call can
   * apply the link to it after focus moves to a dialog. Call this
   * before opening the link dialog.
   */
  beginLinkEdit: () => LinkEditState;
  /**
   * Apply the link to the previously captured selection. If the
   * selection was collapsed (no selected text), inserts `displayText`
   * at the caret and links it.
   */
  commitLinkEdit: (url: string, displayText: string) => void;
  insertText: (text: string) => void;
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  getElement: () => HTMLDivElement | null;
  getActiveFormats: () => Set<ActiveFormat>;
  /**
   * Subscribe to format changes. Fires on every editor state change
   * (selection move OR format toggle), not just selectionchange — so
   * the toolbar reflects toggle clicks immediately.
   * Returns the unsubscribe function.
   */
  subscribeActiveFormats: (cb: (active: Set<ActiveFormat>) => void) => () => void;
}

interface Props {
  imperativeRef: Ref<WysiwygEditorHandle>;
}

// When the imperative API is invoked without a prior user click into
// the editor (which is the common case when MessageInput's toolbar is
// driven by code or by a test), Lexical's selection is null. Establish
// a text-level range covering the entire document so mark / list /
// link / setBlocksType commands have a concrete target. Real-browser
// focus already does this; jsdom does not.
function $ensureSelectionOverAllContent() {
  if ($isRangeSelection($getSelection())) return;
  const root = $getRoot();
  if (root.getChildrenSize() === 0) {
    root.selectEnd();
    return;
  }
  const sel = $createRangeSelection();
  // Anchor at the start of the first descendant text/element, focus at
  // the end of the last — that matches Cmd-A and is what setBlocksType
  // / TOGGLE_LINK expect.
  const first = root.getFirstDescendant();
  const last = root.getLastDescendant();
  if (first && 'getKey' in first) {
    sel.anchor.set(first.getKey(), 0, getPointType(first));
  } else {
    sel.anchor.set(root.getKey(), 0, 'element');
  }
  if (last && 'getKey' in last) {
    const offset = 'getTextContentSize' in last && typeof last.getTextContentSize === 'function'
      ? last.getTextContentSize()
      : 0;
    sel.focus.set(last.getKey(), offset, getPointType(last));
  } else {
    sel.focus.set(root.getKey(), root.getChildrenSize(), 'element');
  }
  $setSelection(sel);
}

function getPointType(node: { getType?: () => string }): 'text' | 'element' {
  return node.getType?.() === 'text' ? 'text' : 'element';
}

// Maps the public WysiwygEditorHandle to the equivalent native Lexical
// commands / state reads. Every method here is one-line glue —
// the implementation lives in @lexical/* packages.
export function ImperativeHandlePlugin({ imperativeRef }: Props) {
  const [editor] = useLexicalComposerContext();
  // Selection captured by beginLinkEdit. Lexical RangeSelection objects
  // belong to a specific editor state, so we clone before storing — the
  // committed selection on commit may be from a different state revision.
  const savedLinkSelectionRef = useRef<RangeSelection | null>(null);

  useImperativeHandle(
    imperativeRef,
    () => ({
      applyMark(mark) {
        editor.update($ensureSelectionOverAllContent);
        const target = mark === 'strike' ? 'strikethrough' : mark;
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, target);
      },
      applyBlock(block) {
        editor.update($ensureSelectionOverAllContent);
        if (block === 'ul') {
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
          return;
        }
        if (block === 'ol') {
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
          return;
        }
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const inQuote = !!$findMatchingParent(selection.anchor.getNode(), $isQuoteNode);
          $setBlocksType(selection, () => (inQuote ? $createParagraphNode() : $createQuoteNode()));
        });
      },
      beginLinkEdit() {
        let selectedText = '';
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) {
            savedLinkSelectionRef.current = sel.clone();
            selectedText = sel.getTextContent();
          } else {
            savedLinkSelectionRef.current = null;
          }
        });
        return { selectedText };
      },
      commitLinkEdit(url, displayText) {
        editor.update(() => {
          const saved = savedLinkSelectionRef.current?.clone() ?? null;
          if (saved && saved.getTextContent().length > 0) {
            $setSelection(saved);
            return;
          }
          // No prior text-bearing selection — drop the display text at
          // end-of-doc, then stretch the selection back over it so the
          // TOGGLE_LINK_COMMAND below has a target. We seed via
          // selectEnd + insertText (Lexical-native) and re-select the
          // inserted run by walking back `displayText.length` chars in
          // the anchor's text node.
          const beforeSel = $getRoot().selectEnd();
          beforeSel.insertText(displayText);
          const after = $getSelection();
          if ($isRangeSelection(after)) {
            const focusOffset = after.focus.offset;
            after.anchor.set(after.focus.key, Math.max(0, focusOffset - displayText.length), 'text');
          }
        });
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
        savedLinkSelectionRef.current = null;
      },
      insertText(text) {
        editor.update(() => {
          const selection = $isRangeSelection($getSelection())
            ? ($getSelection() as ReturnType<typeof $createRangeSelection>)
            : $getRoot().selectEnd();
          selection.insertText(text);
        });
      },
      getMarkdown() {
        let md = '';
        editor.getEditorState().read(() => {
          md = $exportMarkdown();
        });
        return md;
      },
      setMarkdown(md) {
        editor.update(() => {
          $convertFromMarkdownString(md, EX_TRANSFORMERS, undefined, true);
        });
      },
      focus() {
        // Lexical's editor.focus() is reliable in real browsers. In
        // jsdom (tests) the rootElement.focus() call inside is a no-op
        // unless the element is contenteditable + has tabindex; calling
        // dom.focus() directly first ensures document.activeElement
        // matches the editor surface in both runtimes.
        const dom = editor.getRootElement();
        dom?.focus();
        editor.focus();
      },
      getElement() {
        return editor.getRootElement() as HTMLDivElement | null;
      },
      getActiveFormats() {
        return readActiveFormats(editor);
      },
      subscribeActiveFormats(cb) {
        // Lexical's registerUpdateListener fires on every editor
        // mutation including pure typing. Dedupe by serializing the
        // active set to a stable key so the toolbar's setState only
        // runs when something actually changes.
        let last = '';
        const push = () => {
          const next = readActiveFormats(editor);
          const key = activeFormatsKey(next);
          if (key === last) return;
          last = key;
          cb(next);
        };
        push();
        return editor.registerUpdateListener(push);
      },
    }),
    [editor],
  );

  return null;
}

// Stable, order-independent string fingerprint of the active set —
// used to suppress redundant subscriber notifications.
const FORMAT_ORDER: ActiveFormat[] = ['bold', 'italic', 'strike', 'code', 'quote', 'ul', 'ol'];
function activeFormatsKey(active: Set<ActiveFormat>): string {
  return FORMAT_ORDER.filter((f) => active.has(f)).join('|');
}

function readActiveFormats(editor: ReturnType<typeof useLexicalComposerContext>[0]): Set<ActiveFormat> {
  const out = new Set<ActiveFormat>();
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    if (selection.hasFormat('bold')) out.add('bold');
    if (selection.hasFormat('italic')) out.add('italic');
    if (selection.hasFormat('strikethrough')) out.add('strike');
    if (selection.hasFormat('code')) out.add('code');
    const anchor = selection.anchor.getNode();
    if ($findMatchingParent(anchor, $isQuoteNode)) out.add('quote');
    const list = $findMatchingParent(anchor, $isListNode);
    if (list) {
      const tag = list.getListType();
      if (tag === 'bullet') out.add('ul');
      else if (tag === 'number') out.add('ol');
    }
  });
  return out;
}
