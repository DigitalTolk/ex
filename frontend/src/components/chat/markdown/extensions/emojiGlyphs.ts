import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { type Range } from '@codemirror/state';
import {
  shortcodeToUnicode,
  applySkinToneSuffix,
  EMOJI_SHORTCODE_RE_GLOBAL,
} from '@/lib/emoji-shortcodes';

// Live-preview for `:shortcode:` emoji: the document keeps the raw shortcode
// (portable, server-validatable) while a widget renders the actual glyph, hidden
// and revealed whenever the caret is inside the token so it stays editable. The
// grammar matches the message renderer exactly (lib/markdown.tsx): an optional
// `::skin-tone-N` suffix on a `:name:`. Custom emoji (image-backed) carry no
// unicode glyph, so they're left as literal text here.

class GlyphWidget extends WidgetType {
  readonly glyph: string;
  readonly title: string;
  constructor(glyph: string, title: string) {
    super();
    this.glyph = glyph;
    this.title = title;
  }
  eq(other: GlyphWidget) {
    return other.glyph === this.glyph;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-emoji-glyph';
    span.textContent = this.glyph;
    span.title = this.title;
    return span;
  }
}

// Resolve a shortcode (+ optional skin tone) to its glyph, or null when the name
// is not a known standard emoji (custom/unknown → leave as literal text).
function glyphFor(name: string, skin: string | undefined): string | null {
  const unicode = shortcodeToUnicode(`:${name}:`);
  if (unicode === `:${name}:`) return null;
  return skin ? applySkinToneSuffix(unicode, skin) : unicode;
}

// matchAll always sets `index`; the `?? 0` is a type-guard whose false branch is
// unreachable at runtime.
/* istanbul ignore next -- unreachable type-guard fallback (see above). */
function matchStart(m: RegExpMatchArray): number {
  return m.index ?? 0;
}

function caretInside(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(EMOJI_SHORTCODE_RE_GLOBAL)) {
      const glyph = glyphFor(m[1], m[2]);
      if (glyph === null) continue; // unknown/custom shortcode → literal text
      const start = from + matchStart(m);
      const end = start + m[0].length;
      if (caretInside(view, start, end)) continue; // reveal raw shortcode for editing
      const title = m[2] ? `:${m[1]}::${m[2]}:` : `:${m[1]}:`;
      widgets.push(
        Decoration.replace({ widget: new GlyphWidget(glyph, title), inclusive: false }).range(start, end),
      );
    }
  }
  return Decoration.set(widgets, true);
}

const emojiGlyphsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      // Rebuild on every update: the glyphs depend on both the document and the
      // selection (caret-touch reveals the raw shortcode). Branch-free + cheap.
      this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const emojiAtomicRanges = EditorView.atomicRanges.of((view) => {
  // The plugin always ships alongside this facet, so the fallback is unreachable.
  /* istanbul ignore next -- unreachable: plugin is always present. */
  return view.plugin(emojiGlyphsPlugin)?.decorations ?? Decoration.none;
});

export const emojiGlyphs = [emojiGlyphsPlugin, emojiAtomicRanges];
