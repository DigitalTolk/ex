import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from 'lexical';

interface Props {
  onPasteFiles?: (files: File[]) => void;
}

// Routes file pastes (screenshots, copied files) up to the surrounding
// composer so they get uploaded via the same path as drag-and-drop.
// Plain text pastes fall through to Lexical's default handler so
// markdown / formatting still works.
export function PasteFilesPlugin({ onPasteFiles }: Props) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPasteFiles) return;
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        // Duck-type clipboardData rather than `instanceof ClipboardEvent`
        // so synthetic events from tests still hit this path.
        const clipboardData = (event as { clipboardData?: DataTransfer | null })?.clipboardData;
        const items = clipboardData?.items;
        if (!items) return false;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind !== 'file') continue;
          const f = it.getAsFile();
          if (f) files.push(f);
        }
        if (files.length === 0) return false;
        if (event && typeof (event as Event).preventDefault === 'function') {
          (event as Event).preventDefault();
        }
        onPasteFiles(files);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onPasteFiles]);

  return null;
}
