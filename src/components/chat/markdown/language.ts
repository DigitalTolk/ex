import { Prec, type StateCommand } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { Language, LanguageSupport, syntaxTree } from '@codemirror/language';
import { commonmarkLanguage, markdownKeymap, pasteURLAsLink } from '@codemirror/lang-markdown';
import { Strikethrough, Autolink, type MarkdownParser } from '@lezer/markdown';

// The composer's markdown language: CommonMark plus GFM strikethrough and
// autolinks, without SetextHeading, so `foobar\n---` is a paragraph followed
// by a thematic break (a divider), not an H2 — the Slack-style mental model
// that a line of `---` is a horizontal rule.
//
// Built from lang-markdown's parser and commands rather than its markdown()
// helper: that one also mixes in lang-html (which pulls the JavaScript and
// CSS grammars along) for HTML-in-markdown parsing and tag completion, and
// the composer uses neither — its completion sources override the
// language's. The parser and the language data facet are lang-markdown's
// own, so its list-continuation, markup-backspace and paste-URL-as-link
// commands still recognise the document as markdown.
const parser = (commonmarkLanguage.parser as MarkdownParser).configure([
  Strikethrough,
  Autolink,
  { remove: ['SetextHeading'] },
]);

// The marker a top-level list item starts with, and the spaces after it.
const TOP_LEVEL_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)])[ \t]+$/;

// Backspace right after a top-level list marker ("- |", "2. |") leaves a plain
// line. lang-markdown's own command swaps the marker for spaces instead, to
// carry on the item, and the indented line then rendered as part of the item
// above: "- GHI" then "  Additional info." became one bullet. Nested items, a
// cursor further along, and markers in code keep the default.
export const removeListMarkerBackward: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (!TOP_LEVEL_MARKER_RE.test(line.text.slice(0, sel.head - line.from))) return false;
  if (syntaxTree(state).resolveInner(line.from, 1).name !== 'ListMark') return false;
  dispatch(
    state.update({
      changes: { from: line.from, to: sel.head },
      selection: { anchor: line.from },
      scrollIntoView: true,
      userEvent: 'delete',
    }),
  );
  return true;
};

export const composerMarkdown = new LanguageSupport(
  new Language(commonmarkLanguage.data, parser, [], 'markdown'),
  // Same precedence as markdown(): Enter continues a list or quote before the
  // composer's Enter-to-send sees it; Backspace removes list markup.
  [pasteURLAsLink, Prec.high(keymap.of([{ key: 'Backspace', run: removeListMarkerBackward }, ...markdownKeymap]))],
);
