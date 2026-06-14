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
// A fenced code block is self-delimiting: its closing ``` / ~~~ ends the
// block no matter what follows, and an opening fence can interrupt the
// preceding line. So the blank line $convertToMarkdownString inserts on
// either side of a fence is purely cosmetic — nothing gets absorbed by
// removing it — yet it breaks copy round-trip fidelity (the user typed a
// code block directly adjacent to a paragraph, not separated by a blank
// line). We drop those fence-adjacent gaps while never touching a blank
// line INSIDE a fence (real code content). `~~~` and ``` are both matched.
const FENCE_RE = /^\s*(?:```|~~~)/;

function collapseSyntheticBlockGaps(markdown: string): string {
  const lines = markdown.split('\n');
  const n = lines.length;

  // Classify every line relative to fenced code: the fence delimiters
  // ('open'/'close') and the code content between them ('content').
  const fenceRole: Array<'open' | 'close' | 'content' | null> = new Array(n).fill(null);
  let inFence = false;
  for (let i = 0; i < n; i++) {
    if (FENCE_RE.test(lines[i])) {
      fenceRole[i] = inFence ? 'close' : 'open';
      inFence = !inFence;
    } else if (inFence) {
      fenceRole[i] = 'content';
    }
  }

  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (line.trim() !== '') {
      out.push(line);
      continue;
    }
    // A blank line inside a fence is literal code — preserve it verbatim.
    if (fenceRole[i] === 'content') {
      out.push(line);
      continue;
    }

    let p = i - 1;
    while (p >= 0 && lines[p].trim() === '') p--;
    let q = i + 1;
    while (q < n && lines[q].trim() === '') q++;
    const prev = p >= 0 ? lines[p] : '';
    const next = q < n ? lines[q] : '';

    // Drop a SINGLE synthetic separator pressed directly against a fence
    // boundary (right after a closing fence, or right before an opening one).
    // Only an *isolated* blank line qualifies — its nearest non-blank lines sit
    // directly adjacent (p === i-1, q === i+1). A run of 2+ blanks encodes
    // user-authored empty paragraphs (deliberate spacing the renderer shows as
    // blank rows), which must survive the round-trip untouched.
    const isIsolatedBlank = p === i - 1 && q === i + 1;
    if (isIsolatedBlank && (fenceRole[p] === 'close' || fenceRole[q] === 'open')) {
      continue;
    }

    // Two adjacent blocks of the SAME quote/list kind: the blank is a
    // synthetic separator the user didn't intend (one continuous quote /
    // list), so drop it. A gap between a block and a plain paragraph stays —
    // it terminates the list / quote and removing it would make the
    // paragraph a lazy continuation.
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
