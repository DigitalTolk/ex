import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $exportMarkdown } from '../markdown-export';
import { $isListItemNode } from '@lexical/list';
import { $isQuoteNode } from '@lexical/rich-text';
import { $isCodeNode } from '@lexical/code';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
} from 'lexical';

interface Props {
  onSubmit?: (markdown: string) => void;
  onCancel?: () => void;
}

// Bare Enter at top-level (paragraph) submits the message; inside a
// list item / blockquote / code block we let Lexical's defaults run so
// the user gets a new list item / quote line / code line. Escape is
// wired the same way for consistent cancel-from-edit UX.
export function SubmitOnEnterPlugin({ onSubmit, onCancel }: Props) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event || event.shiftKey) return false;
        const selection = $getSelection();
        // No selection (mounted-but-not-focused) → treat as top-level
        // and submit. Only suppress when the caret is demonstrably
        // inside a list item / blockquote / code block, where Lexical's
        // default new-line behaviour is what the user wants.
        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          for (
            let node: ReturnType<typeof anchorNode.getParent> | typeof anchorNode | null = anchorNode;
            node;
            node = node?.getParent() ?? null
          ) {
            if ($isListItemNode(node) || $isQuoteNode(node) || $isCodeNode(node)) {
              return false;
            }
          }
        }
        event.preventDefault();
        if (onSubmit) {
          editor.getEditorState().read(() => {
            onSubmit($exportMarkdown());
          });
        }
        return true;
      },
      // Stay at LOW so the typeahead plugins (registered at NORMAL
      // via commandPriority) preempt this handler when their menu is
      // open. Within a single priority Lexical iterates listeners in
      // INSERTION order, so we can't rely on registration timing —
      // moving the typeaheads to NORMAL is what guarantees they win
      // the Enter event when their popup has a selection.
      COMMAND_PRIORITY_LOW,
    );
    const removeEsc = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        if (!onCancel) return false;
        event?.preventDefault();
        onCancel();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      removeEnter();
      removeEsc();
    };
  }, [editor, onSubmit, onCancel]);

  return null;
}
