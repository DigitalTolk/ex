import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// CodeMirror theme for the message composer. The editor's document IS the
// stored markdown — there is no second representation — so everything here is
// purely visual. Classes pull from the same Tailwind/shadcn design tokens the
// rest of the app uses (see index.css), matching the old Lexical theme so the
// composer looks identical after the swap.
export const composerTheme = EditorView.theme({
  '&': {
    color: 'var(--color-foreground)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    padding: '0',
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.375',
    caretColor: 'var(--color-foreground)',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  // The `.cm-content` element is the scroll container (it carries the
  // min/max-height utility classes, like the old contenteditable), so the
  // CM scroller itself must not introduce a second scroll box.
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.375', overflow: 'visible' },
  '.cm-placeholder': { color: 'var(--color-muted-foreground)' },
  // Inline code + fenced code share the muted-pill look of the renderer.
  '.cm-inlineCode': {
    borderRadius: '0.25rem',
    backgroundColor: 'var(--color-muted)',
    padding: '0.125rem 0.375rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.85em',
  },
  '.cm-codeblock': {
    backgroundColor: 'var(--color-muted)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.85em',
  },
  '.cm-quote': {
    color: 'var(--color-muted-foreground)',
    borderLeft: '2px solid color-mix(in srgb, var(--color-muted-foreground) 30%, transparent)',
    paddingLeft: '0.75rem',
  },
  // Mention/channel/group pills. Neutral `primary` token per the design rules
  // (NOT brand pink) — matches the @mention pill used elsewhere in the app.
  '.cm-mention-pill': {
    borderRadius: '0.25rem',
    padding: '0 0.25rem',
    backgroundColor: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
    color: 'var(--color-primary)',
    fontWeight: '500',
    whiteSpace: 'nowrap',
  },
  // Live-preview emoji glyph — matches the renderer's ~1.4em Slack-style sizing.
  '.cm-emoji-glyph': {
    fontSize: '1.2em',
    lineHeight: '1',
    verticalAlign: 'middle',
  },
});

// Token-level highlight (bold/italic/strike/link/headings) via Lezer tags. The
// inline-preview plugin also hides the delimiter characters; this colours/weights
// the content so it reads as rendered text while you type.
export const composerHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--color-link)' },
    { tag: tags.url, color: 'var(--color-link)' },
    { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4], fontWeight: '700' },
    { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  ]),
);
