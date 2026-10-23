import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { Language, LanguageSupport } from '@codemirror/language';
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

export const composerMarkdown = new LanguageSupport(
  new Language(commonmarkLanguage.data, parser, [], 'markdown'),
  // Same precedence as markdown(): Enter continues a list or quote before the
  // composer's Enter-to-send sees it; Backspace removes list markup.
  [pasteURLAsLink, Prec.high(keymap.of(markdownKeymap))],
);
