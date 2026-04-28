import type { ReactNode } from 'react';
import { shortcodeToUnicode } from './emoji-shortcodes';
import { USER_MENTION_RE, GROUP_MENTION_RE, CHANNEL_MENTION_RE } from './mention-syntax';

export interface RenderOpts {
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
}

const MENTION_PILL_BASE =
  'inline-block rounded px-1 text-sm font-medium leading-tight';
const MENTION_PILL_OTHER =
  ' bg-primary/10 text-primary hover:bg-primary/20';
// "You" mentions and group mentions (@all/@here) share the same amber
// highlight — both are calls to action that should stand out from the
// muted color used for ordinary user mentions.
const MENTION_PILL_HIGHLIGHT =
  ' bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-100';

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
      return opts.renderUserMention(userId, name, isSelf, pill);
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

  // image: ![alt](url)
  tryMatch(/!\[([^\]]*)\]\(([^)\s]+)\)/, (m) => (
    <img
      key={`${keyPrefix}-img-${m.index}`}
      src={m[2]}
      alt={m[1] || ''}
      className="my-1 max-h-80 max-w-full rounded-md border"
      loading="lazy"
    />
  ));

  // link: [text](url)
  tryMatch(/\[([^\]]+)\]\(([^)\s]+)\)/, (m) => (
    <a
      key={`${keyPrefix}-a-${m.index}`}
      href={m[2]}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline"
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
    <code key={`${keyPrefix}-c-${m.index}`} className="rounded bg-muted px-1 py-0.5 text-[0.85em] font-mono">
      {m[1]}
    </code>
  ));

  // emoji :name: — try custom map first, then standard shortcode unicode,
  // otherwise render the literal :name:.
  tryMatch(/:([a-z0-9_+-]+):/i, (m) => {
    const name = m[1];
    const url = opts?.emojiMap?.[name];
    if (url) {
      return (
        <img
          key={`${keyPrefix}-e-${m.index}`}
          src={url}
          alt={`:${name}:`}
          title={`:${name}:`}
          className="inline-block h-3.5 w-3.5 align-text-bottom"
        />
      );
    }
    const unicode = shortcodeToUnicode(`:${name}:`);
    if (unicode !== `:${name}:`) {
      return <span key={`${keyPrefix}-eu-${m.index}`} title={`:${name}:`}>{unicode}</span>;
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
      className="text-primary underline"
    >
      {m[0]}
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

export function renderMarkdown(body: string, opts?: RenderOpts): ReactNode {
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
    if (line.startsWith('```')) {
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('```')) {
        buf.push(lines[j]);
        j++;
      }
      blocks.push(
        <pre key={`bk-${blockKey++}`} className="my-2 overflow-x-auto rounded-md bg-muted p-2 text-xs font-mono">
          <code>{buf.join('\n')}</code>
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
      blocks.push(
        <blockquote key={`bk-${blockKey++}`} className="my-1 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
          {renderInlineString(buf.join('\n'), opts, `bq-${blockKey}`)}
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

    // blank line
    if (line.trim() === '') {
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

