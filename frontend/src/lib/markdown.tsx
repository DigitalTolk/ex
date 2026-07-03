import { Fragment, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { GiphyEmbed } from '@/components/GiphyEmbed';
import { highlightToHast, codeFenceLabel } from './code-highlight';
import {
  applySkinToneSuffix,
  shortcodeToUnicode,
  emojiGlyphClass,
  emojiImageClass,
  EMOJI_SHORTCODE_RE,
  EMOJI_SHORTCODE_TONED_RE,
} from './emoji-shortcodes';
import { USER_MENTION_RE, GROUP_MENTION_RE, CHANNEL_MENTION_RE } from './mention-syntax';
import { isSafeUrl } from './url-safety';
import type { HastNode } from '@/types';
import { renderHastTree } from './markdown-hast';

export interface RenderOpts {
  // Server-rendered hast tree. When set, renderMarkdown skips the
  // legacy regex parser entirely and just hydrates the tree with
  // React. Per-viewer behaviour still applies via the components
  // map (this same opts object is the closure).
  tree?: HastNode;
  emojiMap?: Record<string, string>;
  // currentUserId enables the "you" highlight on @-mentions that target
  // the viewer — same behaviour as Slack/Teams (yellow pill instead of
  // the default mute pill).
  currentUserId?: string;
  // renderUserMention wraps the rendered mention pill — typically with
  // UserHoverCard so hovering the @-name shows a profile popover.
  // When unset, the pill renders as a plain highlighted span.
  renderUserMention?: (
    userId: string,
    displayName: string,
    isSelf: boolean,
    pill: ReactNode,
  ) => ReactNode;
  // onTagClick turns `#tag` tokens into clickable buttons that surface
  // the tag-search side panel. Without it, hashtags render as plain text.
  onTagClick?: (tag: string) => void;
  onMediaLoad?: () => void;
  // Browser key for resolving persisted `giphy:<id>` references. The
  // saved message stores only the GIPHY ID; media URLs are fetched
  // directly from GIPHY on render.
  giphyAPIKey?: string;
  // largeEmoji renders emoji at double size ("jumbomoji") — set when the
  // whole message is nothing but emoji, à la Slack.
  largeEmoji?: boolean;
}

// The leading-char class excludes `/` so URL fragments like
// `/path#anchor` don't render as a hashtag pill. The body regex
// mirrors `internal/search/indexer.go` hashtagPattern.
const HASHTAG_RE = /(^|[^\w/])#([\p{L}\p{N}_-]{2,64})/u;
const FENCE_RE = /^```(\S+)?\s*$/;

const MENTION_PILL_BASE =
  'inline align-baseline rounded px-1 font-medium leading-[inherit] no-underline';
const MENTION_PILL_OTHER =
  ' bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary hover:no-underline';
// "You" mentions and group mentions (@all/@here) share the same amber
// highlight — both are calls to action that should stand out from the
// muted color used for ordinary user mentions.
const MENTION_PILL_HIGHLIGHT =
  ' bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-100';

function displayBareURL(url: string) {
  return url.startsWith('https://') ? url.slice('https://'.length) : url;
}

interface Match {
  index: number;
  length: number;
  node: ReactNode;
}

function findInline(src: string, opts: RenderOpts | undefined, keyPrefix: string): Match | null {
  let earliest: Match | null = null;
  const tryMatch = (re: RegExp, build: (m: RegExpExecArray) => ReactNode) => {
    const m = re.exec(src);
    if (!m) return;
    const idx = m.index;
    if (earliest === null || idx < earliest.index) {
      earliest = { index: idx, length: m[0].length, node: build(m) };
    }
  };

  // user mention: @[USER_ID|Display Name]
  // Must come before the link matcher so "@[id|name]" isn't mistaken for
  // "@" followed by a [link](url).
  tryMatch(USER_MENTION_RE, (m) => {
    const userId = m[1].trim();
    const name = m[2].trim();
    const isSelf = !!opts?.currentUserId && opts.currentUserId === userId;
    const pill = (
      <span
        key={`${keyPrefix}-mu-${m.index}`}
        data-testid="mention-pill"
        data-mention-user-id={userId}
        data-mention-self={isSelf ? 'true' : 'false'}
        className={MENTION_PILL_BASE + (isSelf ? MENTION_PILL_HIGHLIGHT : MENTION_PILL_OTHER)}
      >
        @{name}
      </span>
    );
    if (opts?.renderUserMention) {
      // Wrap in a keyed Fragment — the caller's wrapper element may
      // not carry a key, and the rendered node lands in an array
      // (renderInlineString.out) where React expects per-child keys.
      return (
        <Fragment key={`${keyPrefix}-mu-${m.index}`}>
          {opts.renderUserMention(userId, name, isSelf, pill)}
        </Fragment>
      );
    }
    return pill;
  });

  // channel mention: ~[CHANNEL_ID|slug] → clickable pill that navigates.
  // Channels are addressed by slug in URLs but the ID survives renames so
  // we route by ID and let the route resolver redirect.
  tryMatch(CHANNEL_MENTION_RE, (m) => {
    const slug = m[2].trim();
    return (
      <a
        key={`${keyPrefix}-mc-${m.index}`}
        href={`/channel/${slug}`}
        data-testid="channel-mention-pill"
        data-channel-id={m[1].trim()}
        className={MENTION_PILL_BASE + MENTION_PILL_OTHER}
      >
        ~{slug}
      </a>
    );
  });

  tryMatch(GROUP_MENTION_RE, (m) => {
    /* istanbul ignore next -- GROUP_MENTION_RE's group 1 is `(^|[^\w@])` which always captures (empty string at start of input), so m[1] is never undefined; the ?? '' arm is defensive. */
    const lead = m[1] ?? '';
    return (
      <span key={`${keyPrefix}-mg-${m.index}`}>
        {lead}
        <span
          data-testid="mention-pill"
          data-mention-group={m[2]}
          className={MENTION_PILL_BASE + MENTION_PILL_HIGHLIGHT}
        >
          @{m[2]}
        </span>
      </span>
    );
  });

  // hashtag: #tag — only when an onTagClick handler is wired.
  if (opts?.onTagClick) {
    tryMatch(HASHTAG_RE, (m) => {
      /* istanbul ignore next -- HASHTAG_RE's group 1 is `(^|[^\w/])` which always captures (empty string at start of input), so m[1] is never undefined; the ?? '' arm is defensive. */
      const lead = m[1] ?? '';
      const tag = m[2];
      return (
        <span key={`${keyPrefix}-tag-${m.index}`}>
          {lead}
          <button
            type="button"
            data-testid="hashtag-pill"
            data-tag={tag.toLowerCase()}
            onClick={() => opts.onTagClick?.(tag.toLowerCase())}
            className={MENTION_PILL_BASE + MENTION_PILL_OTHER + ' cursor-pointer'}
          >
            #{tag}
          </button>
        </span>
      );
    });
  }

  // Persisted GIPHY picks use image-markdown syntax with a `giphy:<id>`
  // pseudo URL. Raw image/video URLs are intentionally left as literal
  // text: message markdown should not be able to inject arbitrary media.
  tryMatch(/!\[([^\]]*)\]\(([^)\s]+?)(?:\s+=(\d+)x(\d+))?\)/, (m) => {
    if (m[2].startsWith('giphy:')) {
      return (
        <GiphyEmbed
          key={`${keyPrefix}-giphy-${m.index}`}
          id={m[2].slice('giphy:'.length)}
          width={m[3] ? Number(m[3]) : undefined}
          height={m[4] ? Number(m[4]) : undefined}
          apiKey={opts?.giphyAPIKey}
          onMediaLoad={opts?.onMediaLoad}
        />
      );
    }
    return <span key={`${keyPrefix}-media-literal-${m.index}`}>{m[0]}</span>;
  });

  // link: [text](url) — reject unsafe schemes (javascript:, data:, …) so this
  // fallback path matches the server HAST renderer's isSafeUrl guard; an unsafe
  // link renders as its literal source text instead of a clickable href.
  tryMatch(/\[([^\]]+)\]\(([^)\s]+)\)/, (m) =>
    isSafeUrl(m[2]) ? (
      <a
        key={`${keyPrefix}-a-${m.index}`}
        href={m[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link transition-colors hover:text-link/80"
      >
        {m[1]}
      </a>
    ) : (
      <span key={`${keyPrefix}-a-${m.index}`}>{m[0]}</span>
    ),
  );

  // bold: **text**
  tryMatch(/\*\*([^*]+)\*\*/, (m) => (
    <strong key={`${keyPrefix}-b-${m.index}`}>
      {renderInlineString(m[1], opts, `${keyPrefix}-b-${m.index}`)}
    </strong>
  ));

  // strikethrough: ~~text~~
  tryMatch(/~~([^~]+)~~/, (m) => (
    <s key={`${keyPrefix}-s-${m.index}`}>
      {renderInlineString(m[1], opts, `${keyPrefix}-s-${m.index}`)}
    </s>
  ));

  // italic: *text*  (no spaces directly inside)
  tryMatch(/\*([^*\n]+)\*/, (m) => (
    <em key={`${keyPrefix}-i-${m.index}`}>
      {renderInlineString(m[1], opts, `${keyPrefix}-i-${m.index}`)}
    </em>
  ));

  // inline code: `code`
  tryMatch(/`([^`\n]+)`/, (m) => (
    <code key={`${keyPrefix}-c-${m.index}`} className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
      {m[1]}
    </code>
  ));

  // emoji :name: — try custom map first, then standard shortcode unicode,
  // otherwise render the literal :name:. Body emojis render at ~1.4em
  // (Slack-style) so they're legible without dwarfing the line and so
  // they scale with the surrounding font-size when used inside headings
  // (`# title :tada:` keeps the emoji proportional to the H1 text).
  // align-middle (not align-text-bottom) centers the glyph on the text's
  // x-height so it sits visually balanced inside paragraphs and lists.
  tryMatch(EMOJI_SHORTCODE_TONED_RE, (m) => {
    const name = m[1];
    const unicode = shortcodeToUnicode(`:${name}:`);
    if (unicode !== `:${name}:`) {
      return (
        <span
          key={`${keyPrefix}-eu-${m.index}`}
          title={`:${name}::${m[2]}:`}
          className={emojiGlyphClass(opts?.largeEmoji)}
        >
          {applySkinToneSuffix(unicode, m[2])}
        </span>
      );
    }
    return <span key={`${keyPrefix}-eu-${m.index}`}>{m[0]}</span>;
  });

  tryMatch(EMOJI_SHORTCODE_RE, (m) => {
    const name = m[1];
    const url = opts?.emojiMap?.[name];
    if (url) {
      return (
        <img
          key={`${keyPrefix}-e-${m.index}`}
          src={url}
          alt={`:${name}:`}
          title={`:${name}:`}
          className={emojiImageClass(opts?.largeEmoji)}
        />
      );
    }
    const unicode = shortcodeToUnicode(`:${name}:`);
    if (unicode !== `:${name}:`) {
      return (
        <span
          key={`${keyPrefix}-eu-${m.index}`}
          title={`:${name}:`}
          className={emojiGlyphClass(opts?.largeEmoji)}
        >
          {unicode}
        </span>
      );
    }
    return <span key={`${keyPrefix}-eu-${m.index}`}>{`:${name}:`}</span>;
  });

  // bare URL
  tryMatch(/https?:\/\/[^\s<>"]+/, (m) => (
    <a
      key={`${keyPrefix}-u-${m.index}`}
      href={m[0]}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link transition-colors hover:text-link/80"
    >
      {displayBareURL(m[0])}
    </a>
  ));

  return earliest;
}

function renderInlineString(src: string, opts: RenderOpts | undefined, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let safety = 0;
  while (cursor < src.length) {
    safety++;
    /* istanbul ignore next -- defensive runaway-loop guard: each iteration advances the cursor by at least one matched character, so reaching 10000 iterations would require a >10000-character single string with no progress, which the matcher never produces. */
    if (safety > 10000) break;
    const rest = src.slice(cursor);
    const match = findInline(rest, opts, `${keyPrefix}-${cursor}`);
    if (!match) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    out.push(match.node);
    cursor += match.index + match.length;
  }
  return out;
}

// --- GFM table support for the legacy fallback / compose-preview parser ---
// The authoritative render is the server hast tree; this mirrors it so a table
// looks the same in the live compose preview and in older tree-less messages.
const TABLE_DELIM_CELL_RE = /^:?-+:?$/;

function splitTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Escaped pipes aren't handled here (kept simple for the preview); the server
  // renderer owns the full grammar.
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

function tableAlignClass(cell: string): string {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'text-center';
  if (right) return 'text-right';
  return 'text-left';
}

// renderMarkdown is the public render entry point.
//
// Two paths:
//   1. Server-rendered hast tree (preferred). Backend pre-parses
//      every message body to hast and ships it on the message API
//      response. Frontend just hydrates with React via the
//      hast-util-to-jsx-runtime path. No regex parser per render.
//   2. Legacy regex parser fallback. Used when `tree` is missing
//      (older messages, draft compose preview, intermediate code
//      paths that pass only a body string).
//
// Per-viewer behaviour (self-mention pill, hashtag click handler,
// renderUserMention wrapper, custom emoji map, GIPHY API key) is
// applied at the React-component level in BOTH paths — the server
// emits viewer-agnostic ex-* sentinel tags and the components map
// closes over `opts` to render them.
export function renderMarkdown(body: string, opts?: RenderOpts): ReactNode {
  // Tree path: drop straight into hast→React with no parsing cost.
  if (opts?.tree) return renderHastTree(opts.tree, opts);
  if (!body) return null;
  const lines = body.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ATX heading: #, ##, ###, ####, #####, ######
    const hMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = hMatch[2];
      const sizeCls = (
        {
          1: 'text-2xl font-bold mt-3 mb-2',
          2: 'text-xl font-bold mt-3 mb-1.5',
          3: 'text-lg font-semibold mt-2 mb-1',
          4: 'text-base font-semibold mt-2 mb-1',
          5: 'text-sm font-semibold mt-1.5 mb-0.5',
          6: 'text-xs font-semibold uppercase tracking-wide mt-1 mb-0.5 text-muted-foreground',
        } as const
      )[level];
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={`bk-${blockKey++}`} className={sizeCls}>
          {renderInlineString(text, opts, `h-${blockKey}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={`bk-${blockKey++}`} className="my-3 border-muted" />);
      i++;
      continue;
    }

    // fenced code block
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j])) {
        buf.push(lines[j]);
        j++;
      }
      const rawLanguage = fenceMatch[1]?.toLowerCase();
      const code = buf.join('\n');
      // Highlight with the SAME engine as messages (lowlight). An unsupported or
      // absent fence → null → plain text, labelled "plain". Compact: no gutter
      // or copy button (that chrome lives in CodeBlock, for the message list).
      const tree = highlightToHast(code, rawLanguage);
      blocks.push(
        <pre
          key={`bk-${blockKey++}`}
          className="my-0 overflow-x-auto rounded-md bg-muted p-2 text-xs font-mono"
          data-language={codeFenceLabel(rawLanguage)}
        >
          <code className={tree ? 'hljs' : undefined}>
            {tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : code}
          </code>
        </pre>,
      );
      i = j + 1;
      continue;
    }

    // blockquote
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        buf.push(lines[i].slice(2));
        i++;
      }
      const bqKey = blockKey++;
      blocks.push(
        <blockquote key={`bk-${bqKey}`} className="my-1 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
          {buf.map((bqLine, idx) => (
            <div key={idx}>{renderInlineString(bqLine, opts, `bq-${bqKey}-${idx}`)}</div>
          ))}
        </blockquote>,
      );
      continue;
    }

    // unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <ul key={`bk-${blockKey++}`} className="my-1 list-disc pl-5 space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInlineString(it, opts, `li-${blockKey}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ordered list: "1. item", "2) item", etc.
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={`bk-${blockKey++}`} className="my-1 list-decimal pl-5 space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInlineString(it, opts, `oli-${blockKey}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // GFM table: header row + delimiter row + body rows until a blank/non-pipe
    // line. Mirrors the server hast renderer's table output + styling.
    if (isTableStart(lines, i)) {
      const headerCells = splitTableCells(line);
      const alignCls = splitTableCells(lines[i + 1]).map(tableAlignClass);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitTableCells(lines[i]));
        i++;
      }
      const tKey = blockKey++;
      blocks.push(
        <div key={`bk-${tKey}`} className="my-2 max-w-full overflow-x-auto">
          <table className="w-auto border-collapse text-sm">
            <thead className="bg-muted">
              <tr className="border-b border-border last:border-b-0">
                {headerCells.map((cell, ci) => (
                  <th
                    key={ci}
                    className={`border border-border px-2 py-1 font-semibold ${alignCls[ci] ?? 'text-left'}`}
                  >
                    {renderInlineString(cell, opts, `th-${tKey}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            {bodyRows.length > 0 && (
              <tbody>
                {bodyRows.map((cells, ri) => (
                  <tr key={ri} className="border-b border-border last:border-b-0">
                    {cells.map((cell, ci) => (
                      <td
                        key={ci}
                        className={`border border-border px-2 py-1 align-top ${alignCls[ci] ?? 'text-left'}`}
                      >
                        {renderInlineString(cell, opts, `td-${tKey}-${ri}-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>,
      );
      continue;
    }

    // blank line — preserve as a literal empty line in the rendered
    // output. Slack/iMessage parity: pressing Enter twice in the
    // composer leaves a visible gap, not a paragraph collapse.
    // Each consecutive blank line stacks an additional gap.
    if (line.trim() === '') {
      // `data-blank` mirrors the server-side hast renderer's marker so
      // the `.prose-message` CSS rule in index.css can give the empty
      // paragraph an explicit min-height; otherwise Tailwind's preflight
      // zeroes the <p>'s margin and the gap collapses.
      blocks.push(
        <p key={`bk-${blockKey++}`} data-blank="true" className="leading-snug">
          {' '}
        </p>,
      );
      i++;
      continue;
    }

    // paragraph: collect consecutive non-special lines
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
    const inline = renderInlineString(buf.join('\n'), opts, `p-${blockKey}`);
    blocks.push(
      <p key={`bk-${blockKey++}`} className="whitespace-pre-wrap break-words">
        {inline}
      </p>,
    );
  }

  return <>{blocks}</>;
}
