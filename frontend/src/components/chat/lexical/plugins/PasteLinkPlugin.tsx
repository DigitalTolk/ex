import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
} from 'lexical';
import { TOGGLE_LINK_COMMAND } from '@lexical/link';
import { isHttpUrl } from '@/lib/utils';

// "Paste URL onto selected text wraps it in a link" — same UX pattern
// as Google Docs / Notion / Slack. Runs at HIGH priority so we beat
// Lexical's default paste handler, but only claims the event when both
// preconditions hold:
//   1. clipboard's plain-text payload is a single absolute URL, AND
//   2. the editor has a non-collapsed range selection.
// Otherwise we return false and let Lexical's default markdown / plain
// text paste run.
export function PasteLinkPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = (event as { clipboardData?: DataTransfer | null })?.clipboardData;
        if (!clipboardData) return false;
        const text = clipboardData.getData('text/plain')?.trim() ?? '';
        if (!isHttpUrl(text)) return false;

        let claimed = false;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;
          if (sel.isCollapsed()) return;
          if (sel.getTextContent().length === 0) return;
          claimed = true;
        });
        if (!claimed) return false;

        if (event && typeof (event as Event).preventDefault === 'function') {
          (event as Event).preventDefault();
        }
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, text);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
