import { useState, useRef, useCallback, useImperativeHandle, useMemo, forwardRef, type ReactNode } from 'react';
import {
  Send,
  Paperclip,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Quote,
  List,
  ListOrdered,
  Link as LinkIcon,
  Smile,
  ImagePlay,
  X,
  Save,
  Loader2,
} from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmojiPicker } from '@/components/EmojiPicker';
import { GiphyPicker, type PickedGIF } from '@/components/GiphyPicker';
import { useWorkspaceSettings } from '@/hooks/useSettings';
import { useCommands, useRunCommand } from '@/hooks/useCommands';
import { AttachmentChip, type DraftAttachment } from '@/components/chat/AttachmentChip';
import { uploadAttachment, useDeleteDraftAttachment } from '@/hooks/useAttachments';
import { isImageAttachment } from '@/lib/file-helpers';
import { MarkdownComposer, type WysiwygEditorHandle, type ActiveFormat } from '@/components/chat/markdown/MarkdownComposer';
import { sendWS } from '@/lib/ws-sender';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY_CHARS,
  countCodepoints,
} from '@/lib/limits';
import { normalizeEmojiInBody } from '@/lib/emoji-shortcodes';
import { isHttpUrl } from '@/lib/utils';
import { dispatchEditMessage, onFocusComposer } from '@/lib/window-events';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ApiError } from '@/lib/api';

const TYPING_PING_INTERVAL_MS = 3000;

// commandDenialMessage extracts a server-authored, user-facing denial from a
// failed slash-command run (the backend marks those with a structured error
// message, e.g. "guests can't start Teams meetings"). Anything else — network
// failures, generic 500s — returns null and the caller shows the retry text.
function commandDenialMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload as { error?: { message?: unknown } } | undefined;
  const message = payload?.error?.message;
  return typeof message === 'string' && message !== '' ? message : null;
}

// How long a composer must have been hidden before, on waking, it drops its
// "the user edited this" claim and defers to the server's draft state. Long
// enough that a quick alt-tab never clobbers live typing; short enough that a
// laptop reopened after a meeting shows the truth, not a stale buffer.
const WAKE_DEFERS_TO_SERVER_MS = 60_000;

export interface MessageInputValue {
  body: string;
  attachmentIDs: string[];
}

// Imperative API exposed via forwardRef so the surrounding chat view can
// route drag-and-dropped files through the same upload pipeline as the
// paperclip button.
export interface MessageInputHandle {
  uploadFiles: (files: File[]) => Promise<void>;
}

interface MessageInputProps {
  onSend: (value: MessageInputValue) => void;
  onCancel?: () => void;
  disabled?: boolean;
  placeholder?: string;
  initialBody?: string;
  initialDrafts?: DraftAttachment[];
  // `notify` distinguishes a focus-loss flush (true → surface the draft in
  // the sidebar) from a keystroke save (omitted/false → persist silently).
  // `keepalive` marks a teardown flush (pagehide): the save should ride a
  // keepalive fetch so it survives the page dying.
  onDraftChange?: (value: MessageInputValue, options?: { notify?: boolean; keepalive?: boolean }) => void;
  cancelOnOutsidePointer?: boolean;
  hideCodeButton?: boolean;
  submitLabel?: string;
  // When true, the input renders compactly without a top border (used by
  // inline edit mode inside MessageItem).
  variant?: 'composer' | 'inline';
  // When provided, the textarea is auto-focused whenever this value
  // changes — used to re-focus the composer after the user navigates to a
  // different channel/conversation/group without unmounting the component.
  focusKey?: string;
  // When set, the composer emits "typing" frames over the WebSocket
  // (throttled to once every 3s) so other clients can render a "<user>
  // is typing" indicator. Inline edit doesn't pass this — typing while
  // editing an existing message is private.
  typingParentID?: string;
  typingParentType?: 'channel' | 'conversation';
  // When the composer is the thread reply box, this is the root message
  // ID. Including it in the typing frame lets receivers route the
  // indicator into ThreadPanel rather than the main MessageList. Absent
  // for the main composer.
  typingThreadRootID?: string;
  // ID of the user's most recent message currently loaded in the
  // surrounding list. ArrowUp on an empty composer triggers an inline
  // edit on this message via the `ex:edit-message` window event;
  // omitted (or undefined) disables the shortcut.
  lastOwnMessageId?: string;
  // Whether this composer is docked at the bottom of the viewport (the
  // main channel/conversation composer). Only then should it reserve
  // home-indicator space via env(safe-area-inset-bottom). In-list
  // composers (e.g. the /threads ThreadCards) are mid-page, so that inset
  // just adds a dead ~34px gap below them — they pass false.
  bottomInset?: boolean;
  // Rendered inside the composer's padded wrapper, directly above the input
  // box — used for the "<user> is typing" indicator so it sits glued to the
  // input (the wrapper's top padding becomes the gap to the message list
  // above the indicator) instead of floating in that padding as an outside
  // sibling. Only the composer variant renders it.
  aboveInput?: ReactNode;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput({
  onSend,
  onCancel,
  disabled = false,
  placeholder = 'Type a message...',
  initialBody = '',
  initialDrafts = [],
  submitLabel,
  variant = 'composer',
  bottomInset = true,
  focusKey,
  typingParentID,
  typingParentType,
  typingThreadRootID,
  lastOwnMessageId,
  onDraftChange,
  cancelOnOutsidePointer,
  hideCodeButton,
  aboveInput,
}, ref) {
  const [body, setBody] = useState(initialBody);
  const [drafts, setDrafts] = useState<DraftAttachment[]>(initialDrafts);
  const [isUploading, setIsUploading] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [toolbarPickerOpen, setToolbarPickerOpen] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const editorRef = useRef<WysiwygEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingPingRef = useRef(0);
  const deleteDraft = useDeleteDraftAttachment();
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
  // Toolbar pressed-state tracking. Driven by Lexical's
  // registerUpdateListener so a toolbar click flips the pressed state
  // immediately — selectionchange only fires when the caret moves and
  // would lag behind format toggles by one keystroke.
  const [active, setActive] = useState<Set<ActiveFormat>>(new Set());
  useEffect(() => {
    return editorRef.current?.subscribeActiveFormats?.(setActive);
  }, []);
  const { data: settings } = useWorkspaceSettings();
  const isMobile = useIsMobile();
  // Slash commands run only from a main chat composer: an edit box rewrites an
  // existing message and a thread reply box targets a thread — neither is a
  // place to start a meeting from.
  const commandTarget = useMemo(
    () =>
      variant === 'composer' && submitLabel === undefined && onCancel === undefined &&
      typingThreadRootID === undefined && typingParentID && typingParentType
        ? { parentID: typingParentID, parentType: typingParentType }
        : undefined,
    [variant, submitLabel, onCancel, typingThreadRootID, typingParentID, typingParentType],
  );
  const { data: commands = [] } = useCommands(commandTarget !== undefined);
  const { mutate: runCommand } = useRunCommand();
  const [commandError, setCommandError] = useState('');
  // An external command's ephemeral reply — shown to this caller only.
  const [commandNotice, setCommandNotice] = useState('');
  // Name of the slash command currently executing server-side. Commands like
  // /mstmeetings take a few seconds (a Graph round-trip) before their result
  // message lands over the WebSocket — this drives a "Running /x…" status so
  // the composer never looks like it swallowed the command.
  const [pendingCommand, setPendingCommand] = useState('');
  const slashCommandsProvider = useCallback(() => commands, [commands]);
  /* istanbul ignore next -- the `?? ''` fallback only applies when settings.giphyAPIKey is undefined, but the settings object always carries the field; defensive. */
  const giphyAPIKey = settings?.giphyAPIKey?.trim() ?? '';
  /* istanbul ignore next -- the `?? false` fallback only applies when settings.giphyEnabled is undefined, but the settings object always carries the flag; defensive. */
  const giphyEnabled = (settings?.giphyEnabled ?? false) && giphyAPIKey !== '';
  const isEditingMode = submitLabel !== undefined || onCancel !== undefined;

  const hasInitialDraftValue = initialBody !== '' || initialDrafts.length > 0;
  const suppressAutoFocus = isMobile && variant === 'composer';
  const hasComposerContent = body.trim() !== '' || drafts.length > 0;
  const compactMobileComposer =
    variant === 'composer' && !editorFocused && !hasComposerContent;
  const showToolbar =
    variant !== 'composer' ||
    !isMobile ||
    editorFocused ||
    toolbarPickerOpen ||
    isEditingMode ||
    hasComposerContent;
  const showToolbarSend = showToolbar && !isEditingMode && (!isMobile || variant === 'composer');

  useEffect(() => {
    // No client timestamp rides along anymore: the server orders saves vs
    // sends by generation tokens, so a delayed flush can never out-rank a
    // later clear no matter what clock it carries.
    latestDraftValueRef.current = { body, attachmentIDs: drafts.map((d) => d.id) };
  }, [body, drafts]);

  useEffect(() => {
    if (!cancelOnOutsidePointer || !isMobile || !isEditingMode || !onCancel) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      /* istanbul ignore next -- the pointerdown listener is only attached while the composer is mounted, so rootRef.current is always present; defensive. */
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onCancel();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [cancelOnOutsidePointer, isMobile, isEditingMode, onCancel]);

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

  // Link dialog state. Opening the dialog calls editor.beginLinkEdit
  // which captures the current selection (Lexical loses selection when
  // focus moves to the modal), so the eventual commit can apply the
  // link to the right text.
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const openLinkDialog = useCallback(() => {
    /* istanbul ignore next -- editorRef is wired to the mounted WysiwygEditor before the toolbar's Link button can be clicked, so beginLinkEdit is always defined; the `?? { selectedText: '' }` fallback is defensive. */
    const { selectedText } = editorRef.current?.beginLinkEdit?.() ?? { selectedText: '' };
    setLinkText(selectedText);
    setLinkUrl('');
    setLinkDialogOpen(true);
  }, []);
  const submitLinkDialog = useCallback(() => {
    const url = linkUrl.trim();
    // isHttpUrl is the same gate PasteLinkPlugin uses — blocks
    // javascript:/data:/vbscript: schemes regardless of what the
    // browser's <input type="url"> accepts.
    if (!isHttpUrl(url)) return;
    const text = linkText.trim() || url;
    editorRef.current?.commitLinkEdit?.(url, text);
    setLinkDialogOpen(false);
    queueMicrotask(() => editorRef.current?.focus());
  }, [linkUrl, linkText]);

  // Throttled typing emit. Other clients show "<user> is typing" for 5s
  // after the most recent ping; we re-ping every 3s while the user is
  // still composing. We deliberately don't ping on every keystroke —
  // that would flood the WebSocket on long messages.
  const emitTyping = useCallback(() => {
    if (!typingParentID || !typingParentType) return;
    const now = Date.now();
    if (now - lastTypingPingRef.current < TYPING_PING_INTERVAL_MS) return;
    lastTypingPingRef.current = now;
    const frame: Record<string, string> = {
      type: 'typing',
      parentID: typingParentID,
      parentType: typingParentType,
    };
    if (typingThreadRootID) frame.parentMessageID = typingThreadRootID;
    sendWS(frame);
  }, [typingParentID, typingParentType, typingThreadRootID]);

  // ArrowUp in an empty composer asks the surrounding list to put the
  // user's most recent loaded message into edit mode (Slack/iMessage
  // parity). Disabled when there's no candidate or when the composer
  // is itself an inline edit (initialBody non-empty).
  const requestEditLast = useCallback((): boolean => {
    if (!lastOwnMessageId || initialBody) return false;
    dispatchEditMessage({ messageId: lastOwnMessageId });
    return true;
  }, [lastOwnMessageId, initialBody]);

  // Codepoint cap mirrors the backend rule: the user pastes "🚀🚀🚀…",
  // each emoji is one user-visible char, and we count it as one — not
  // as four bytes or two UTF-16 units.
  const bodyCodepoints = countCodepoints(body);
  const bodyOverLimit = bodyCodepoints > MAX_MESSAGE_BODY_CHARS;
  const attachmentsOverLimit = drafts.length > MAX_ATTACHMENTS_PER_MESSAGE;

  const canSend =
    (body.trim() !== '' || drafts.length > 0) &&
    !disabled &&
    !isUploading &&
    !bodyOverLimit &&
    !attachmentsOverLimit;

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
  }, []);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const trimmed = body.trim();
    // A message that is exactly a registered slash command (no attachments)
    // executes instead of posting; anything else — including unknown
    // "/words" — sends as a normal message.
    // A registered slash command executes instead of posting. Anything after the
    // trigger word is the command's arguments — external commands take them, so
    // "/deploy web v2" must run rather than post as a message.
    const invocation = (() => {
      if (!commandTarget || drafts.length > 0) return null;
      const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const name = match?.[1]?.toLowerCase();
      if (!name || !commands.some((c) => c.name === name)) return null;
      return { name, text: (match?.[2] ?? '').trim() };
    })();
    // While a command is in flight, swallow a re-submitted command (double
    // Enter must not start two meetings) — the status line is already up.
    // Normal messages still send.
    if (invocation && pendingCommand) return;
    setCommandError('');
    setCommandNotice('');
    if (invocation) {
      setPendingCommand(invocation.name);
      runCommand(
        {
          command: invocation.name,
          parentType: commandTarget!.parentType,
          parentID: commandTarget!.parentID,
          text: invocation.text,
        },
        {
          onSuccess: (res) => {
            // An ephemeral reply is for this caller alone — there's no message to
            // fan out, so the composer's own notice area is where it belongs.
            if (res?.ephemeral_text) setCommandNotice(res.ephemeral_text);
            if (res?.goto_location) window.open(res.goto_location, '_blank', 'noopener,noreferrer');
          },
          onSettled: () => setPendingCommand(''),
          onError: (err) =>
            setCommandError(
              commandDenialMessage(err) ?? `Couldn't run /${invocation.name} — please try again.`,
            ),
        },
      );
    } else {
      onSend({ body: normalizeEmojiInBody(trimmed), attachmentIDs: drafts.map((d) => d.id) });
    }
    if (variant === 'inline') return; // parent unmounts the inline edit
    drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    // The local-edit claim blocks the mirror from rehydrating the just-sent
    // server draft props while the send's cache patch catches up.
    locallyEditedDraftRef.current = true;
    setBody('');
    setDrafts([]);
    editorRef.current?.setMarkdown('');
    if (isMobile || submitLabel) {
      collapseMobileComposer();
      return;
    }
    queueMicrotask(() => editorRef.current?.focus());
  }, [canSend, body, drafts, onSend, variant, isMobile, submitLabel, collapseMobileComposer, commandTarget, commands, runCommand, pendingCommand]);

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
  }, [initialBody, initialDrafts, body, drafts, focusKey, variant, suppressAutoFocus]);

  useEffect(() => {
    if (!scopedDraftChangeRef.current || variant !== 'composer') return;
    if (!mountedDraftChangeRef.current) {
      mountedDraftChangeRef.current = true;
      return;
    }
    const timeout = window.setTimeout(() => {
      scopedDraftChangeRef.current?.(latestDraftValueRef.current);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [body, drafts, focusKey, variant]);

  useEffect(() => {
    return () => {
      flushDraft();
      drafts.forEach((d) => d.localURL && URL.revokeObjectURL(d.localURL));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushDraft]);

  // Track focus state in a ref so visibility-change snapshot logic
  // survives effect re-runs without re-binding listeners.
  const editorFocusedRef = useRef(false);
  useEffect(() => {
    editorFocusedRef.current = editorFocused;
  }, [editorFocused]);
  const wasFocusedOnHideRef = useRef(false);
  const hiddenAtRef = useRef(0);

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
      if (wasFocusedOnHideRef.current) {
        wasFocusedOnHideRef.current = false;
        queueMicrotask(() => editorRef.current?.focus());
      }
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

  useEffect(() => {
    if (focusKey === undefined) return;
    if (suppressAutoFocus) return;
    queueMicrotask(() => {
      editorRef.current?.focus();
    });
  }, [focusKey, suppressAutoFocus]);

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
  }, [typingParentID, typingThreadRootID]);

  function insertEmojiShortcode(emoji: string) {
    editorRef.current?.insertText(emoji + ' ');
    // Refocus synchronously, inside the pick tap's gesture, so iOS reopens
    // the keyboard. A deferred focus (rAF/microtask) loses the user-gesture
    // context and the keyboard stays closed.
    editorRef.current?.focus();
  }

  function insertGiphyGIF(gif: PickedGIF) {
    // Store only GIPHY's stable content ID plus dimensions for layout.
    // Media URLs are resolved directly from GIPHY at render time so
    // saved messages don't cache returned media URLs.
    /* istanbul ignore next -- insertGiphyGIF is only invoked by the GiphyPicker's onSelect; exercising the width/height ternary arms requires the full GIPHY-fetch picker integration (covered in GiphyPicker.browser.test), not reachable from MessageInput's own tests. */
    const dims = gif.width && gif.height ? ` =${gif.width}x${gif.height}` : '';
    editorRef.current?.insertText(`![GIPHY](giphy:${gif.id}${dims}) `);
    // Synchronous refocus (inside the pick gesture) reopens the iOS keyboard.
    editorRef.current?.focus();
  }

  function handleToolbarPickerOpenChange(open: boolean) {
    setToolbarPickerOpen(open);
    /* istanbul ignore next -- the desktop early-return is only reached by opening the toolbar EmojiPicker on desktop, which synchronously trips an unrelated React setState-in-render warning in EmojiPicker that the console-gate rejects; the mobile path (the meaningful blur/refocus logic) is covered. */
    if (!isMobile) return;
    if (open) {
      editorRef.current?.blur();
      return;
    }
    // Synchronous refocus, like the insert paths above: a deferred focus
    // (rAF/microtask) loses the dismiss tap's user-gesture context and the
    // iOS keyboard stays closed.
    editorRef.current?.focus();
  }

  async function uploadFiles(allFiles: File[]) {
    if (allFiles.length === 0) return;
    // Trim to the per-message cap before uploading. Surface a friendly
    // warning if the user tried to attach more — better UX than letting
    // the upload finish and then 400-ing on send.
    const remaining = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - drafts.length);
    const files = allFiles.slice(0, remaining);
    if (allFiles.length > remaining) {
      setUploadError(
        `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message. Skipped ${
          allFiles.length - remaining
        }.`,
      );
    } else {
      setUploadError('');
    }
    if (files.length === 0) return;
    setIsUploading(true);
    locallyEditedDraftRef.current = true;

    // Render a chip for every selected file *before* any network I/O so
    // the user sees N progress bars immediately instead of one-at-a-time
    // as each file's SHA / presign call resolves. We track the chip by a
    // local placeholder id, then swap to the server id when init returns.
    const tempIDs = files.map((_, i) => `pending-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`);
    setDrafts((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: tempIDs[i],
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        localURL: isImageAttachment(file.type, file.name) ? URL.createObjectURL(file) : undefined,
        progress: 0,
      })),
    ]);

    // Concurrency-capped pool. Promise.all would dispatch all uploads at
    // once; cap at 4 so we stay polite to the upload endpoint and don't
    // saturate upstream bandwidth on bulk drops. Per-file failures are
    // captured (allSettled-style) so one bad file doesn't abort siblings.
    const POOL = 4;
    const errors: string[] = [];
    let cursor = 0;
    const runOne = async (idx: number) => {
      const file = files[idx];
      const tempID = tempIDs[idx];
      // currentID flips from the temp id to the server-issued id once
      // init resolves. Progress callbacks use this so they can find the
      // chip whether or not the swap has happened yet.
      let currentID = tempID;
      try {
        await uploadAttachment(file, {
          onInit: (init) => {
            // Swap the temp id for the real one. If the server already
            // had the bytes (alreadyExists), progress jumps to 1.
            currentID = init.id;
            setDrafts((prev) =>
              prev.map((d) => {
                if (d.id !== tempID) return d;
                /* istanbul ignore next -- the optimistic chip always seeds progress: 0, so `d.progress` is defined here; the `?? 0` fallback is defensive. */
                const existingProgress = d.progress ?? 0;
                return {
                  ...d,
                  id: init.id,
                  filename: init.filename,
                  contentType: init.contentType,
                  size: init.size,
                  progress: init.alreadyExists ? 1 : existingProgress,
                };
              }),
            );
          },
          onProgress: (fraction) => {
            // Match by the live id — temp before init, server-issued after.
            setDrafts((prev) =>
              prev.map((d) => (d.id === currentID ? { ...d, progress: fraction } : d)),
            );
          },
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Upload failed');
        // Drop the failed chip — keep siblings intact. Match by the
        // current id, which may be the temp id (init never resolved)
        // or the server id (init succeeded but the PUT failed).
        setDrafts((prev) => {
          const target = prev.find((d) => d.id === currentID);
          if (target?.localURL) URL.revokeObjectURL(target.localURL);
          return prev.filter((d) => d.id !== currentID);
        });
      }
    };
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= files.length) return;
        await runOne(i);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker));
      if (errors.length > 0) {
        setUploadError(errors.length === 1 ? errors[0] : `${errors.length} uploads failed: ${errors[0]}`);
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    /* istanbul ignore next -- a file <input> change always carries a FileList (possibly empty), never null, so the `?? []` fallback is defensive. */
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await uploadFiles(files);
  }

  useImperativeHandle(ref, () => ({ uploadFiles }));

  async function removeDraft(id: string) {
    const target = drafts.find((d) => d.id === id);
    if (target?.localURL) URL.revokeObjectURL(target.localURL);
    locallyEditedDraftRef.current = true;
    setDrafts((d) => d.filter((x) => x.id !== id));
    try {
      await deleteDraft.mutateAsync(id);
    } catch (err) {
      // 409 Conflict is the only "expected" failure: the SHA is still
      // referenced by another message that deduped against this
      // attachment. The chip is gone from the local draft anyway, so
      // the user-visible outcome is correct — swallow it.
      // Anything else (network failure, 5xx, 401) is a real problem
      // the user should see, not silently lose. Surface it via the
      // same upload-error rail that handles failed uploads.
      if (err instanceof ApiError && err.status === 409) return;
      /* istanbul ignore next -- deleteDraft.mutateAsync rejects with Error instances (ApiError/Error); a non-Error rejection is not reachable, so the 'Failed to remove attachment' fallback is defensive. */
      const message = err instanceof Error ? err.message : 'Failed to remove attachment';
      setUploadError(message);
    }
  }

  const renderToolbar = (placement: 'top' | 'bottom') => {
    // No divider between the message field and the formatting buttons — the
    // spec composer has the toolbar sit flush under the input, not separated
    // by an hr/border.
    return (
    <div
      className="flex items-center gap-0.5 overflow-x-auto px-2 py-1 [scrollbar-width:none]"
      role="toolbar"
      aria-label="Formatting"
      data-toolbar-placement={placement}
      onMouseDown={(event) => {
        /* istanbul ignore next -- the handler is bound to the toolbar element, so a mousedown that reaches it always has a target contained by currentTarget; the false arm is defensive. */
        if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
      }}
      onPointerDown={(event) => {
        /* istanbul ignore next -- as above, a pointerdown reaching the toolbar handler always has a contained target; the false arm is defensive. */
        if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
      }}
    >
      <ToolbarBtn label="Bold (Ctrl+B)" active={active.has('bold')} onClick={() => editorRef.current?.applyMark('bold')}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
      <ToolbarBtn label="Italic (Ctrl+I)" active={active.has('italic')} onClick={() => editorRef.current?.applyMark('italic')}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
      <ToolbarBtn label="Strikethrough" active={active.has('strike')} onClick={() => editorRef.current?.applyMark('strike')}><Strikethrough className="h-3.5 w-3.5" /></ToolbarBtn>
      {!isEditingMode && !hideCodeButton && (
        <ToolbarBtn label="Code (Ctrl+E)" active={active.has('code')} onClick={() => editorRef.current?.applyMark('code')}><Code className="h-3.5 w-3.5" /></ToolbarBtn>
      )}
      {!isMobile && (
        <>
          <ToolbarBtn label="Quote" active={active.has('quote')} onClick={() => editorRef.current?.applyBlock('quote')}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="List" active={active.has('ul')} onClick={() => editorRef.current?.applyBlock('ul')}><List className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn label="Numbered list" active={active.has('ol')} onClick={() => editorRef.current?.applyBlock('ol')}><ListOrdered className="h-3.5 w-3.5" /></ToolbarBtn>
        </>
      )}
      {/* DELIBERATELY desktop-only (like Quote/lists above): the mobile
          toolbar has very little width and Link was judged the least
          important formatting control there (Mobile fixes (7), #95). Do not
          re-add it on mobile — [text](url) remains typeable. */}
      {!isMobile && (
        <ToolbarBtn label="Link" onClick={openLinkDialog}><LinkIcon className="h-3.5 w-3.5" /></ToolbarBtn>
      )}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <EmojiPicker
        onSelect={insertEmojiShortcode}
        mode="shortcode"
        onOpenChange={handleToolbarPickerOpenChange}
        trigger={
          <ToolbarBtn label="Emoji"><Smile className="h-3.5 w-3.5" /></ToolbarBtn>
        }
      />
      {giphyEnabled && (
        <GiphyPicker
          apiKey={giphyAPIKey}
          onSelect={insertGiphyGIF}
          onOpenChange={handleToolbarPickerOpenChange}
          trigger={
            <ToolbarBtn label="GIF"><ImagePlay className="h-3.5 w-3.5" /></ToolbarBtn>
          }
        />
      )}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 mobile:h-9 mobile:w-9"
        aria-label="Attach file"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </button>
      {showToolbarSend && (
        <>
          <span className="ml-auto" aria-hidden />
          <Button
            onClick={handleSend}
            disabled={!canSend}
            size="icon"
            className="h-7 w-7 rounded-md bg-foreground text-background hover:bg-foreground/85 dark:bg-brand dark:text-brand-foreground dark:hover:bg-brand-hover dark:disabled:bg-brand-disabled dark:disabled:text-brand-foreground mobile:h-9 mobile:w-9 mobile:rounded-full"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </>
      )}
      {isEditingMode && (
        <>
          <span className="ml-auto" aria-hidden />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          {onCancel && (
            <Button
              onClick={onCancel}
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md mobile:h-9 mobile:w-9"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          <Button
            onClick={handleSend}
            disabled={!canSend}
            size="icon"
            className="h-7 w-7 rounded-md bg-foreground text-background hover:bg-foreground/85 dark:bg-brand dark:text-brand-foreground dark:hover:bg-brand-hover mobile:h-9 mobile:w-9 mobile:rounded-full"
            aria-label={submitLabel ?? 'Send message'}
          >
            <Save className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={
        variant === 'inline'
          ? 'p-0'
          : `relative bg-background p-3 mobile:pt-1.5 ${
              // env(safe-area-inset-bottom) on iOS does not reset to 0 when
              // the keyboard is up, leaving a wasted ~34px gap between the
              // composer and the keyboard. Drop the inset while focused
              // (keyboard up) and only reserve the home-indicator space
              // when the composer is idle.
              editorFocused || !bottomInset
                ? 'mobile:pb-1'
                : 'mobile:pb-[max(0.25rem,env(safe-area-inset-bottom))]'
            } ${compactMobileComposer && !editorFocused ? 'mobile:px-4' : 'mobile:px-2'}`
      }
      data-composer-focused={editorFocused ? 'true' : 'false'}
    >
      {uploadError && (
        <div className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          {uploadError}
        </div>
      )}
      {commandError && (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
          data-testid="command-error"
        >
          {commandError}
        </div>
      )}
      {pendingCommand && (
        <div
          className="mb-2 flex items-center gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"
          role="status"
          data-testid="command-pending"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Running /{pendingCommand}…
        </div>
      )}
      {/* A command's ephemeral reply: information, not a failure, so it is styled
          as a notice and announced politely rather than as an alert. */}
      {commandNotice && (
        <div
          className="mb-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"
          role="status"
          data-testid="command-notice"
        >
          {commandNotice}
        </div>
      )}
      {bodyOverLimit && (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
          data-testid="message-body-too-long"
        >
          Message is {bodyCodepoints}/{MAX_MESSAGE_BODY_CHARS} characters. Trim it down to send.
        </div>
      )}
      {attachmentsOverLimit && (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
          data-testid="message-attachments-too-many"
        >
          Up to {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message — remove a few to send.
        </div>
      )}
      {/* `relative` wrapper anchors the typing-indicator overlay to the
          composer BOX, not the padded root. Anchoring to the root made
          `bottom-full` sit at the root's top edge — a full `p-3` (12px)
          above the composer box, which read as a ~10px floating gap. This
          wrapper hugs the box so the overlay sits directly on top of it. */}
      <div className="relative">
        {variant === 'composer' && aboveInput && (
          // Overlay, not normal flow: floats in the free space just above the
          // composer (`bottom-full` = bottom edge sits on this wrapper's — and
          // therefore the box's — top edge) so showing / hiding the "<user> is
          // typing" line never pushes the input box or changes the composer's
          // height. pointer-events-none so it can't intercept clicks on the
          // message underneath.
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full"
            data-testid="composer-above-input-overlay"
          >
            {aboveInput}
          </div>
        )}
        <div className="rounded-2xl border md:border-2 border-border bg-typing-field mobile:overflow-hidden mobile:rounded-[1.75rem]" data-message-composer>
        {drafts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b p-2" aria-label="Draft attachments">
            {drafts.map((d) => (
              <AttachmentChip key={d.id} att={d} onRemove={() => removeDraft(d.id)} />
            ))}
          </div>
        )}

        <div
          className={`flex gap-2 px-3 py-2 ${
            compactMobileComposer
              // Compact mobile composer (idle): row sized to match
              // the 36px send button so the input text vertically
              // centres against the button. `pl-4 pr-1.5` pulls the
              // send chip close to the rounded edge — `px-3` left a
              // noticeable gap that read as misalignment. Vertical
              // padding stays at `py-0.5` (2px) so the total height
              // (36 + 4 = 40px) fits inside the iPhone-composer
              // ≤42px contract the browser test locks down.
              ? 'items-center mobile:py-0.5 mobile:pl-4 mobile:pr-1.5'
              : 'items-end mobile:pt-3'
          }`}
        >
          <MarkdownComposer
            ref={editorRef}
            initialBody={initialBody}
            onChange={(md) => {
              if (!applyingServerDraftRef.current && md !== body) {
                locallyEditedDraftRef.current = true;
              }
              latestDraftValueRef.current = {
                body: md,
                attachmentIDs: drafts.map((d) => d.id),
              };
              setBody(md);
              emitTyping();
            }}
            onSubmit={handleSend}
            onCancel={onCancel}
            submitOnEnter={!isMobile}
            onPasteFiles={uploadFiles}
            onArrowUpEmpty={requestEditLast}
            placeholder={isUploading ? 'Uploading…' : placeholder}
            ariaLabel="Message input"
            // Enables member / special / not-in-channel grouping in the
            // @-mention typeahead. Only a channel composer has a channel
            // roster; DMs (and the typing-less edit box) pass nothing.
            mentionChannelId={typingParentType === 'channel' ? typingParentID : undefined}
            slashCommands={commandTarget ? slashCommandsProvider : undefined}
            className="flex-1"
            editorClassName={
              compactMobileComposer
                // Match the editor height to the row (36px) and use
                // `leading-9` (36px) so the single line of text /
                // placeholder vertically centers against the round
                // send button on the right.
                ? 'mobile:!min-h-9 mobile:!max-h-9 mobile:overflow-hidden mobile:leading-9'
                : ''
            }
            onFocusChange={isMobile && variant === 'composer' ? setEditorFocused : undefined}
          />
          {!isEditingMode && !showToolbarSend && (() => {
            /* istanbul ignore next -- this standalone send button only renders when showToolbarSend is false, which on mobile coincides with the compact idle composer, so compactMobileComposer is always true here; the non-compact size arm is unreachable. */
            const sendSize = compactMobileComposer ? 'mobile:h-9 mobile:w-9' : 'mobile:h-11 mobile:w-11';
            return (
            <div className="flex shrink-0 self-end items-center gap-1">
              <Button
                onClick={handleSend}
                disabled={!canSend}
                size="icon"
                className={`h-8 w-8 rounded-md bg-foreground text-background hover:bg-foreground/85 dark:bg-brand dark:text-brand-foreground dark:hover:bg-brand-hover mobile:rounded-full ${sendSize}`}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            );
          })()}
        </div>
          {showToolbar && renderToolbar('bottom')}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileUpload}
        aria-label="File input"
      />
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        {/* Mobile: Cancel/Insert live in the top-right header — the URL field
            autofocuses, so a bottom footer sat behind the keyboard. */}
        <DialogContent
          aria-label="Insert link"
          mobileCloseLabel="Cancel"
          mobileAction={
            isMobile
              ? { label: 'Insert', onClick: submitLinkDialog, disabled: !isHttpUrl(linkUrl.trim()) }
              : undefined
          }
        >
          <DialogHeader>
            <DialogTitle>Insert link</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitLinkDialog();
            }}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-text">Text</Label>
              <Input
                id="link-text"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                placeholder="Link text"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-url">URL</Label>
              <Input
                id="link-url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://example.com"
                autoFocus
                required
                type="url"
              />
            </div>
            {!isMobile && (
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setLinkDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!isHttpUrl(linkUrl.trim())}>
                  Insert
                </Button>
              </DialogFooter>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function ToolbarBtn({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active ? 'true' : undefined}
      className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted mobile:h-9 mobile:w-9 mobile:shrink-0 ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  );
}
