import { useEffect, useState, type RefObject } from 'react';
import type { ActiveFormat, WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import { useWorkspaceSettings } from '@/hooks/useSettings';
import { ohmagifKey } from '@/lib/ohmagif';

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
    // The editor publishes a fresh Set on every keystroke; keep the previous
    // one while the formats are the same, so the memoized toolbar holds.
    return editorRef.current?.subscribeActiveFormats?.((next) =>
      setActiveFormats((prev) => (sameFormats(prev, next) ? prev : next)),
    );
  }, [editorRef]);

  // The GIF picker needs the workspace's ohmagif key; without one there is
  // no GIF button.
  const { data: settings } = useWorkspaceSettings();
  const gifKey = ohmagifKey(settings?.ohmagifAPIKey);

  return { activeFormats, gifKey };
}

function sameFormats(a: Set<ActiveFormat>, b: Set<ActiveFormat>): boolean {
  if (a.size !== b.size) return false;
  for (const f of a) if (!b.has(f)) return false;
  return true;
}
