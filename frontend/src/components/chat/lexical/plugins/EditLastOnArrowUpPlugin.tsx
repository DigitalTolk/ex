import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_UP_COMMAND,
} from 'lexical';

interface Props {
  // Called when the user presses ArrowUp in an empty editor. Return
  // true to claim the event (caret movement is suppressed); return
  // false (or omit a handler) to let Lexical's default arrow-up
  // behaviour run. Registered at LOW priority so an open typeahead
  // (NORMAL) preempts this — ArrowUp inside an open mention/emoji
  // menu still moves the menu's selection.
  onArrowUpEmpty?: () => boolean;
}

export function EditLastOnArrowUpPlugin({ onArrowUpEmpty }: Props) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onArrowUpEmpty) return;
    return editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        let isEmpty = false;
        editor.getEditorState().read(() => {
          isEmpty = $getRoot().getTextContentSize() === 0;
        });
        if (!isEmpty) return false;
        if (!onArrowUpEmpty()) return false;
        event?.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, onArrowUpEmpty]);
  return null;
}
