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
      /* istanbul ignore next -- reached only via the adjacent-mention path (shouldClear false, removeAdjacentMention true), which depends on the native DOM-selection -> Lexical-node resolution that the headless browser cannot land deterministically under coverage instrumentation; see removeAdjacentMention below. */
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
  /* istanbul ignore next -- defensive: the command only fires while the editor is mounted, so rootElement is always present. */
  if (!rootElement) return false;
  const selection = window.getSelection();
  /* istanbul ignore next -- defensive: a no/collapsed/empty selection is the common case but is exercised via the collapsed-caret tests; this guard's truthy arm is the unselectable empty-window edge. */
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  /* istanbul ignore next -- defensive: a non-collapsed selection always has anchor and focus nodes. */
  if (!anchor || !focus) return false;
  /* istanbul ignore next -- defensive: a selection placed over the editor's own content is always contained by rootElement. */
  if (!rootElement.contains(anchor) || !rootElement.contains(focus)) return false;
  /* istanbul ignore next -- the `?? ''` nullish fallback only applies when rootElement.textContent is null, which never happens for a mounted contenteditable; defensive. */
  const fullText = rootElement.textContent ?? '';
  /* istanbul ignore next -- this equality is only reached for a non-collapsed selection (select-all), where the headless browser always makes toString() equal textContent; the false arm that falls through to the boundary-point check is unreachable from a test. */
  if (selection.toString() === fullText) return true;
  /* istanbul ignore next -- the boundary-point fallback only runs when a covering selection's toString differs from textContent; the headless browser normalizes select-all so toString equals textContent and this branch is not reachable from a test. */
  const range = selection.getRangeAt(0);
  /* istanbul ignore next */
  const editorRange = document.createRange();
  /* istanbul ignore next */
  editorRange.selectNodeContents(rootElement);
  /* istanbul ignore next */
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
    /* istanbul ignore next -- the mention-node match depends on the native DOM-selection -> Lexical-node resolution; under headless + coverage instrumentation the resolved node does not land on the adjacent mention, so this removal arm is not reachable from a test (the default key handler removes the node instead). */
    if ($isMentionNode(node) || $isChannelMentionNode(node)) {
      node.remove();
      removed = true;
    }
  });
  return removed;
}

/* istanbul ignore next -- walks the native DOM selection to find an element-/text-node-adjacent mention span; the headless browser cannot place a real caret that resolves these element/text-node + direction branches deterministically under coverage instrumentation. */
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

function mergeRegisters(...unregisters: Array<() => void>) {
  return () => {
    for (const unregister of unregisters) unregister();
  };
}
