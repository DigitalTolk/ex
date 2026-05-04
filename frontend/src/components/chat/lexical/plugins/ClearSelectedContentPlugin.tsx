import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getRoot,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from 'lexical';

export function ClearSelectedContentPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const clearSelectedContent = (event: KeyboardEvent) => {
      const rootElement = editor.getRootElement();
      const shouldClear = domSelectionCoversEditor(rootElement);
      if (!shouldClear) return false;

      event.preventDefault();
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
        $setSelection(root.selectStart());
      });
      return true;
    };

    return mergeRegisters(
      editor.registerCommand(KEY_BACKSPACE_COMMAND, clearSelectedContent, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_DELETE_COMMAND, clearSelectedContent, COMMAND_PRIORITY_HIGH),
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
  return selection.toString() === (rootElement.textContent ?? '');
}

function mergeRegisters(...unregisters: Array<() => void>) {
  return () => {
    for (const unregister of unregisters) unregister();
  };
}
