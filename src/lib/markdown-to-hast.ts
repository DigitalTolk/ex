import type { HastNode } from '@/types';
import { EMOJI_SHORTCODE_RE, EMOJI_SHORTCODE_TONED_RE } from './emoji-shortcodes';
import { USER_MENTION_RE, GROUP_MENTION_RE, CHANNEL_MENTION_RE } from './mention-syntax';

// markdownToHast is the client-side fallback parser: it turns a raw
// markdown body into the SAME hast vocabulary the backend emits
// (internal/service/markdown.go + markdown_custom_syntax.go), so every
// message renders through the single renderHastTree hydrator regardless
// of whether the server shipped a pre-rendered tree. Used for tree-less
// content only: optimistic sends, legacy rows, webhook attachment
// fields, unfurl descriptions, and search hits.
//
// Deliberately hand-rolled rather than remark-based: the server's
// goldmark pipeline has bespoke behaviours (blank-line stacking via
// p[data-blank], custom ex-* inline tokens, data-align table props)
// that a remark pipeline would fight; the authoritative grammar lives
// on the server and this mirrors its output shapes.

// The leading-char class excludes `/` so URL fragments like
// `/path#anchor` don't render as a hashtag pill. The body regex
// mirrors `internal/search/indexer.go` hashtagPattern.
const HASHTAG_RE = /(^|[^\w/])#([\p{L}\p{N}_-]{2,64})/u;
const FENCE_RE = /^```(\S+)?\s*$/;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+?)(?:\s+=(\d+)x(\d+))?\)/;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const BOLD_RE = /\*\*([^*]+)\*\*/;
const STRIKE_RE = /~~([^~]+)~~/;
const ITALIC_RE = /\*([^*\n]+)\*/;
const INLINE_CODE_RE = /`([^`\n]+)`/;
const BARE_URL_RE = /https?:\/\/[^\s<>"]+/;

function el(tagName: string, properties?: Record<string, unknown>, children: HastNode[] = []): HastNode {
  return { type: 'element', tagName, properties, children } as HastNode;
}

function text(value: string): HastNode {
  return { type: 'text', value } as HastNode;
}

interface InlineMatch {
  index: number;
  length: number;
  nodes: HastNode[];
}

// findInline returns the EARLIEST match among all inline token kinds —
// same precedence strategy as the server's splitTokens passes (explicit
// syntax claims text before looser matchers like bare URLs).
function findInline(src: string): InlineMatch | null {
  let earliest: InlineMatch | null = null;
  const tryMatch = (re: RegExp, build: (m: RegExpExecArray) => HastNode[]) => {
    const m = re.exec(src);
    if (!m) return;
    if (earliest === null || m.index < earliest.index) {
      earliest = { index: m.index, length: m[0].length, nodes: build(m) };
    }
  };

  // user mention: @[USER_ID|Display Name] — before the link matcher so
  // "@[id|name]" isn't mistaken for "@" followed by a [link](url).
  tryMatch(USER_MENTION_RE, (m) => [
    el('ex-mention-user', {
      'data-user-id': m[1].trim(),
      'data-name': m[2].trim(),
      'data-value': m[0],
    }),
  ]);

  // channel mention: ~[CHANNEL_ID|slug]
  tryMatch(CHANNEL_MENTION_RE, (m) => [
    el('ex-mention-channel', {
      'data-channel-id': m[1].trim(),
      'data-slug': m[2].trim(),
      'data-value': m[0],
    }),
  ]);

  // group mention: @all / @here — group 1 is the lead char kept as text.
  tryMatch(GROUP_MENTION_RE, (m) => {
    /* v8 ignore next 2 */
    /* istanbul ignore next -- GROUP_MENTION_RE's group 1 is `(^|[^\w@])` which always captures (empty string at start of input), so m[1] is never undefined; the ?? '' arm is defensive. */
    const lead = m[1] ?? '';
    return [text(lead), el('ex-mention-group', { 'data-group': m[2], 'data-value': `@${m[2]}` })];
  });

  // hashtag: #tag — emitted unconditionally like the server; the
  // hydrator renders plain text when no onTagClick handler is wired.
  tryMatch(HASHTAG_RE, (m) => {
    /* v8 ignore next 2 */
    /* istanbul ignore next -- HASHTAG_RE's group 1 is `(^|[^\w/])` which always captures (empty string at start of input), so m[1] is never undefined; the ?? '' arm is defensive. */
    const lead = m[1] ?? '';
    return [text(lead), el('ex-hashtag', { 'data-tag': m[2].toLowerCase(), 'data-value': `#${m[2]}` })];
  });

  // Persisted GIPHY picks use image-markdown syntax with a `giphy:<id>`
  // pseudo URL. Raw image/video URLs are intentionally left as literal
  // text: message markdown must not inject arbitrary media.
  tryMatch(IMAGE_RE, (m) => {
    if (m[2].startsWith('giphy:')) {
      const props: Record<string, unknown> = {
        'data-id': m[2].slice('giphy:'.length),
        'data-value': m[0],
      };
      if (m[3]) props['data-width'] = m[3];
      if (m[4]) props['data-height'] = m[4];
      return [el('ex-giphy', props)];
    }
    return [el('ex-media-literal', { 'data-value': m[0] })];
  });

  // link: [text](url). URL-scheme safety is enforced by the hydrator's
  // `a` component (same defense as the server-tree path), so the anchor
  // is emitted as-is here.
  tryMatch(LINK_RE, (m) => [el('a', { href: m[2] }, parseInline(m[1]))]);

  tryMatch(BOLD_RE, (m) => [el('strong', undefined, parseInline(m[1]))]);
  tryMatch(STRIKE_RE, (m) => [el('s', undefined, parseInline(m[1]))]);
  tryMatch(ITALIC_RE, (m) => [el('em', undefined, parseInline(m[1]))]);
  tryMatch(INLINE_CODE_RE, (m) => [el('code', undefined, [text(m[1])])]);

  // emoji :name::skin-tone-N: / :name: — resolution (custom map, unicode,
  // literal fallback) happens in the hydrator's ex-emoji-shortcode.
  tryMatch(EMOJI_SHORTCODE_TONED_RE, (m) => [
    el('ex-emoji-shortcode', { 'data-name': m[1], 'data-skin': m[2], 'data-value': m[0] }),
  ]);
  tryMatch(EMOJI_SHORTCODE_RE, (m) => [
    el('ex-emoji-shortcode', { 'data-name': m[1], 'data-value': m[0] }),
  ]);

  // bare URL — last so explicit links are already claimed.
  tryMatch(BARE_URL_RE, (m) => [el('ex-bare-url', { 'data-href': m[0], 'data-value': m[0] })]);

  return earliest;
}

function parseInline(src: string): HastNode[] {
  const out: HastNode[] = [];
  let cursor = 0;
  let safety = 0;
  while (cursor < src.length) {
    safety++;
    /* v8 ignore next 2 */ /* istanbul ignore next -- defensive runaway-loop guard: each iteration advances the cursor by at least one matched character, so reaching 10000 iterations would require a >10000-character single string with no progress, which the matcher never produces. */
    if (safety > 10000) break;
    const rest = src.slice(cursor);
    const match = findInline(rest);
    if (!match) {
      out.push(text(rest));
      break;
    }
    if (match.index > 0) out.push(text(rest.slice(0, match.index)));
    for (const n of match.nodes) {
      // Drop empty lead-text nodes (group mention / hashtag at line start).
      if (n.type === 'text' && n.value === '') continue;
      out.push(n);
    }
    cursor += match.index + match.length;
  }
  return out;
}

// --- GFM table support (mirrors the server's data-align emission) ---
const TABLE_DELIM_CELL_RE = /^:?-+:?$/;

function splitTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Escaped pipes aren't handled here (kept simple for the fallback); the
  // server renderer owns the full grammar.
  return s.split('|').map((c) => c.trim());
}

function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  // splitTableCells always yields at least one (possibly empty) cell, and an
  // empty cell fails TABLE_DELIM_CELL_RE, so `every` alone is sufficient.
  return splitTableCells(line).every((c) => TABLE_DELIM_CELL_RE.test(c));
}

// A table begins where a `|`-bearing header line is immediately followed by a
// delimiter row (|---|:--:|--:|).
function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i].includes('|') && isTableDelimiterRow(lines[i + 1]);
}

function tableAlign(cell: string): string {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function tableCell(tag: 'th' | 'td', content: string, align: string | undefined): HastNode {
  return el(tag, { 'data-align': align ?? 'left' }, parseInline(content));
}

// markdownToHast parses a message body into the server-shaped hast tree.
export function markdownToHast(body: string): HastNode {
  const lines = body.split('\n');
  const blocks: HastNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ATX heading: #, ##, …, ######
    const hMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (hMatch) {
      blocks.push(el(`h${hMatch[1].length}`, undefined, parseInline(hMatch[2])));
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(el('hr'));
      i++;
      continue;
    }

    // fenced code block — raw text child; the hydrator's CodeBlock adds
    // highlighting/gutter/copy, exactly like the server-tree path.
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j])) {
        buf.push(lines[j]);
        j++;
      }
      // The server always stamps data-language (empty string for a bare
      // fence) — CodeBlock maps unknown/empty to the "plain" label.
      const lang = fenceMatch[1]?.toLowerCase() ?? '';
      blocks.push(
        el('pre', { 'data-language': lang }, [
          el('code', undefined, [text(buf.join('\n'))]),
        ]),
      );
      i = j + 1;
      continue;
    }

    // blockquote — one paragraph with the quoted lines joined by \n (the
    // p renderer is whitespace-pre-wrap, so line breaks survive).
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        buf.push(lines[i].slice(2));
        i++;
      }
      blocks.push(el('blockquote', undefined, [el('p', undefined, parseInline(buf.join('\n')))]));
      continue;
    }

    // unordered list
    if (/^[-*] /.test(line)) {
      const items: HastNode[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(el('li', undefined, parseInline(lines[i].slice(2))));
        i++;
      }
      blocks.push(el('ul', undefined, items));
      continue;
    }

    // ordered list: "1. item", "2) item", etc.
    if (/^\d+[.)]\s+/.test(line)) {
      const items: HastNode[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(el('li', undefined, parseInline(lines[i].replace(/^\d+[.)]\s+/, ''))));
        i++;
      }
      blocks.push(el('ol', undefined, items));
      continue;
    }

    // GFM table: header row + delimiter row + body rows until a
    // blank/non-pipe line.
    if (isTableStart(lines, i)) {
      const headerCells = splitTableCells(line);
      const aligns = splitTableCells(lines[i + 1]).map(tableAlign);
      i += 2;
      const bodyRows: HastNode[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitTableCells(lines[i]).map((c, ci) => tableCell('td', c, aligns[ci]));
        bodyRows.push(el('tr', undefined, cells));
        i++;
      }
      const headRow = el(
        'tr',
        undefined,
        headerCells.map((c, ci) => tableCell('th', c, aligns[ci])),
      );
      const tableChildren = [el('thead', undefined, [headRow])];
      if (bodyRows.length > 0) tableChildren.push(el('tbody', undefined, bodyRows));
      blocks.push(el('table', undefined, tableChildren));
      continue;
    }

    // blank line — preserved as p[data-blank] (Slack/iMessage parity:
    // pressing Enter twice leaves a visible gap; each blank line stacks).
    if (line.trim() === '') {
      blocks.push(el('p', { 'data-blank': 'true' }, [text(' ')]));
      i++;
      continue;
    }

    // paragraph: collect consecutive non-special lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('> ') &&
      !/^[-*] /.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*(?:---|\*\*\*|___)\s*$/.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(el('p', undefined, parseInline(buf.join('\n'))));
  }

  return { type: 'root', children: blocks } as HastNode;
}
