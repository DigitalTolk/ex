import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  shortcodeToUnicode,
  applySkinToneSuffix,
  emoticonEmoji,
  EMOJI_SHORTCODE_RE_GLOBAL,
  EMOTICON_RE_GLOBAL,
} from '@/lib/emoji-shortcodes';

// Live-preview for `:shortcode:` emoji: the document keeps the raw shortcode
// (portable, server-validatable) while a widget renders the actual glyph (or the
// custom emoji image), hidden and revealed whenever the caret is inside the
// token so it stays editable. Grammar matches the message renderer
// (lib/markdown.tsx): an optional `::skin-tone-N` suffix on a `:name:`. Custom
// emoji are resolved to their image via the injected name→URL lookup.
//
// An emoticon on its own (`:P`, `<3`) shows the same way, as its standard
// emoji — never a custom one: as soon as the space after it is typed, and as
// its text again when the caret comes back to it. These are the emoticons
// sending turns into emoji (normalizeEmojiInBody), and like it, none in code.

// name → image URL for custom (workspace) emoji.
type CustomEmojiResolver = (name: string) => string | undefined;

class EmojiWidget extends WidgetType {
  readonly title: string;
  readonly glyph?: string;
  readonly imageURL?: string;
  constructor(title: string, glyph?: string, imageURL?: string) {
    super();
    this.title = title;
    this.glyph = glyph;
    this.imageURL = imageURL;
  }
  eq(other: EmojiWidget) {
    return other.glyph === this.glyph && other.imageURL === this.imageURL;
  }
  toDOM() {
    if (this.imageURL) {
      const img = document.createElement('img');
      img.className = 'cm-emoji-img';
      img.src = this.imageURL;
      img.alt = this.title;
      img.title = this.title;
      return img;
    }
    const span = document.createElement('span');
    span.className = 'cm-emoji-glyph';
    // The span path only runs for glyph widgets (imageURL is handled above), so
    // `glyph` is always set here; the `?? ''` fallback is unreachable.
    /* istanbul ignore next -- unreachable fallback (see above). */
    span.textContent = this.glyph ?? '';
    span.title = this.title;
    return span;
  }
}

// Resolve a shortcode (+ optional skin tone) to its unicode glyph, or null when
// the name is not a known standard emoji (then we try the custom-emoji map).
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

const CODE = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);

function inCode(view: EditorView, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
    if (CODE.has(node.name)) return true;
  }
  return false;
}

function buildDecorations(view: EditorView, resolveCustom: CustomEmojiResolver): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(EMOJI_SHORTCODE_RE_GLOBAL)) {
      const name = m[1];
      const skin = m[2];
      const title = skin ? `:${name}::${skin}:` : `:${name}:`;
      const glyph = glyphFor(name, skin);
      let widget: EmojiWidget | null = null;
      if (glyph !== null) {
        widget = new EmojiWidget(title, glyph);
      } else {
        const url = resolveCustom(name);
        if (url) widget = new EmojiWidget(title, undefined, url);
      }
      if (!widget) continue; // unknown shortcode → leave as literal text
      const start = from + matchStart(m);
      const end = start + m[0].length;
      if (caretInside(view, start, end)) continue; // reveal raw shortcode for editing
      widgets.push(Decoration.replace({ widget, inclusive: false }).range(start, end));
    }
    for (const m of text.matchAll(EMOTICON_RE_GLOBAL)) {
      const start = from + matchStart(m);
      const end = start + m[0].length;
      if (caretInside(view, start, end) || inCode(view, start)) continue;
      const widget = new EmojiWidget(m[0], emoticonEmoji(m[0]));
      widgets.push(Decoration.replace({ widget, inclusive: false }).range(start, end));
    }
  }
  return Decoration.set(widgets, true);
}

// `resolveCustom` maps a custom-emoji name to its image URL (read live so the
// editor — built once — picks up the workspace emoji as they load).
export function emojiGlyphs(resolveCustom: CustomEmojiResolver) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, resolveCustom);
      }
      update(update: ViewUpdate) {
        // Rebuild on every update: glyphs depend on both the document and the
        // selection (caret-touch reveals the raw shortcode). Branch-free + cheap.
        this.decorations = buildDecorations(update.view, resolveCustom);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const atomicRanges = EditorView.atomicRanges.of((view) => {
    // The plugin always ships alongside this facet, so the fallback is unreachable.
    /* istanbul ignore next -- unreachable: plugin is always present. */
    return view.plugin(plugin)?.decorations ?? Decoration.none;
  });

  return [plugin, atomicRanges];
}
