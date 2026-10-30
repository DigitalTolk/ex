import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { EditorView } from '@codemirror/view';
import { emoticonEmoji } from '@/lib/emoji-shortcodes';

// An emoticon becomes its emoji as soon as the space after it is typed: `:P `
// turns into `😛 `, as in Slack. Always the standard emoji, never a custom
// one, and never inside code. Undo puts the emoticon back. One the space
// never followed is converted when the message is sent (normalizeEmojiInBody).
const CODE = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);

export const emoticonsToEmoji = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  // The word just finished: an emoticon only counts on its own.
  const word = before.slice(before.search(/\S*$/));
  const emoji = emoticonEmoji(word);
  if (emoji === undefined) return false;
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(from, -1); node; node = node.parent) {
    if (CODE.has(node.name)) return false;
  }
  const start = from - word.length;
  view.dispatch({
    changes: { from: start, to: from, insert: `${emoji} ` },
    selection: { anchor: start + emoji.length + 1 },
    userEvent: 'input.type',
    // Its own undo step, not merged into the typing around it.
    annotations: isolateHistory.of('full'),
  });
  return true;
});
