import { memo, type ReactNode } from 'react';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { formatDate } from '@/lib/block-text';
import { MENTION_PILL_BASE, MENTION_PILL_HIGHLIGHT, MENTION_PILL_OTHER } from '@/lib/markdown-hast';
import { externalHref, isSafeUrl } from '@/lib/url-safety';
import { cn } from '@/lib/utils';
import type { Block, RichColor, RichItem, RichNode, RichSpan } from '@/types';
import { useBlockScope } from './blockScope';

// RichText draws an app's rich_text block: paragraphs, headings, lists,
// quotes and code built from styled pieces. Everything is plain React — no
// HTML from the app is ever injected — and colours are palette names mapped
// to theme tokens, so an app can't style ex beyond the palette. The server
// checked every piece; the client still refuses an unsafe link.
//
// The text renders at its final size on first paint (code included: the
// highlighter only recolours), so the virtualized list measures the row once.

// Whole class names per colour, so Tailwind finds each one in the source.
const TEXT_COLOR: Record<RichColor, string> = {
  gray: 'text-rt-gray',
  brown: 'text-rt-brown',
  orange: 'text-rt-orange',
  yellow: 'text-rt-yellow',
  green: 'text-rt-green',
  blue: 'text-rt-blue',
  purple: 'text-rt-purple',
  red: 'text-rt-red',
};

const TINT: Record<RichColor, string> = {
  gray: 'bg-rt-gray-bg',
  brown: 'bg-rt-brown-bg',
  orange: 'bg-rt-orange-bg',
  yellow: 'bg-rt-yellow-bg',
  green: 'bg-rt-green-bg',
  blue: 'bg-rt-blue-bg',
  purple: 'bg-rt-purple-bg',
  red: 'bg-rt-red-bg',
};

const HEADING: Record<1 | 2 | 3, string> = {
  1: 'text-lg font-semibold leading-snug',
  2: 'text-base font-semibold leading-snug',
  3: 'text-sm font-semibold',
};

export const RichText = memo(function RichText({ content }: { content: RichNode[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm break-words" data-testid="block-rich-text">
      {content.map((node, index) => (
        <RichPart key={index} node={node} />
      ))}
    </div>
  );
});

function RichPart({ node }: { node: RichNode }) {
  switch (node.type) {
    case 'heading':
      // Below the page's own headings: a message sits inside a channel view.
      return (
        <div role="heading" aria-level={node.level + 2} className={HEADING[node.level]}>
          <Spans spans={node.spans} />
        </div>
      );
    case 'paragraph':
      return (
        <p className="whitespace-pre-wrap">
          <Spans spans={node.spans} />
        </p>
      );
    case 'quote':
      return (
        <blockquote className="border-l-2 border-border-strong pl-3 whitespace-pre-wrap text-secondary-foreground">
          <Spans spans={node.spans} />
        </blockquote>
      );
    case 'list':
      return <RichList ordered={node.style === 'ordered'} items={node.items} />;
    case 'code':
      return <CodeBlock code={node.text} language={node.language} />;
  }
}

function RichList({ ordered, items }: { ordered: boolean; items: RichItem[] }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={cn('space-y-0.5 pl-5', ordered ? 'list-decimal' : 'list-disc')}>
      {items.map((item, index) => (
        <li key={index} className="whitespace-pre-wrap">
          {item.spans && <Spans spans={item.spans} />}
          {item.items?.length ? <RichList ordered={ordered} items={item.items} /> : null}
        </li>
      ))}
    </Tag>
  );
}

// Spans draws inline pieces. inert draws links and channel mentions as plain
// text, for places that are themselves a control (a toggle's summary).
export function Spans({ spans, inert = false }: { spans: RichSpan[]; inert?: boolean }) {
  return (
    <>
      {spans.map((span, index) => (
        <Span key={index} span={span} inert={inert} />
      ))}
    </>
  );
}

function Span({ span, inert }: { span: RichSpan; inert: boolean }) {
  switch (span.type) {
    case 'text':
      return <TextSpan span={span} inert={inert} />;
    case 'user':
      return <UserMention userID={span.user} name={span.name} />;
    case 'channel':
      if (inert) return <span className={MENTION_PILL_BASE + MENTION_PILL_OTHER}>~{span.name}</span>;
      return (
        <a
          // The slug is data: encoded, it can only ever name one path segment.
          href={`/channel/${encodeURIComponent(span.name)}`}
          data-testid="channel-mention-pill"
          className={MENTION_PILL_BASE + MENTION_PILL_OTHER}
        >
          ~{span.name}
        </a>
      );
    case 'emoji':
      return <EmojiGlyph emoji={`:${span.name}:`} />;
    case 'date':
      return <span>{formatDate(span.timestamp, span.format) ?? span.fallback ?? ''}</span>;
    case 'pill':
      return (
        <span data-testid="rich-pill" className={cn('inline-block rounded-full px-1.5 text-xs font-medium leading-5', TINT[span.color], TEXT_COLOR[span.color])}>
          {span.text}
        </span>
      );
  }
}

function TextSpan({ span, inert }: { span: Extract<RichSpan, { type: 'text' }>; inert: boolean }) {
  const content: ReactNode = span.code ? <code className="rounded bg-muted px-1 font-mono">{span.text}</code> : span.text;
  // Joined, not merged: tailwind-merge reads underline and line-through as
  // rivals and would drop one. Both at once need one rule naming both lines.
  const style = [
    span.bold && 'font-semibold',
    span.italic && 'italic',
    span.strike && span.underline
      ? '[text-decoration-line:underline_line-through] underline-offset-2'
      : (span.strike && 'line-through') || (span.underline && 'underline underline-offset-2'),
    span.color && TEXT_COLOR[span.color],
    span.highlight && `${TINT[span.highlight]} rounded-sm px-0.5`,
  ]
    .filter(Boolean)
    .join(' ');
  const href = span.link && !inert ? richHref(span.link) : undefined;
  if (href) {
    // The app's colour, when it chose one, wins over the link colour.
    const linkStyle = span.color ? 'underline-offset-2 hover:underline' : 'text-link underline-offset-2 hover:underline';
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={`${linkStyle} ${style}`.trim()}>
        {content}
      </a>
    );
  }
  return style ? <span className={style}>{content}</span> : <>{content}</>;
}

// richHref is a link's address when it is safe to open: http(s), or mailto.
function richHref(raw: string): string | undefined {
  return externalHref(raw) ?? (/^mailto:/i.test(raw) && isSafeUrl(raw) ? raw : undefined);
}

// A mention of the reader is highlighted, like one in markdown.
function UserMention({ userID, name }: { userID: string; name: string }) {
  const isSelf = useBlockScope()?.currentUserId === userID;
  return (
    <span
      data-testid="mention-pill"
      data-mention-user-id={userID}
      data-mention-self={isSelf ? 'true' : 'false'}
      className={MENTION_PILL_BASE + (isSelf ? MENTION_PILL_HIGHLIGHT : MENTION_PILL_OTHER)}
    >
      @{name}
    </span>
  );
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right tabular-nums' } as const;

// Callout: rich text in a box tinted from the palette, led by an emoji.
export function Callout({ block }: { block: Extract<Block, { type: 'callout' }> }) {
  return (
    <div data-testid="block-callout" className={cn('flex min-w-0 gap-2.5 rounded-lg px-3 py-2.5', TINT[block.color])}>
      {block.icon && <EmojiGlyph emoji={`:${block.icon}:`} size="md" className="mt-0.5 shrink-0" />}
      <RichText content={block.content} />
    </div>
  );
}

// TableBlock: a header row (when any column names one) and rows of rich
// text. A wide table scrolls inside its own box, never the message.
export function TableBlock({ block }: { block: Extract<Block, { type: 'table' }> }) {
  const header = block.columns.some((c) => c.header);
  return (
    <div data-testid="block-table" className="max-w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        {header && (
          <thead className="bg-muted">
            <tr>
              {block.columns.map((column, index) => (
                <th key={index} scope="col" className={cn('px-2.5 py-1.5 font-semibold whitespace-nowrap', ALIGN[column.align])}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className={cn('border-border', (header || r > 0) && 'border-t')}>
              {row.map((cell, c) => (
                <td key={c} className={cn('px-2.5 py-1.5 align-top', ALIGN[block.columns[c].align])}>
                  {cell.spans && <Spans spans={cell.spans} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
