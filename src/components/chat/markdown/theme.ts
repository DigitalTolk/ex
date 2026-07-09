import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  PRESENCE_DOT_DEFAULT_SIZE,
  presenceDotBorderWidth,
  presenceNotchStyle,
} from '@/lib/presence';

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
    // Line-height is set generously enough to fully contain an inline emoji
    // glyph/image (capped below at 1.2em) so the line height is identical whether
    // a line shows the rendered emoji or the raw `:shortcode:` — no vertical
    // jiggle as the caret moves in/out of an emoji token.
    lineHeight: '1.5',
    caretColor: 'var(--color-foreground)',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  // The scroller IS CodeMirror's scroll container (`view.scrollDOM`): CM decides
  // which lines to render from THIS element's scroll metrics and virtualizes the
  // rest. So the height cap + overflow MUST live here. Putting the scroll box on
  // `.cm-content` (with the scroller left `overflow: visible`) made the scroller
  // non-scrolling, so CM only rendered the first viewport and virtualized a long
  // document's tail away — editing a long message showed a truncated body.
  // `.cm-content` keeps only its min-height (below) and grows freely inside here.
  // Responsive cap mirrors the old content classes: 200px, 500px (31.25rem) ≥ md.
  '.cm-scroller': {
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.5',
    overflowY: 'auto',
    overflowX: 'hidden',
    maxHeight: '200px',
  },
  '@media (min-width: 768px)': {
    '.cm-scroller': { maxHeight: '31.25rem' },
  },
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
  // Live-preview emoji glyph. Capped at 1.2em with line-height:1 so it never
  // exceeds the 1.5 line box (avoids per-line height jiggle).
  '.cm-emoji-glyph': {
    display: 'inline-block',
    fontSize: '1.2em',
    lineHeight: '1',
    verticalAlign: 'middle',
  },
  // Custom (workspace) emoji image — same 1.2em cap as the glyph so a line with
  // a custom emoji is exactly as tall as a text-only line.
  '.cm-emoji-img': {
    display: 'inline-block',
    width: '1.2em',
    height: '1.2em',
    objectFit: 'contain',
    verticalAlign: 'middle',
  },

  // ---- Autocomplete popup (mentions / channels / emoji) ----
  // Styled to read like the app's shadcn popover/menu, replacing the default
  // CodeMirror tooltip chrome. Section headers (Channel members / Not in
  // channel / Special mentions) come from CompletionSection.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid var(--color-border)',
    borderRadius: '0.75rem',
    backgroundColor: 'var(--color-card)',
    boxShadow: '0 8px 24px -6px rgba(0, 0, 0, 0.18), 0 2px 6px -2px rgba(0, 0, 0, 0.1)',
    overflow: 'hidden',
    // Sit above every app layer. The popup is portalled to <body> (see
    // MarkdownEditor's tooltips({ parent: document.body })), so it competes with
    // top-level surfaces — the highest today is PopoverPortal at z-999. CM's
    // base .cm-tooltip is only z-500, which a mobile drawer/portal could cover;
    // 1000 keeps the mention/emoji typeahead unconditionally on top.
    zIndex: 1000,
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    // Wider popup so names + emails + status sit comfortably on one line.
    minWidth: '20rem',
    maxWidth: '24rem',
  },
  // NB: the `.cm-tooltip.cm-tooltip-autocomplete` (two-class) prefix is
  // deliberate — CodeMirror's own baseTheme styles `ul`/`li` with that exact
  // two-class specificity, so a single-class selector loses the cascade and our
  // padding is silently dropped (rows glue to the edges). Match its specificity.
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-sans)',
    maxHeight: '20rem',
    padding: '0.5rem',
    // The list is the sole scroll container; keep wheel/touch scroll from
    // chaining out and from feeling like individual rows scroll.
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '0.625rem 0.875rem',
    margin: '0.125rem 0',
    borderRadius: '0.5rem',
    color: 'var(--color-foreground)',
    fontFamily: 'var(--font-sans)',
    // Rows never scroll internally — only the <ul> does.
    overflow: 'hidden',
  },
  // Mobile: the popup opens ABOVE the composer (aboveCursor in
  // completions.ts) into the sliver of screen the on-screen keyboard leaves.
  // The desktop 20rem list would swallow most of it, so cap the list to
  // ~4 visible rows (the rest scroll), and let the popup shrink below the
  // desktop min-width so it never overflows a narrow viewport.
  '@media (max-width: 767px)': {
    '.cm-tooltip.cm-tooltip-autocomplete': {
      minWidth: '0',
      maxWidth: 'calc(100vw - 1rem)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      maxHeight: '12.5rem',
    },
  },
  // Exactly one row is highlighted: the selected one. Hovering a row makes it
  // the selected row (see hoverSelect in completions.ts), so the mouse and the
  // keyboard drive the same single highlight — pointing at the list never hides
  // the keyboard's selection, and arrow-key navigation stays visible.
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-muted)',
    color: 'var(--color-foreground)',
  },
  // Every composer option renders a custom row (see optionRender.ts), so hide
  // CodeMirror's default label/detail (which also pull in the monospace font).
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionLabel': { display: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionDetail': { display: 'none' },

  // ---- Custom option row ----
  '.cm-option-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    minWidth: '0',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-option-col': { display: 'flex', flexDirection: 'column', minWidth: '0', lineHeight: '1.3' },
  '.cm-option-title-row': { display: 'flex', alignItems: 'center', gap: '0.25rem', minWidth: '0' },
  '.cm-option-title': {
    // Main information stays at the 14px body minimum.
    fontSize: '0.875rem',
    fontWeight: '500',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-option-status': { flex: '0 0 auto', fontSize: '0.875rem', lineHeight: '1' },
  '.cm-option-sub': {
    fontSize: '0.75rem',
    color: 'var(--color-muted-foreground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  // Avatar (image or initial) + presence dot. The wrapper/visual/dot split
  // mirrors UserAvatar: the notch mask must sit on the avatar circle while the
  // dot lives OUTSIDE it (a masked parent would clip the dot away).
  '.cm-option-avatarwrap': {
    position: 'relative',
    flex: '0 0 auto',
    display: 'inline-flex',
  },
  '.cm-option-avatar': {
    position: 'relative',
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.75rem',
    height: '1.75rem',
    borderRadius: '9999px',
    backgroundColor: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
    color: 'var(--color-primary)',
    fontSize: '0.75rem',
    fontWeight: '600',
    overflow: 'visible',
  },
  // Slack-style notch carved out of the avatar for the presence dot — the
  // exact geometry every other avatar surface gets from presenceNotchStyle.
  '.cm-option-avatar--notched': {
    ...(presenceNotchStyle(PRESENCE_DOT_DEFAULT_SIZE) as Record<string, string>),
  },
  '.cm-option-avatar img': {
    width: '100%',
    height: '100%',
    borderRadius: '9999px',
    objectFit: 'cover',
  },
  // The canonical presence design (see components/PresenceDot.tsx): state is
  // encoded by shape as well as color — online is a solid dot in the presence
  // green, offline a hollow muted ring. Sizes/stroke derive from the same
  // shared constants; presenceDotParity.browser.test.tsx pins the parity.
  '.cm-option-dot': {
    position: 'absolute',
    right: '0',
    bottom: '0',
    width: `${PRESENCE_DOT_DEFAULT_SIZE}px`,
    height: `${PRESENCE_DOT_DEFAULT_SIZE}px`,
    borderRadius: '9999px',
  },
  '.cm-option-dot[data-presence="online"]': {
    backgroundColor: 'var(--color-online)',
  },
  '.cm-option-dot[data-presence="offline"]': {
    backgroundColor: 'transparent',
    border: `${presenceDotBorderWidth(PRESENCE_DOT_DEFAULT_SIZE)}px solid var(--color-muted-foreground)`,
  },
  // Channel / group icon.
  '.cm-option-icon': {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.75rem',
    height: '1.75rem',
    color: 'var(--color-muted-foreground)',
  },
  '.cm-option-icon svg': { width: '1rem', height: '1rem' },
  // @all / @here: an avatar-circle (see .cm-option-avatar) with a bolder "@" on
  // an amber/caution background — these mentions notify many people, so the
  // colour nudges the user to be careful.
  '.cm-option-group': {
    fontSize: '0.875rem',
    fontWeight: '700',
    backgroundColor: 'var(--color-caution)',
    color: 'var(--color-caution-foreground)',
  },
  // Emoji glyph — shown first and larger (Slack-style).
  '.cm-option-emoji': {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.75rem',
    fontSize: '1.5rem',
    lineHeight: '1',
  },
  '.cm-option-emoji img': { width: '1.4rem', height: '1.4rem', objectFit: 'contain' },

  // Section header row. Uses the normal UI font (the surrounding <ul> defaults
  // to monospace, which is why an explicit font-family is needed here).
  '.cm-mention-section': {
    padding: '0.5rem 0.75rem 0.25rem',
    fontFamily: 'var(--font-sans)',
    fontSize: '0.6875rem',
    fontWeight: '700',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--color-muted-foreground)',
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
