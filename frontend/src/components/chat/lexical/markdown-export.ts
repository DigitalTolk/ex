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

// Which contiguous-block kind a markdown line belongs to, or null for a
// plain paragraph / blank line. Only `quote` and `list` participate in
// gap-collapsing; code fences are deliberately excluded so blank lines
// inside fenced code are preserved verbatim.
type BlockKind = 'quote' | 'list';
function blockKind(line: string): BlockKind | null {
  if (/^>\s?/.test(line)) return 'quote';
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return 'list';
  return null;
}

// Lexical's $convertToMarkdownString separates EVERY top-level block with
// a blank line. For two adjacent blocks of the SAME kind — e.g. two
// QuoteNodes produced by pressing Enter inside a quote, or two ListNodes
// — that blank line renders as two visually-distinct blocks when the
// user meant one continuous quote / list, so we drop it.
//
// Crucially we only collapse when the lines on BOTH sides of the gap are
// the same block kind. A blank line between a block and a following
// paragraph (or vice-versa) is semantically meaningful: it terminates
// the list / quote. Stripping it there made the next paragraph a lazy
// continuation, so `> quote` + blank + `text` rendered as `> quote\ntext`
// (text swallowed into the quote) and a list item swallowed the
// paragraph after it. Preserve those gaps.
function collapseSyntheticBlockGaps(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '') {
      out.push(line);
      continue;
    }

    const prev = out.at(-1) ?? '';
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '') {
        next = lines[j];
        break;
      }
    }
    const prevKind = blockKind(prev);
    if (prev && next && prevKind !== null && blockKind(next) === prevKind) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// Wrap $convertToMarkdownString so callers don't have to remember to
// post-process. Must be called inside an editor.read / editorState.read
// scope (same constraint as $convertToMarkdownString).
export function $exportMarkdown(): string {
  return collapseSyntheticBlockGaps(
    $convertToMarkdownString(EX_TRANSFORMERS).replace(ESCAPED_UNDERSCORE, '_'),
  );
}
