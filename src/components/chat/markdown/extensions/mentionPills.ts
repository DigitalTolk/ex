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
  USER_MENTION_RE_GLOBAL,
  CHANNEL_MENTION_RE_GLOBAL,
} from '@/lib/mention-syntax';

// Renders the raw mention tokens — `@[id|name]`, `~[id|slug]`, `@all`/`@here` —
// as atomic "pill" widgets while the document keeps the raw markup (so the
// stored body is unchanged and round-trips losslessly). The pill is hidden and
// the raw token revealed whenever the caret is inside it, so it stays editable.
// Reuses the canonical regexes from lib/mention-syntax so the composer and the
// message renderer agree on exactly what a mention is.

type PillKind = 'user' | 'channel' | 'group' | 'connector';

class PillWidget extends WidgetType {
  readonly label: string;
  readonly kind: PillKind;
  constructor(label: string, kind: PillKind) {
    super();
    this.label = label;
    this.kind = kind;
  }
  eq(other: PillWidget) {
    return other.label === this.label && other.kind === this.kind;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-mention-pill';
    span.setAttribute('data-mention-kind', this.kind);
    span.textContent = this.label;
    return span;
  }
}

// Standalone @all / @here. Mirrors GROUP_MENTION_RE but global so we can scan.
const GROUP_RE_GLOBAL = /(^|[^\w@])@(all|here)\b/g;

// matchAll always sets `index`, but the lib type marks it optional; the `?? 0`
// fallback is a type guard whose false branch is unreachable at runtime.
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
  const push = (from: number, to: number, label: string, kind: PillKind) => {
    if (caretInside(view, from, to)) return; // reveal raw token for editing
    widgets.push(
      Decoration.replace({ widget: new PillWidget(label, kind), inclusive: false }).range(from, to),
    );
  };

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(USER_MENTION_RE_GLOBAL)) {
      const start = from + matchStart(m);
      push(start, start + m[0].length, `@${m[2]}`, 'user');
    }
    for (const m of text.matchAll(CHANNEL_MENTION_RE_GLOBAL)) {
      const start = from + matchStart(m);
      push(start, start + m[0].length, `~${m[2]}`, 'channel');
    }
    for (const m of text.matchAll(GROUP_RE_GLOBAL)) {
      // m[1] is the (possibly empty) preceding non-word char; the mention itself
      // starts after it.
      const start = from + matchStart(m) + m[1].length;
      push(start, start + 1 + m[2].length, `@${m[2]}`, 'group');
    }
  }
  return Decoration.set(widgets, true);
}

const mentionPillsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      // Rebuild unconditionally: the pills depend on both the document and the
      // selection (caret-touch reveals the raw token), and recomputing on any
      // update keeps the logic branch-free and the cost negligible for a composer.
      this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Treat the rendered pills as atomic: cursor motion and Backspace jump over /
// delete the whole token rather than landing inside the raw `@[id|name]`.
const mentionAtomicRanges = EditorView.atomicRanges.of((view) => {
  // The plugin is always installed alongside this facet (they ship together in
  // `mentionPills`), so the `?.` / `??` fallbacks are unreachable defensive code.
  /* istanbul ignore next -- unreachable: plugin is always present (see above). */
  return view.plugin(mentionPillsPlugin)?.decorations ?? Decoration.none;
});

export const mentionPills = [mentionPillsPlugin, mentionAtomicRanges];

// ---- Connector pills ----
//
// "/cliffhub" tokens (the composer's connector picks) render as pills too —
// but only for slugs that are actually installed connectors, so prose like
// "a /tmp path" never turns into UI. The document keeps the raw "/slug" text
// (that's what the backend parses); the pill is presentation only.

const CONNECTOR_TOKEN_RE_GLOBAL = /(^|\s)\/([a-z0-9][a-z0-9-]*)/g;

function buildConnectorDecorations(view: EditorView, slugs: Set<string>): DecorationSet {
  if (slugs.size === 0) return Decoration.none;
  const widgets: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(CONNECTOR_TOKEN_RE_GLOBAL)) {
      if (!slugs.has(m[2])) continue;
      const start = from + matchStart(m) + m[1].length;
      const end = start + 1 + m[2].length;
      if (caretInside(view, start, end)) continue; // reveal raw token for editing
      widgets.push(
        Decoration.replace({
          widget: new PillWidget(`/${m[2]}`, 'connector'),
          inclusive: false,
        }).range(start, end),
      );
    }
  }
  return Decoration.set(widgets, true);
}

// connectorPills is a factory (unlike mentionPills) because it needs the live
// list of installed connector slugs from the app layer.
export function connectorPills(getSlugs: () => string[]) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildConnectorDecorations(view, new Set(getSlugs()));
      }
      update(update: ViewUpdate) {
        this.decorations = buildConnectorDecorations(update.view, new Set(getSlugs()));
      }
    },
    { decorations: (v) => v.decorations },
  );
  const atomic = EditorView.atomicRanges.of(
    (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
  );
  return [plugin, atomic];
}
