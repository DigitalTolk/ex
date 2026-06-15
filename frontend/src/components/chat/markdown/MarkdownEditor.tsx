import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Strikethrough, Autolink } from '@lezer/markdown';
import type { WysiwygEditorHandle, ActiveFormat } from './types';
import { composerTheme, composerHighlight } from './theme';
import { inlinePreview } from './extensions/inlinePreview';
import { mentionPills } from './extensions/mentionPills';
import { emojiGlyphs } from './extensions/emojiGlyphs';
import { composerAutocomplete, type CompletionProviders } from './extensions/completions';
import { applyMark, applyBlock, getActiveFormats } from './extensions/commands';

export type { WysiwygEditorHandle, ActiveFormat };

const EMPTY_SET: Set<string> = new Set();

// Base sizing/typography on the contenteditable (the scroll box), matching the
// old composer. `editorClassName` is appended reactively via a compartment.
const BASE_CONTENT_CLASS =
  'min-h-[60px] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words text-base focus:outline-none md:max-h-[31.25rem] md:text-sm';

function contentClassExtension(editorClassName: string) {
  return EditorView.contentAttributes.of({ class: `${BASE_CONTENT_CLASS} ${editorClassName}`.trim() });
}

// Toggle the placeholder overlay imperatively (not via React state) so the
// CodeMirror update listener — which fires outside React's act() — never
// triggers a state update that would warn in tests or churn renders.
function setOverlayVisible(el: HTMLDivElement | null, visible: boolean) {
  /* istanbul ignore next -- el is null only before the overlay mounts, which never coincides with a doc update; defensive guard. */
  if (el) el.style.display = visible ? '' : 'none';
}

// Default sources when no completionProviders prop is supplied (isolated tests,
// read-only previews): every source yields nothing, so no popup appears.
const EMPTY_PROVIDERS: CompletionProviders = {
  users: () => [],
  online: () => EMPTY_SET,
  memberIds: () => null,
  channels: () => [],
  customEmojis: () => [],
  skinTone: () => '',
};

interface Props {
  initialBody?: string;
  onChange?: (markdown: string) => void;
  onSubmit?: (markdown: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  editorClassName?: string;
  onFocusChange?: (focused: boolean) => void;
  onPasteFiles?: (files: File[]) => void;
  submitOnEnter?: boolean;
  onArrowUpEmpty?: () => boolean;
  mentionChannelId?: string;
  // Live data sources for @-mention / ~-channel / :emoji: autocomplete. Read
  // through a ref so the editor is still built once; absent → the sources
  // return nothing (no popup), which is the case in isolated tests.
  completionProviders?: CompletionProviders;
  // Live name→URL lookup for custom (workspace) emoji, so `:custom:` shortcodes
  // render as their image in the composer (matching the message renderer).
  customEmojiMap?: () => Record<string, string>;
}

// Remove SetextHeading so `foobar\n---` is a paragraph followed by a thematic
// break (a divider), not an H2 — matching the Slack-style mental model that a
// line of `---` is a horizontal rule. Without this, the heading highlight would
// render the preceding line bold. Keep GFM strikethrough + autolink.
const markdownLanguage = markdown({ extensions: [Strikethrough, Autolink, { remove: ['SetextHeading'] }] });

export const MarkdownEditor = forwardRef<WysiwygEditorHandle, Props>(function MarkdownEditor(
  {
    initialBody = '',
    onChange,
    onSubmit,
    onCancel,
    placeholder,
    ariaLabel = 'Message input',
    className = '',
    editorClassName = '',
    onFocusChange,
    onPasteFiles,
    submitOnEnter = true,
    onArrowUpEmpty,
    completionProviders,
    customEmojiMap,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Placeholder is rendered as an overlay (not inside the contenteditable) so it
  // never leaks into the editor's textContent — matching the old composer. Its
  // visibility is toggled imperatively via overlayRef (see setOverlayVisible).
  const overlayRef = useRef<HTMLDivElement>(null);
  // Latest callbacks, read through refs so the editor is built exactly once and
  // never torn down on a parent re-render (which would drop focus/selection).
  const cbRef = useRef({ onChange, onSubmit, onCancel, onFocusChange, onPasteFiles, submitOnEnter, onArrowUpEmpty, completionProviders, customEmojiMap });
  cbRef.current = { onChange, onSubmit, onCancel, onFocusChange, onPasteFiles, submitOnEnter, onArrowUpEmpty, completionProviders, customEmojiMap };
  const formatSubsRef = useRef(new Set<(active: Set<ActiveFormat>) => void>());
  const linkSelRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });
  // Compartment so the (dynamic) editorClassName can be reconfigured on the
  // contenteditable after mount — the compact mobile composer toggles it.
  const classCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    const host = hostRef.current;
    /* istanbul ignore next -- hostRef is attached to the rendered container, so it is always present when the mount effect runs; defensive guard. */
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialBody,
        extensions: [
          history(),
          markdownLanguage,
          composerHighlight,
          inlinePreview,
          mentionPills,
          emojiGlyphs((name) => (cbRef.current.customEmojiMap?.() ?? {})[name]),
          composerAutocomplete({
            users: () => (cbRef.current.completionProviders ?? EMPTY_PROVIDERS).users(),
            online: () => (cbRef.current.completionProviders ?? EMPTY_PROVIDERS).online(),
            memberIds: () => (cbRef.current.completionProviders ?? EMPTY_PROVIDERS).memberIds(),
            channels: () => (cbRef.current.completionProviders ?? EMPTY_PROVIDERS).channels(),
            customEmojis: () => (cbRef.current.completionProviders ?? EMPTY_PROVIDERS).customEmojis(),
            skinTone: () => (cbRef.current.completionProviders ?? EMPTY_PROVIDERS).skinTone(),
          }),
          composerTheme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            role: 'textbox',
            'aria-multiline': 'true',
            // Mobile keyboard hints: a "send" return key when Enter submits, plus
            // sentence capitalisation / autocorrect / spellcheck for prose.
            enterkeyhint: submitOnEnter ? 'send' : 'enter',
            autocapitalize: 'sentences',
            autocorrect: 'on',
            spellcheck: 'true',
          }),
          // Sizing/typography + dynamic editorClassName on the contenteditable
          // (the scroll box), matching the old composer. CM merges the `class`
          // attribute with `cm-content`. Reconfigured below when it changes.
          classCompartment.of(contentClassExtension(editorClassName)),
          keymap.of([
            {
              key: 'Enter',
              run: (v) => {
                if (!cbRef.current.submitOnEnter) return false;
                cbRef.current.onSubmit?.(v.state.doc.toString());
                return true;
              },
              shift: () => false, // Shift+Enter falls through to insert a newline.
            },
            {
              key: 'ArrowUp',
              run: (v) => {
                if (v.state.doc.length !== 0) return false;
                return cbRef.current.onArrowUpEmpty?.() ?? false;
              },
            },
            {
              key: 'Escape',
              run: () => {
                if (!cbRef.current.onCancel) return false;
                cbRef.current.onCancel();
                return true;
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.domEventHandlers({
            paste: (event) => {
              const dt = event.clipboardData;
              if (!dt) return false;
              // Collect files from both `files` (copied files) and `items`
              // (clipboard images arrive as a `kind:'file'` item) — matching
              // the old paste plugin so screenshots paste as attachments.
              const files = Array.from(dt.files);
              if (files.length === 0) {
                for (const item of Array.from(dt.items)) {
                  if (item.kind === 'file') {
                    const f = item.getAsFile();
                    if (f) files.push(f);
                  }
                }
              }
              if (files.length > 0 && cbRef.current.onPasteFiles) {
                event.preventDefault();
                cbRef.current.onPasteFiles(files);
                return true;
              }
              return false;
            },
            // Track focus via DOM events on the contenteditable (matching the
            // old composer's onFocus/onBlur props) so callers — and synthetic
            // focus events in tests — see focus changes. Return false so CM
            // still processes the event normally.
            focus: () => {
              cbRef.current.onFocusChange?.(true);
              return false;
            },
            blur: () => {
              cbRef.current.onFocusChange?.(false);
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              cbRef.current.onChange?.(text);
              setOverlayVisible(overlayRef.current, text.trim() === '');
            }
            if (u.docChanged || u.selectionSet) {
              const active = getActiveFormats(u.view);
              for (const cb of formatSubsRef.current) cb(active);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once. Subsequent prop changes are driven through the imperative
    // handle (setMarkdown etc.), so we intentionally do not re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure the contenteditable's class when editorClassName changes (the
  // compact mobile composer toggles it after mount).
  useEffect(() => {
    const v = viewRef.current;
    /* istanbul ignore next -- the view always exists once this effect runs (mount effect created it synchronously above); defensive guard. */
    if (!v) return;
    v.dispatch({ effects: classCompartment.reconfigure(contentClassExtension(editorClassName)) });
  }, [editorClassName, classCompartment]);

  // Every handle method needs the live EditorView, which only exists after the
  // mount effect ran — and the handle is only reachable by the parent after
  // mount, so the view is always present. `withView` centralises that single
  // unreachable null-guard instead of repeating it (and an ignore) per method.
  const withView = <T,>(fn: (v: EditorView) => T, fallback: T): T => {
    const v = viewRef.current;
    /* istanbul ignore next -- the imperative handle is only reachable after the mount effect created the view, so the null fallback is unreachable defensive code. */
    return v ? fn(v) : fallback;
  };

  useImperativeHandle(ref, (): WysiwygEditorHandle => ({
    applyMark: (mark) => withView((v) => { applyMark(v, mark); v.focus(); }, undefined),
    applyBlock: (block) => withView((v) => { applyBlock(v, block); v.focus(); }, undefined),
    beginLinkEdit: () => withView((v) => {
      const sel = v.state.selection.main;
      linkSelRef.current = { from: sel.from, to: sel.to };
      return { selectedText: v.state.sliceDoc(sel.from, sel.to) };
    }, { selectedText: '' }),
    commitLinkEdit: (url, displayText) => withView((v) => {
      const { from, to } = linkSelRef.current;
      const text = displayText || v.state.sliceDoc(from, to) || url;
      const insert = `[${text}](${url})`;
      v.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) });
      v.focus();
    }, undefined),
    insertText: (text) => withView((v) => {
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
    }, undefined),
    getMarkdown: () => withView((v) => v.state.doc.toString(), ''),
    setMarkdown: (md) => withView((v) => {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: md } });
    }, undefined),
    focus: () => withView((v) => v.focus(), undefined),
    focusEnd: () => withView((v) => {
      v.focus();
      v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    }, undefined),
    blur: () => withView((v) => v.contentDOM.blur(), undefined),
    getElement: () => hostRef.current,
    getActiveFormats: () => withView((v) => getActiveFormats(v), new Set<ActiveFormat>()),
    subscribeActiveFormats: (cb) => {
      formatSubsRef.current.add(cb);
      return () => { formatSubsRef.current.delete(cb); };
    },
  }), []);

  return (
    <div className={`relative ${className}`}>
      <div ref={hostRef} data-markdown-editor />
      {placeholder && (
        // Overlay placeholder (outside the contenteditable) — mirrors the old
        // composer so the editor's textContent stays empty. `editorClassName`
        // is mirrored here so the compact mobile composer's `leading-9` keeps
        // the placeholder vertically centred against the round send button.
        // Visibility is toggled imperatively (setOverlayVisible); the initial
        // display reflects whether the seeded body is empty.
        <div
          ref={overlayRef}
          style={{ display: initialBody.trim() === '' ? undefined : 'none' }}
          className={`pointer-events-none absolute inset-0 flex items-start select-none text-base text-muted-foreground md:text-sm ${editorClassName}`}
        >
          <span className="truncate whitespace-nowrap">{placeholder}</span>
        </div>
      )}
    </div>
  );
});
