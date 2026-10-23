import { useEffect, useState, type RefObject } from 'react';
import type { ActiveFormat, WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import { useWorkspaceSettings } from '@/hooks/useSettings';

// useComposerToolbarState gathers what the formatting toolbar reflects: the
// formats active at the caret (its pressed buttons) and whether the GIF
// picker is available in this workspace.
export function useComposerToolbarState(editorRef: RefObject<WysiwygEditorHandle | null>) {
  // Toolbar pressed-state tracking. Driven by the editor's update
  // subscription so a toolbar click flips the pressed state immediately —
  // selectionchange only fires when the caret moves and would lag behind
  // format toggles by one keystroke.
  const [activeFormats, setActiveFormats] = useState<Set<ActiveFormat>>(new Set());
  useEffect(() => {
    return editorRef.current?.subscribeActiveFormats?.(setActiveFormats);
  }, [editorRef]);

  const { data: settings } = useWorkspaceSettings();
  /* istanbul ignore next -- the `?? ''` fallback only applies when settings.giphyAPIKey is undefined, but the settings object always carries the field; defensive. */
  const giphyAPIKey = settings?.giphyAPIKey?.trim() ?? '';
  /* istanbul ignore next -- the `?? false` fallback only applies when settings.giphyEnabled is undefined, but the settings object always carries the flag; defensive. */
  const giphyEnabled = (settings?.giphyEnabled ?? false) && giphyAPIKey !== '';

  return { activeFormats, giphyAPIKey, giphyEnabled };
}
