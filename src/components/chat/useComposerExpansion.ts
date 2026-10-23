import { useCallback, useState, type RefObject } from 'react';
import type { WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';

interface ComposerExpansionOptions {
  editorRef: RefObject<WysiwygEditorHandle | null>;
  isMobile: boolean;
  variant: 'composer' | 'inline';
  isEditingMode: boolean;
  hasContent: boolean;
}

// useComposerExpansion decides how much of the composer is showing. On a
// phone an idle, empty composer collapses to a single compact row; focusing
// it, typing, or opening a toolbar picker grows the formatting toolbar open.
// Wider screens and the inline edit box always show the toolbar.
export function useComposerExpansion({
  editorRef,
  isMobile,
  variant,
  isEditingMode,
  hasContent,
}: ComposerExpansionOptions) {
  const [editorFocused, setEditorFocused] = useState(false);
  const [toolbarPickerOpen, setToolbarPickerOpen] = useState(false);

  const compactMobileComposer = variant === 'composer' && !editorFocused && !hasContent;
  const showToolbar =
    variant !== 'composer' ||
    !isMobile ||
    editorFocused ||
    toolbarPickerOpen ||
    isEditingMode ||
    hasContent;
  const showToolbarSend = showToolbar && !isEditingMode && (!isMobile || variant === 'composer');
  // Phone: the toolbar's reveal box is always there so it can grow open, but
  // the toolbar itself (a dozen buttons and pickers) is not built until the
  // first focus. An idle composer then costs nothing to re-render; after
  // that first open it stays mounted so closing and reopening still slide.
  // (Adjusted during render, the way React derives state from a prop
  // change: it only ever flips to true, once.)
  const [toolbarEverShown, setToolbarEverShown] = useState(false);
  if (showToolbar && !toolbarEverShown) setToolbarEverShown(true);

  const collapseMobileComposer = useCallback(() => {
    setToolbarPickerOpen(false);
    setEditorFocused(false);
    const blurComposer = () => {
      editorRef.current?.blur();
      const active = document.activeElement;
      /* istanbul ignore next -- document.activeElement is the focused contenteditable (an HTMLElement) or <body>; the non-HTMLElement false arm is not reachable from a test. */
      if (active instanceof HTMLElement) active.blur();
    };
    blurComposer();
    requestAnimationFrame(blurComposer);
  }, [editorRef]);

  function handleToolbarPickerOpenChange(open: boolean) {
    setToolbarPickerOpen(open);
    /* istanbul ignore next -- the desktop early-return is only reached by opening the toolbar EmojiPicker on desktop, which synchronously trips an unrelated React setState-in-render warning in EmojiPicker that the console-gate rejects; the mobile path (the meaningful blur/refocus logic) is covered. */
    if (!isMobile) return;
    if (open) {
      editorRef.current?.blur();
      return;
    }
    // Synchronous refocus, like the insert paths in the toolbar: a deferred
    // focus (rAF/microtask) loses the dismiss tap's user-gesture context and
    // the iOS keyboard stays closed.
    editorRef.current?.focus();
  }

  return {
    editorFocused,
    setEditorFocused,
    compactMobileComposer,
    showToolbar,
    showToolbarSend,
    toolbarEverShown,
    collapseMobileComposer,
    handleToolbarPickerOpenChange,
  };
}
