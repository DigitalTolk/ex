import { useCallback, useMemo, useState, type RefObject } from 'react';
import type { WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import { isHttpUrl } from '@/lib/utils';

// useLinkDialog holds the toolbar's Insert-link dialog. Opening the dialog
// calls editor.beginLinkEdit, which captures the current selection (the
// editor loses its selection when focus moves to the modal), so the eventual
// commit can apply the link to the right text.
export function useLinkDialog(editorRef: RefObject<WysiwygEditorHandle | null>) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');

  const openDialog = useCallback(() => {
    /* istanbul ignore next -- editorRef is wired to the mounted WysiwygEditor before the toolbar's Link button can be clicked, so beginLinkEdit is always defined; the `?? { selectedText: '' }` fallback is defensive. */
    const { selectedText } = editorRef.current?.beginLinkEdit?.() ?? { selectedText: '' };
    setText(selectedText);
    setUrl('');
    setOpen(true);
  }, [editorRef]);

  const submit = useCallback(() => {
    const trimmedUrl = url.trim();
    // isHttpUrl is the same gate PasteLinkPlugin uses — blocks
    // javascript:/data:/vbscript: schemes regardless of what the
    // browser's <input type="url"> accepts.
    if (!isHttpUrl(trimmedUrl)) return;
    const displayText = text.trim() || trimmedUrl;
    editorRef.current?.commitLinkEdit?.(trimmedUrl, displayText);
    setOpen(false);
    queueMicrotask(() => editorRef.current?.focus());
  }, [url, text, editorRef]);

  // One object per change of its own fields, so the memoized dialog does not
  // re-render with every keystroke in the composer.
  return useMemo(
    () => ({ open, setOpen, url, setUrl, text, setText, openDialog, submit }),
    [open, url, text, openDialog, submit],
  );
}

export type LinkDialogState = ReturnType<typeof useLinkDialog>;
