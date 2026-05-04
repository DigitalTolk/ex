import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getRoot,
  $getNearestNodeFromDOMNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from 'lexical';
import { $isMentionNode } from '../nodes/MentionNode';
import { $isChannelMentionNode } from '../nodes/ChannelMentionNode';

export function ClearSelectedContentPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const clearSelectedContent = (event: KeyboardEvent, direction: 'backward' | 'forward') => {
      const rootElement = editor.getRootElement();
      const shouldClear = domSelectionCoversEditor(rootElement);
      if (!shouldClear && !removeAdjacentMention(editor, rootElement, direction)) return false;
      event.preventDefault();
      if (!shouldClear) return true;
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
        $setSelection(root.selectStart());
      });
      return true;
    };

    return mergeRegisters(
      editor.registerCommand(KEY_BACKSPACE_COMMAND, (event) => clearSelectedContent(event, 'backward'), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_DELETE_COMMAND, (event) => clearSelectedContent(event, 'forward'), COMMAND_PRIORITY_HIGH),
    );
  }, [editor]);

  return null;
}

function domSelectionCoversEditor(rootElement: HTMLElement | null): boolean {
  /* c8 ignore next */
  if (!rootElement) return false;
  const selection = window.getSelection();
  /* c8 ignore next */
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  /* c8 ignore next */
  if (!anchor || !focus) return false;
  /* c8 ignore next */
  if (!rootElement.contains(anchor) || !rootElement.contains(focus)) return false;
  if (selection.toString() === (rootElement.textContent ?? '')) return true;
  const range = selection.getRangeAt(0);
  const editorRange = document.createRange();
  editorRange.selectNodeContents(rootElement);
  return (
    range.compareBoundaryPoints(Range.START_TO_START, editorRange) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, editorRange) >= 0
  );
}

function removeAdjacentMention(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  rootElement: HTMLElement | null,
  direction: 'backward' | 'forward',
): boolean {
  const mentionElement = adjacentMentionElement(rootElement, direction);
  if (!mentionElement) return false;
  let removed = false;
  editor.update(() => {
    const node = $getNearestNodeFromDOMNode(mentionElement);
    if ($isMentionNode(node) || $isChannelMentionNode(node)) {
      node.remove();
      removed = true;
    }
  });
  return removed;
}

/* c8 ignore start */
function adjacentMentionElement(rootElement: HTMLElement | null, direction: 'backward' | 'forward'): HTMLElement | null {
  if (!rootElement) return null;
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  if (!rootElement.contains(container)) return null;
  let candidate: Node | null = null;
  if (container.nodeType === Node.ELEMENT_NODE) {
    candidate = direction === 'backward'
      ? container.childNodes[range.startOffset - 1] ?? null
      : container.childNodes[range.startOffset] ?? null;
  } else if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? '';
    if (direction === 'backward' && range.startOffset === 0) {
      candidate = container.previousSibling ?? container.parentNode?.previousSibling ?? null;
    } else if (direction === 'forward' && range.startOffset === text.length) {
      candidate = container.nextSibling ?? container.parentNode?.nextSibling ?? null;
    }
  }
  if (!(candidate instanceof HTMLElement)) return null;
  return candidate.closest<HTMLElement>('[data-user-id], [data-channel-id]');
}
/* c8 ignore stop */

function mergeRegisters(...unregisters: Array<() => void>) {
  return () => {
    for (const unregister of unregisters) unregister();
  };
}
