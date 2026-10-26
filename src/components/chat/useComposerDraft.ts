import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';
import type { WysiwygEditorHandle } from '@/components/chat/markdown/MarkdownComposer';
import type { MessageInputValue } from './MessageInput';

// How long a composer must have been hidden before, on waking, it drops its
// "the user edited this" claim and defers to the server's draft state. Long
// enough that a quick alt-tab never clobbers live typing; short enough that a
// laptop reopened after a meeting shows the truth, not a stale buffer.
const WAKE_DEFERS_TO_SERVER_MS = 60_000;

// How long typing must pause before the draft is saved silently.
const DRAFT_SAVE_DEBOUNCE_MS = 600;

// `notify` distinguishes a focus-loss flush (true → surface the draft in the
// sidebar) from a keystroke save (omitted/false → persist silently).
// `keepalive` marks a teardown flush (pagehide): the save should ride a
// keepalive fetch so it survives the page dying.
export type DraftChangeHandler = (
  value: MessageInputValue,
  options?: { notify?: boolean; keepalive?: boolean },
) => void;

interface ComposerDraftOptions {
  editorRef: RefObject<WysiwygEditorHandle | null>;
  variant: 'composer' | 'inline';
  focusKey?: string;
  initialBody: string;
  initialDrafts: DraftAttachment[];
  onDraftChange?: DraftChangeHandler;
  suppressAutoFocus: boolean;
}

// useComposerDraft owns the composer's buffer — the markdown body and the
// attachment chips — and keeps it in step with the scope's server draft:
// it loads the draft when the scope (focusKey) changes, mirrors server-side
// changes in while the user isn't editing, saves keystrokes after a pause,
// and flushes on blur / hide / pagehide / unmount so the draft surfaces in
// the sidebar. Only the docked composer variant persists anything; the
// inline edit box just holds its buffer.
export function useComposerDraft({
  editorRef,
  variant,
  focusKey,
  initialBody,
  initialDrafts,
  onDraftChange,
  suppressAutoFocus,
}: ComposerDraftOptions) {
  const [body, setBody] = useState(initialBody);
  const [drafts, setDrafts] = useState<DraftAttachment[]>(initialDrafts);
  const mountedDraftChangeRef = useRef(false);
  const locallyEditedDraftRef = useRef(false);
  const applyingServerDraftRef = useRef(false);
  const focusKeyMountedRef = useRef(false);
  const latestDraftValueRef = useRef<MessageInputValue>({
    body: initialBody,
    attachmentIDs: initialDrafts.map((d) => d.id),
  });
  const hasInitialDraftValueRef = useRef(false);
  const scopedDraftChangeRef = useRef(onDraftChange);
  const activeDraftFocusKeyRef = useRef(focusKey);
  const hiddenAtRef = useRef(0);

  const hasInitialDraftValue = initialBody !== '' || initialDrafts.length > 0;

  useEffect(() => {
    // No client timestamp rides along anymore: the server orders saves vs
    // sends by generation tokens, so a delayed flush can never out-rank a
    // later clear no matter what clock it carries.
    latestDraftValueRef.current = { body, attachmentIDs: drafts.map((d) => d.id) };
  }, [body, drafts]);

  useEffect(() => {
    hasInitialDraftValueRef.current = hasInitialDraftValue;
  }, [hasInitialDraftValue]);

  useEffect(() => {
    if (focusKey !== undefined && activeDraftFocusKeyRef.current !== focusKey) return;
    scopedDraftChangeRef.current = onDraftChange;
  }, [focusKey, onDraftChange]);

  const flushDraft = useCallback((options?: { keepalive?: boolean }) => {
    if (variant !== 'composer') return;
    const value = latestDraftValueRef.current;
    const shouldFlush =
      value.body !== '' ||
      value.attachmentIDs.length > 0 ||
      hasInitialDraftValueRef.current ||
      mountedDraftChangeRef.current;
    if (!shouldFlush) return;
    // A flush means the composer lost focus / is going away — this is the
    // moment the draft should surface in the sidebar, so notify.
    scopedDraftChangeRef.current?.(value, { notify: true, keepalive: options?.keepalive });
  }, [variant]);

  useEffect(() => {
    if (variant !== 'composer') return;
    if (focusKey === undefined) return;
    if (focusKeyMountedRef.current) {
      flushDraft();
    } else {
      focusKeyMountedRef.current = true;
    }
    scopedDraftChangeRef.current = onDraftChange;
    activeDraftFocusKeyRef.current = focusKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBody(initialBody);
    applyingServerDraftRef.current = true;
    editorRef.current?.setMarkdown(initialBody);
    queueMicrotask(() => {
      applyingServerDraftRef.current = false;
      if (!suppressAutoFocus && (initialBody || initialDrafts.length > 0)) {
        editorRef.current?.focusEnd?.();
      }
    });
    setDrafts(initialDrafts);
    locallyEditedDraftRef.current = false;
    mountedDraftChangeRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, flushDraft]);

  // Mirror the scope's server draft into the buffer whenever they disagree
  // and the user isn't editing — the server owns draft state; the composer
  // merely displays it until the user takes over (typing sets the local-edit
  // claim, which a scope switch or a long sleep resets). Crucially this
  // INCLUDES emptiness: a draft cleared or sent on another device empties
  // this composer too, instead of leaving a zombie buffer that re-offers
  // long-deleted content and re-saves it on its next flush.
  useEffect(() => {
    if (variant !== 'composer') return;
    if (locallyEditedDraftRef.current) return;
    // Already in sync (the common case: our own flush round-tripped through
    // the cache) — leave the editor alone; rewriting content moves the caret.
    if (
      initialBody === body &&
      initialDrafts.length === drafts.length &&
      initialDrafts.every((d, i) => d.id === drafts[i].id)
    ) {
      return;
    }
    // Focus only for the classic late-hydration case (a draft arriving into
    // an EMPTY composer right after opening the scope) — a background
    // refresh replacing existing content must never steal focus.
    const bufferWasEmpty = body === '' && drafts.length === 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBody(initialBody);
    applyingServerDraftRef.current = true;
    editorRef.current?.setMarkdown(initialBody);
    queueMicrotask(() => {
      applyingServerDraftRef.current = false;
      if (!suppressAutoFocus && focusKey !== undefined && bufferWasEmpty && (initialBody !== '' || initialDrafts.length > 0)) {
        editorRef.current?.focusEnd?.();
      }
    });
    setDrafts(initialDrafts);
    mountedDraftChangeRef.current = false;
  }, [initialBody, initialDrafts, body, drafts, focusKey, variant, suppressAutoFocus, editorRef]);

  useEffect(() => {
    if (!scopedDraftChangeRef.current || variant !== 'composer') return;
    if (!mountedDraftChangeRef.current) {
      mountedDraftChangeRef.current = true;
      return;
    }
    const timeout = window.setTimeout(() => {
      scopedDraftChangeRef.current?.(latestDraftValueRef.current);
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [body, drafts, focusKey, variant]);

  useEffect(() => {
    return () => {
      flushDraft();
      drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushDraft]);

  useEffect(() => {
    if (variant !== 'composer') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        flushDraft();
        return;
      }
      // Anything else is a wake — browsers only report hidden/visible here.
      // A composer waking from a LONG sleep (suspended tab, pocketed phone)
      // defers to the server: whatever it was showing may have been edited,
      // sent, or cleared elsewhere days ago, so its "the user edited this"
      // claim has expired — let the mirror effect re-apply the server truth
      // (its content was already flushed at hide-time). Short blurs
      // (alt-tab) keep the claim so live typing is never clobbered by a
      // stale refetch racing the hide-flush.
      if (hiddenAtRef.current !== 0 && Date.now() - hiddenAtRef.current >= WAKE_DEFERS_TO_SERVER_MS) {
        locallyEditedDraftRef.current = false;
      }
      hiddenAtRef.current = 0;
    };
    const handleWindowBlur = () => flushDraft();
    // The page is being torn down: the flush must ride a keepalive fetch or
    // it dies with the tab.
    const handlePageHide = () => flushDraft({ keepalive: true });
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushDraft, variant]);

  // The editor's onChange: a change the mirror didn't apply is the user
  // taking over the buffer, which blocks further server rehydration.
  const handleEditorChange = (md: string) => {
    if (!applyingServerDraftRef.current && md !== body) {
      locallyEditedDraftRef.current = true;
    }
    latestDraftValueRef.current = {
      body: md,
      attachmentIDs: drafts.map((d) => d.id),
    };
    setBody(md);
  };

  // Adding or removing a chip is an edit too.
  const markLocallyEdited = useCallback(() => {
    locallyEditedDraftRef.current = true;
  }, []);

  // clearDraft empties the buffer once its message has gone (sent or
  // scheduled) — the chips' files now belong to that message, so they are
  // released locally, never deleted.
  const clearDraft = useCallback(() => {
    drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    // The local-edit claim blocks the mirror from rehydrating the just-sent
    // server draft props while the send's cache patch catches up.
    locallyEditedDraftRef.current = true;
    setBody('');
    setDrafts([]);
    editorRef.current?.setMarkdown('');
  }, [drafts, editorRef]);

  return { body, drafts, setDrafts, handleEditorChange, markLocallyEdited, clearDraft };
}
