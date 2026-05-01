import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $convertToMarkdownString } from '@lexical/markdown';
import { EX_TRANSFORMERS } from '../transformers';

interface Props {
  onChange?: (markdown: string) => void;
}

// Forward the editor's current markdown to the host every time the
// document changes. Skips empty-→-empty transitions and dedupes
// identical strings so listeners (typing-indicator throttle, body
// state in MessageInput) don't fire on no-op transactions.
export function MarkdownChangePlugin({ onChange }: Props) {
  const [editor] = useLexicalComposerContext();
  const lastEmittedRef = useRef<string>('');

  useEffect(() => {
    if (!onChange) return;
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const md = $convertToMarkdownString(EX_TRANSFORMERS).trim();
        if (md === lastEmittedRef.current) return;
        lastEmittedRef.current = md;
        onChange(md);
      });
    });
  }, [editor, onChange]);

  return null;
}
