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

// An inline token kind: its pattern and how a match becomes nodes. Kinds are
// tried in this order, so an earlier one wins a tie at the same position —
// the server's splitTokens precedence (explicit syntax claims text before
// looser matchers like bare URLs).
interface InlineKind {
  // A global copy of the pattern, searched from any position in the text.
  re: RegExp;
  // For the two patterns that open with `(^|lead)`: the token with no lead,
  // tried exactly at the cursor (a sticky copy). The text used to be cut at
  // the cursor before every search, which is where `^` matched.
  atCursor?: RegExp;
  build: (m: RegExpExecArray) => HastNode[];
}

function kind(re: RegExp, build: (m: RegExpExecArray) => HastNode[]): InlineKind {
  return { re: new RegExp(re.source, `${re.flags}g`), build };
}

// leadKind splits a `(^|lead)token` pattern into the lead form, searched
// anywhere, and the bare token at the cursor, whose empty first group stands
// for the `^` lead.
function leadKind(re: RegExp, build: (m: RegExpExecArray) => HastNode[]): InlineKind {
  return {
    re: new RegExp(re.source.replace(/^\(\^\|/, '('), `${re.flags}g`),
    atCursor: new RegExp(re.source.replace(/^\(\^\|[^)]*\)/, '()'), `${re.flags}y`),
    build,
  };
}

const INLINE_KINDS: InlineKind[] = [
  // user mention: @[USER_ID|Display Name] — before the link matcher so
  // "@[id|name]" isn't mistaken for "@" followed by a [link](url).
  kind(USER_MENTION_RE, (m) => [
    el('ex-mention-user', {
      'data-user-id': m[1].trim(),
      'data-name': m[2].trim(),
      'data-value': m[0],
    }),
  ]),

  // channel mention: ~[CHANNEL_ID|slug]
  kind(CHANNEL_MENTION_RE, (m) => [
    el('ex-mention-channel', {
      'data-channel-id': m[1].trim(),
      'data-slug': m[2].trim(),
      'data-value': m[0],
    }),
  ]),

  // group mention: @all / @here — group 1 is the lead char kept as text.
  leadKind(GROUP_MENTION_RE, (m) => [text(m[1]), el('ex-mention-group', { 'data-group': m[2], 'data-value': `@${m[2]}` })]),

  // hashtag: #tag — emitted unconditionally like the server; the
  // hydrator renders plain text when no onTagClick handler is wired.
  leadKind(HASHTAG_RE, (m) => [text(m[1]), el('ex-hashtag', { 'data-tag': m[2].toLowerCase(), 'data-value': `#${m[2]}` })]),

  // Persisted GIPHY picks use image-markdown syntax with a `giphy:<id>`
  // pseudo URL. Raw image/video URLs are intentionally left as literal
  // text: message markdown must not inject arbitrary media.
  kind(IMAGE_RE, (m) => {
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
  }),

  // link: [text](url). URL-scheme safety is enforced by the hydrator's
  // `a` component (same defense as the server-tree path), so the anchor
  // is emitted as-is here.
  kind(LINK_RE, (m) => [el('a', { href: m[2] }, parseInline(m[1]))]),

  kind(BOLD_RE, (m) => [el('strong', undefined, parseInline(m[1]))]),
  kind(STRIKE_RE, (m) => [el('s', undefined, parseInline(m[1]))]),
  kind(ITALIC_RE, (m) => [el('em', undefined, parseInline(m[1]))]),
  kind(INLINE_CODE_RE, (m) => [el('code', undefined, [text(m[1])])]),

  // emoji :name::skin-tone-N: / :name: — resolution (custom map, unicode,
  // literal fallback) happens in the hydrator's ex-emoji-shortcode.
  kind(EMOJI_SHORTCODE_TONED_RE, (m) => [
    el('ex-emoji-shortcode', { 'data-name': m[1], 'data-skin': m[2], 'data-value': m[0] }),
  ]),
  kind(EMOJI_SHORTCODE_RE, (m) => [el('ex-emoji-shortcode', { 'data-name': m[1], 'data-value': m[0] })]),

  // bare URL — last so explicit links are already claimed.
  kind(BARE_URL_RE, (m) => [el('ex-bare-url', { 'data-href': m[0], 'data-value': m[0] })]),
];

// parseInline turns a run of text into inline nodes, always taking the
// EARLIEST token of any kind next.
//
// In time proportional to the text: each kind's next match is remembered and
// only searched for again once the cursor has passed it. None of the
// patterns look behind, so a match found from an earlier position stays the
// earliest one at or after the cursor — except at the cursor itself, where a
// `(^|lead)` pattern's bare form is tried afresh every step. Searching every
// kind again over the whole rest of the text for every token, as this used
// to, froze the window on long messages in search results.
function parseInline(src: string): HastNode[] {
  const out: HastNode[] = [];
  const next: (RegExpExecArray | null | undefined)[] = new Array(INLINE_KINDS.length);
  let cursor = 0;
  while (cursor < src.length) {
    let match: RegExpExecArray | null = null;
    let matchKind = INLINE_KINDS[0];
    for (let i = 0; i < INLINE_KINDS.length; i++) {
      const k = INLINE_KINDS[i];
      let m: RegExpExecArray | null = null;
      if (k.atCursor) {
        k.atCursor.lastIndex = cursor;
        m = k.atCursor.exec(src);
      }
      if (!m) {
        let found = next[i];
        if (found === undefined || (found !== null && found.index < cursor)) {
          k.re.lastIndex = cursor;
          found = k.re.exec(src);
          next[i] = found;
        }
        m = found;
      }
      if (m && (match === null || m.index < match.index)) {
        match = m;
        matchKind = k;
      }
    }
    if (match === null) {
      out.push(text(src.slice(cursor)));
      break;
    }
    if (match.index > cursor) out.push(text(src.slice(cursor, match.index)));
    for (const n of matchKind.build(match)) {
      // Drop empty lead-text nodes (group mention / hashtag at line start).
      if (n.type === 'text' && n.value === '') continue;
      out.push(n);
    }
    // Every token is at least one character long, so the cursor always moves.
    cursor = match.index + match[0].length;
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
