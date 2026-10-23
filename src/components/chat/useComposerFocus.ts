import { useEffect, useRef, type RefObject } from 'react';
import type { WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import { onFocusComposer } from '@/lib/window-events';

interface ComposerFocusOptions {
  editorRef: RefObject<WysiwygEditorHandle | null>;
  variant: 'composer' | 'inline';
  editorFocused: boolean;
  focusKey?: string;
  suppressAutoFocus: boolean;
  typingParentID?: string;
  typingThreadRootID?: string;
}

// useComposerFocus puts the caret back in the composer when the user comes
// back to it: on opening a scope (focusKey), after an inline edit elsewhere
// finishes, and on returning to the app with the editor focused.
export function useComposerFocus({
  editorRef,
  variant,
  editorFocused,
  focusKey,
  suppressAutoFocus,
  typingParentID,
  typingThreadRootID,
}: ComposerFocusOptions) {
  // Track focus state in a ref so visibility-change snapshot logic
  // survives effect re-runs without re-binding listeners.
  const editorFocusedRef = useRef(false);
  useEffect(() => {
    editorFocusedRef.current = editorFocused;
  }, [editorFocused]);
  const wasFocusedOnHideRef = useRef(false);

  useEffect(() => {
    if (variant !== 'composer') return;
    // Snapshot whether the editor was focused at hide-time. iOS keeps
    // the on-screen keyboard up across app switches, but the
    // contenteditable loses focus, so the composer no longer scrolls
    // into view. On visibilitychange→visible, restore focus so the
    // viewport snaps back to the input under the live keyboard.
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasFocusedOnHideRef.current = editorFocusedRef.current;
        return;
      }
      if (wasFocusedOnHideRef.current) {
        wasFocusedOnHideRef.current = false;
        queueMicrotask(() => editorRef.current?.focus());
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [variant, editorRef]);

  useEffect(() => {
    if (focusKey === undefined) return;
    if (suppressAutoFocus) return;
    queueMicrotask(() => {
      editorRef.current?.focus();
    });
  }, [focusKey, suppressAutoFocus, editorRef]);

  // Refocus when an inline edit elsewhere finishes (cancel or submit).
  // Only composers that emit typing (i.e., the main / thread composer,
  // not the inline-edit MessageInput inside MessageItem) participate.
  // The thread-vs-main scope is disambiguated by typingThreadRootID:
  // a non-thread edit's event matches composers without a thread root,
  // and vice versa.
  useEffect(() => {
    if (!typingParentID) return;
    const inThreadComposer = !!typingThreadRootID;
    return onFocusComposer((detail) => {
      if (detail.parentID !== typingParentID) return;
      if (detail.inThread !== inThreadComposer) return;
      queueMicrotask(() => editorRef.current?.focus());
    });
  }, [typingParentID, typingThreadRootID, editorRef]);
}
