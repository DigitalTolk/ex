import { Fragment, type ReactNode } from 'react';
import { GiphyEmbed } from '@/components/GiphyEmbed';
import {
  applySkinToneSuffix,
  shortcodeToUnicode,
  emojiGlyphClass,
  emojiImageClass,
  EMOJI_SHORTCODE_RE,
  EMOJI_SHORTCODE_TONED_RE,
} from './emoji-shortcodes';
import { USER_MENTION_RE, GROUP_MENTION_RE, CHANNEL_MENTION_RE } from './mention-syntax';
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

function codeLanguageClass(language: string | undefined) {
  if (!language) return '';
  return ` language-${normalizeCodeLanguage(language)}`;
}

function normalizeCodeLanguage(language: string) {
  const lowered = language.toLowerCase();
  const aliases: Record<string, string> = {
    'c++': 'cpp',
    'c#': 'csharp',
    'f#': 'fsharp',
    js: 'javascript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash',
    ts: 'typescript',
  };
  return aliases[lowered] ?? lowered.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

const COMMON_CODE_KEYWORDS = new Set([
  'and', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'defer', 'do', 'echo', 'else', 'elseif', 'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for',
  'foreach', 'from', 'func', 'function', 'global', 'go', 'if', 'import', 'in', 'interface', 'let', 'match',
  'module', 'namespace', 'new', 'nil', 'none', 'not', 'null', 'or', 'package', 'private', 'protected',
  'public', 'return', 'select', 'self', 'static', 'struct', 'switch', 'then', 'this', 'throw', 'trait',
  'true', 'try', 'type', 'use', 'var', 'while', 'with', 'yield',
]);

const LANGUAGE_KEYWORDS: Record<string, Set<string>> = {
  bash: new Set(['case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'then', 'while']),
  c: new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while']),
  cpp: new Set(['auto', 'bool', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'false', 'float', 'for', 'if', 'include', 'int', 'namespace', 'new', 'nullptr', 'private', 'protected', 'public', 'return', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typename', 'using', 'virtual', 'void', 'while']),
  csharp: new Set(['abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delegate', 'do', 'else', 'enum', 'event', 'false', 'finally', 'for', 'foreach', 'if', 'interface', 'internal', 'is', 'namespace', 'new', 'null', 'override', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'using', 'var', 'virtual', 'void', 'while']),
  css: new Set(['important', 'media', 'supports']),
  go: new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'nil', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']),
  hcl: new Set(['data', 'dynamic', 'for_each', 'locals', 'module', 'output', 'provider', 'resource', 'terraform', 'variable']),
  ini: new Set(['false', 'no', 'off', 'on', 'true', 'yes']),
  java: new Set(['abstract', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'implements', 'import', 'instanceof', 'interface', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'throws', 'true', 'try', 'void', 'while']),
  javascript: new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield']),
  json: new Set(['false', 'null', 'true']),
  kotlin: new Set(['as', 'break', 'by', 'catch', 'class', 'companion', 'continue', 'data', 'do', 'else', 'false', 'for', 'fun', 'if', 'import', 'in', 'interface', 'is', 'null', 'object', 'package', 'private', 'protected', 'public', 'return', 'sealed', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'val', 'var', 'when', 'while']),
  php: new Set(['abstract', 'array', 'as', 'catch', 'class', 'echo', 'else', 'elseif', 'extends', 'final', 'finally', 'foreach', 'function', 'implements', 'interface', 'namespace', 'new', 'private', 'protected', 'public', 'return', 'static', 'throw', 'trait', 'try', 'use']),
  python: new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'false', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'none', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'true', 'try', 'while', 'with', 'yield']),
  ruby: new Set(['alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined', 'do', 'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield']),
  rust: new Set(['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while']),
  sql: new Set(['alter', 'and', 'as', 'by', 'case', 'create', 'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'from', 'group', 'having', 'in', 'insert', 'into', 'is', 'join', 'left', 'limit', 'not', 'null', 'on', 'or', 'order', 'right', 'select', 'set', 'table', 'then', 'update', 'values', 'when', 'where']),
  swift: new Set(['as', 'associatedtype', 'break', 'case', 'catch', 'class', 'continue', 'defer', 'do', 'else', 'enum', 'extension', 'false', 'for', 'func', 'guard', 'if', 'import', 'in', 'init', 'let', 'nil', 'private', 'protocol', 'public', 'return', 'self', 'static', 'struct', 'switch', 'throw', 'true', 'try', 'typealias', 'var', 'where', 'while']),
  typescript: new Set(['abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'number', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'string', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield']),
  yaml: new Set(['false', 'no', 'null', 'off', 'on', 'true', 'yes']),
};

const CODE_TOKEN_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\$[A-Za-z_][\w-]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w-]*\b/g;

function codeTokenClass(token: string, language: string) {
  if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*')) {
    return 'text-muted-foreground italic';
  }
  if (/^["'`]/.test(token)) return 'text-emerald-700 dark:text-emerald-300';
  if (token.startsWith('$')) return 'text-sky-700 dark:text-sky-300';
  if (/^\d/.test(token)) return 'text-amber-700 dark:text-amber-300';
  const lowered = token.toLowerCase();
  if ((LANGUAGE_KEYWORDS[language] ?? COMMON_CODE_KEYWORDS).has(lowered) || COMMON_CODE_KEYWORDS.has(lowered)) {
    return 'text-purple-700 dark:text-purple-300';
  }
  return null;
}

function renderCodeString(src: string, language: string | undefined, keyPrefix: string): ReactNode {
  if (!language) return src;
  const normalizedLanguage = normalizeCodeLanguage(language);
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const match of src.matchAll(CODE_TOKEN_RE)) {
    const token = match[0];
    /* istanbul ignore next -- String.matchAll always populates match.index; the ?? 0 fallback is defensive. */
    const index = match.index ?? 0;
    if (index > cursor) out.push(src.slice(cursor, index));
    const className = codeTokenClass(token, normalizedLanguage);
    out.push(className
      ? <span key={`${keyPrefix}-${index}`} className={className}>{token}</span>
      : token);
    cursor = index + token.length;
  }
  if (cursor < src.length) out.push(src.slice(cursor));
  return out.length ? out : src;
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

  // link: [text](url)
  tryMatch(/\[([^\]]+)\]\(([^)\s]+)\)/, (m) => (
    <a
      key={`${keyPrefix}-a-${m.index}`}
      href={m[2]}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link transition-colors hover:text-link/80"
    >
      {m[1]}
    </a>
  ));

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
      const language = fenceMatch[1]?.toLowerCase();
      blocks.push(
        <pre
          key={`bk-${blockKey++}`}
          className="my-0 overflow-x-auto rounded-md bg-muted p-2 text-xs font-mono"
          data-language={language}
        >
          <code className={codeLanguageClass(language)}>
            {renderCodeString(buf.join('\n'), language, `code-${blockKey}`)}
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
      !/^\s*(?:---|\*\*\*|___)\s*$/.test(lines[i])
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
