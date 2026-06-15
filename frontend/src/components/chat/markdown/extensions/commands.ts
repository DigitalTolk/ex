import { EditorSelection } from '@codemirror/state';
import { type EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { ActiveFormat } from '../types';

const MARK_DELIM: Record<'bold' | 'italic' | 'strike' | 'code', string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

// Wrap (or unwrap) the current selection with the markdown delimiter. Empty
// selection inserts the pair and drops the caret between them. Operating on the
// document text — not a node tree — is the whole point: what you see is what's
// stored.
export function applyMark(view: EditorView, mark: 'bold' | 'italic' | 'strike' | 'code'): void {
  const delim = MARK_DELIM[mark];
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const already = text.startsWith(delim) && text.endsWith(delim) && text.length >= delim.length * 2;
    if (already) {
      const inner = text.slice(delim.length, text.length - delim.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    const insert = delim + text + delim;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text.length === 0
        ? EditorSelection.cursor(range.from + delim.length)
        : EditorSelection.range(range.from + delim.length, range.from + delim.length + text.length),
    };
  });
  view.dispatch(changes, { scrollIntoView: true });
}

const BLOCK_PREFIX: Record<'quote' | 'ul' | 'ol', (n: number) => string> = {
  quote: () => '> ',
  ul: () => '- ',
  ol: (n) => `${n}. `,
};

// Prefix each line the selection spans with the block marker. Re-applying the
// same marker strips it (toggle).
export function applyBlock(view: EditorView, block: 'quote' | 'ul' | 'ol'): void {
  const { state } = view;
  const ranges = state.selection.ranges;
  const lineNumbers = new Set<number>();
  for (const r of ranges) {
    const startLine = state.doc.lineAt(r.from).number;
    const endLine = state.doc.lineAt(r.to).number;
    for (let n = startLine; n <= endLine; n++) lineNumbers.add(n);
  }
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const sample = state.doc.line(sorted[0]);
  const stripRe = block === 'quote' ? /^> / : block === 'ul' ? /^- / : /^\d+\. /;
  const removing = stripRe.test(sample.text);
  const changes = sorted.map((n, i) => {
    const line = state.doc.line(n);
    if (removing) {
      const m = line.text.match(stripRe);
      return { from: line.from, to: line.from + (m ? m[0].length : 0), insert: '' };
    }
    return { from: line.from, to: line.from, insert: BLOCK_PREFIX[block](i + 1) };
  });
  // Map the selection through the changes with forward association (+1) so a
  // caret sitting at the line start lands AFTER the inserted prefix, not before
  // it. A plain dispatch would keep the caret at the (unchanged) line.from.
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    scrollIntoView: true,
  });
}

// Read which formats apply at the primary selection head — drives the toolbar
// pressed state. Walks the syntax tree at the caret.
const NODE_TO_FORMAT: Record<string, ActiveFormat> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Blockquote: 'quote',
  BulletList: 'ul',
  OrderedList: 'ol',
};

export function getActiveFormats(view: EditorView): Set<ActiveFormat> {
  const active = new Set<ActiveFormat>();
  const pos = view.state.selection.main.head;
  let node = syntaxTree(view.state).resolveInner(pos, -1);
  while (node) {
    const fmt = NODE_TO_FORMAT[node.name];
    if (fmt) active.add(fmt);
    const parent = node.parent;
    if (!parent) break;
    node = parent;
  }
  return active;
}
