import { $convertToMarkdownString } from '@lexical/markdown';
import { EX_TRANSFORMERS } from './transformers';

// Lexical's text-export pass blindly escapes every `_`, `*`, `` ` ``,
// `~`, and `\` in TextNode content (see exportTextFormat in
// @lexical/markdown). The underscore escape mangles emoji shortcodes
// — `:heart_eyes:` becomes `:heart\_eyes:` and our renderer's
// `/:[a-z0-9_+-]+:/` regex no longer matches, so the shortcode shows
// as literal text instead of the emoji glyph.
//
// CommonMark spec already says intraword underscores are NOT emphasis
// (`a_b_c` doesn't italicize), so escaping them is unnecessary for our
// markdown renderer. Strip the escape on the way out. The other
// escapes (`\*`, `` \` ``, `\~`, `\\`) stay — those have meaningful
// semantics our renderer respects.
const ESCAPED_UNDERSCORE = /\\_/g;

// Wrap $convertToMarkdownString so callers don't have to remember to
// post-process. Must be called inside an editor.read / editorState.read
// scope (same constraint as $convertToMarkdownString).
export function $exportMarkdown(): string {
  return $convertToMarkdownString(EX_TRANSFORMERS).trim().replace(ESCAPED_UNDERSCORE, '_');
}
