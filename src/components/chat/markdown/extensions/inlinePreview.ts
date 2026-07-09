import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

// Inline live-preview (the "atomic-editor" / Obsidian model). The document is
// always raw markdown; this plugin only DECORATES it:
//   - hides the delimiter characters (`**`, `*`, `_`, `~~`, `` ` ``, `#`) so
//     formatted text reads as rendered — UNLESS the cursor/selection is inside
//     that token, in which case the raw syntax is revealed so you can edit it;
//   - gives inline code a pill, fenced code a background, and blockquotes a bar.
// The actual weight/italic/colour comes from the highlight style in theme.ts.
// Nothing here changes the document, so there is no round-trip and nothing to
// get out of sync.

// Lezer-markdown delimiter node types we hide when not being edited.
const DELIMITER_NODES = new Set([
  'EmphasisMark', // * or _ around emphasis/strong
  'StrikethroughMark', // ~~
  'CodeMark', // ` around inline code
  'HeaderMark', // leading #'s
]);

const hiddenMark = Decoration.replace({});
const inlineCodeMark = Decoration.mark({ class: 'cm-inlineCode' });
const codeBlockLine = Decoration.line({ class: 'cm-codeblock' });
const quoteLine = Decoration.line({ class: 'cm-quote' });

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        // Hide an inline delimiter unless the caret is inside its parent token.
        if (DELIMITER_NODES.has(node.name)) {
          const parent = node.node.parent;
          /* istanbul ignore next -- a delimiter mark token always has its inline parent node in the Lezer markdown tree, so the parent-null fallback is unreachable defensive code. */
          const [tokenFrom, tokenTo] = parent ? [parent.from, parent.to] : [node.from, node.to];
          if (!selectionTouches(view, tokenFrom, tokenTo) && node.to > node.from) {
            widgets.push(hiddenMark.range(node.from, node.to));
          }
          return;
        }
        if (node.name === 'InlineCode') {
          widgets.push(inlineCodeMark.range(node.from, node.to));
          return;
        }
      },
    });
  }

  // Line-level decorations for fenced code and blockquotes: walk the lines the
  // node spans and tag them so CSS can paint the background / bar.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode' && node.name !== 'Blockquote') return;
        const deco = node.name === 'FencedCode' ? codeBlockLine : quoteLine;
        let pos = node.from;
        while (pos <= node.to) {
          const line = view.state.doc.lineAt(pos);
          widgets.push(deco.range(line.from));
          if (line.to + 1 > node.to) break;
          pos = line.to + 1;
        }
      },
    });
  }

  // Decorations must be sorted by `from` (line decorations sort before others
  // at the same position via startSide); Decoration.set with sort=true handles it.
  return Decoration.set(widgets, true);
}

export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
