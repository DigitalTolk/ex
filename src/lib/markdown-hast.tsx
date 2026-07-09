import {
  Fragment,
  createContext,
  isValidElement,
  useContext,
  type ComponentType,
  type ReactNode,
} from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime, type Components as JsxComponents } from 'hast-util-to-jsx-runtime';
import type { Nodes as HastNodes } from 'hast';
import { GiphyEmbed } from '@/components/GiphyEmbed';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { applySkinToneSuffix, shortcodeToUnicode, emojiGlyphClass, emojiImageClass } from './emoji-shortcodes';
import { isSafeUrl } from './url-safety';
import type { HastNode } from '@/types';
import type { RenderOpts } from './markdown';

// Server-rendered hast → React hydrator. Lives in its own module so
// the heavy hast-util-to-jsx-runtime import only joins the bundle's
// initial cost when a real call to renderHastTree imports it (the
// loader in markdown.tsx pulls this in lazily on the first tree
// arrival, which keeps legacy-fallback callsites — and the cold
// initial render of any tree-less message — off the hot path).

// Flattens a (already-hydrated) React subtree back to its plain text — used
// to recover a code block's literal source from the rendered <code> child so
// CodeBlock can re-highlight it. Exported for direct unit tests: the
// hydrator only ever feeds it strings/elements/arrays, so the remaining
// ReactNode shapes (numbers, booleans, portals) are unreachable through
// rendering alone.
export function reactNodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (isValidElement(node)) {
    return reactNodeText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

const MENTION_PILL_BASE =
  'inline align-baseline rounded px-1 font-medium leading-[inherit] no-underline';
const MENTION_PILL_OTHER =
  ' bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary hover:no-underline';
const MENTION_PILL_HIGHLIGHT =
  ' bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-100';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
interface CustomTagProps {
  children?: ReactNode;
  'data-user-id'?: string;
  'data-name'?: string;
  'data-channel-id'?: string;
  'data-slug'?: string;
  'data-group'?: string;
  'data-tag'?: string;
  'data-id'?: string;
  'data-width'?: string;
  'data-height'?: string;
  'data-href'?: string;
  'data-skin'?: string;
  'data-value'?: string;
}

// normaliseTree defensively patches a tree before handing it to
// hast-util-to-jsx-runtime. The hydrator reads `node.children.length`
// unconditionally on element/root nodes — a tree with `children`
// missing (e.g. a malformed server response, a server emitting
// `omitempty` on empty arrays) crashes the hydrator and brings down
// the whole message render via React's error boundary. We patch in
// `children: []` for any element/root that arrives without one.
function normaliseTree(node: HastNode): HastNode {
  if (node.type === 'text') return node;
  const kids = node.children ?? [];
  return {
    ...node,
    children: kids.map(normaliseTree),
  };
}

// RenderOptsContext threads per-message render options (currentUserId,
// emojiMap, onTagClick, …) into the leaf components WITHOUT changing
// the components map identity across renders. This is load-bearing:
// React reconciles VDOM by component identity, so if we re-built the
// component map (with fresh closures) on every render — as the old
// code did — every scroll-induced re-render of MessageItem would
// unmount + remount every ex-giphy / ex-mention / ex-emoji-shortcode
// in view, destroying the <video> DOM nodes and forcing the browser
// to re-fetch every Giphy .mp4. By moving the components to module
// scope and threading per-render data through context, the components
// keep stable references and React reconciles cleanly.
const RenderOptsContext = createContext<RenderOpts | undefined>(undefined);
const useRenderOpts = () => useContext(RenderOptsContext);

export function renderHastTree(tree: HastNode, opts?: RenderOpts): ReactNode {
  const rendered = toJsxRuntime(normaliseTree(tree) as unknown as HastNodes, {
    Fragment,
    jsx,
    jsxs,
    components: HAST_COMPONENTS,
  });
  return <RenderOptsContext.Provider value={opts}>{rendered}</RenderOptsContext.Provider>;
}

// GFM column alignment → text-align utility. Left is the default, so an
// unset/left `data-align` still resolves to text-left.
const cellAlignClass = (align?: string) =>
  align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';

const headingClass = (level: 1 | 2 | 3 | 4 | 5 | 6) =>
  level === 1 ? 'text-2xl font-bold mt-3 mb-2'
    : level === 2 ? 'text-xl font-bold mt-3 mb-1.5'
    : level === 3 ? 'text-lg font-semibold mt-2 mb-1'
    : level === 4 ? 'text-base font-semibold mt-2 mb-1'
    : level === 5 ? 'text-sm font-semibold mt-1.5 mb-0.5'
    : 'text-xs font-semibold uppercase tracking-wide mt-1 mb-0.5 text-muted-foreground';

// Module-level component map. Stable across renders, so React
// reconciliation preserves children (and DOM nodes like <video>).
// All opts-dependent state is read through the context.
const HAST_COMPONENTS_MAP: Record<string, AnyComponent> = {
  h1: ({ children }) => <h1 className={headingClass(1)}>{children}</h1>,
  h2: ({ children }) => <h2 className={headingClass(2)}>{children}</h2>,
  h3: ({ children }) => <h3 className={headingClass(3)}>{children}</h3>,
  h4: ({ children }) => <h4 className={headingClass(4)}>{children}</h4>,
  h5: ({ children }) => <h5 className={headingClass(5)}>{children}</h5>,
  h6: ({ children }) => <h6 className={headingClass(6)}>{children}</h6>,
  hr: () => <hr className="my-3 border-muted" />,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  p: (props: { children?: ReactNode; 'data-blank'?: string }) => {
    if (props['data-blank'] === 'true') {
      // Re-emit the data-blank attribute so the `.prose-message
      // p[data-blank="true"]` rule in index.css gives the spacer its
      // min-height. Without it the <p> collapses to ~0px and stacked
      // blank lines (one <p> per source blank line) all vanish — the
      // client-side render path keeps the attribute, so this matches it.
      return <p data-blank="true" className="leading-snug">{' '}</p>;
    }
    return <p className="whitespace-pre-wrap break-words">{props.children}</p>;
  },
  ul: ({ children }) => <ul className="my-1 list-disc pl-5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  s: ({ children }) => <s>{children}</s>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) =>
    isSafeUrl(href) ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link transition-colors hover:text-link/80"
    >
      {children}
    </a>
    ) : (
      // Unsafe scheme (javascript:, data: …) — render the text only, no anchor.
      <span>{children}</span>
  ),
  // A fenced code block: route the raw text + language to CodeBlock, which
  // adds syntax highlighting, a line-number gutter, and a copy button. The
  // backend leaves the code text untouched (custom-syntax extraction skips
  // <pre>/<code>), so the code element's children are the literal source.
  pre: (props: { children?: ReactNode; 'data-language'?: string }) => (
    <CodeBlock code={reactNodeText(props.children)} language={props['data-language']} />
  ),
  code: ({ children, className }: { children?: ReactNode; className?: string }) => {
    if (!className) {
      return <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">{children}</code>;
    }
    return <code className={className}>{children}</code>;
  },

  // GFM table. Wrapped in an overflow-x-auto box so a wide row scrolls inside
  // the chat column instead of stretching it (and breaking react-virtuoso row
  // measurement). Borders/spacing use design-system tokens only.
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="w-auto border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead className="bg-muted">{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => (
    <tr className="border-b border-border last:border-b-0">{children}</tr>
  ),
  th: (props: { children?: ReactNode; 'data-align'?: string }) => (
    <th className={`border border-border px-2 py-1 font-semibold ${cellAlignClass(props['data-align'])}`}>
      {props.children}
    </th>
  ),
  td: (props: { children?: ReactNode; 'data-align'?: string }) => (
    <td className={`border border-border px-2 py-1 align-top ${cellAlignClass(props['data-align'])}`}>
      {props.children}
    </td>
  ),

  'ex-mention-user': ((props: CustomTagProps) => {
    const opts = useRenderOpts();
    const userId = props['data-user-id'] ?? '';
    const name = props['data-name'] ?? '';
    const isSelf = !!opts?.currentUserId && opts.currentUserId === userId;
    const pill = (
      <span
        data-testid="mention-pill"
        data-mention-user-id={userId}
        data-mention-self={isSelf ? 'true' : 'false'}
        className={`${MENTION_PILL_BASE}${isSelf ? MENTION_PILL_HIGHLIGHT : MENTION_PILL_OTHER}`}
      >
        @{name}
      </span>
    );
    if (opts?.renderUserMention) {
      return <Fragment>{opts.renderUserMention(userId, name, isSelf, pill)}</Fragment>;
    }
    return pill;
  }) as AnyComponent,

  'ex-mention-channel': ((props: CustomTagProps) => {
    const channelId = props['data-channel-id'] ?? '';
    const slug = props['data-slug'] ?? '';
    return (
      <a
        href={`/channel/${slug}`}
        data-testid="channel-mention-pill"
        data-channel-id={channelId}
        className={`${MENTION_PILL_BASE}${MENTION_PILL_OTHER}`}
      >
        ~{slug}
      </a>
    );
  }) as AnyComponent,

  'ex-mention-group': ((props: CustomTagProps) => {
    const group = props['data-group'] ?? '';
    return (
      <span
        data-testid="mention-pill"
        data-mention-group={group}
        className={`${MENTION_PILL_BASE}${MENTION_PILL_HIGHLIGHT}`}
      >
        @{group}
      </span>
    );
  }) as AnyComponent,

  'ex-hashtag': ((props: CustomTagProps) => {
    const opts = useRenderOpts();
    const tag = props['data-tag'] ?? '';
    const display = (props['data-value'] ?? `#${tag}`).slice(1);
    if (!opts?.onTagClick) {
      return <span>{`#${display}`}</span>;
    }
    const handler = opts.onTagClick;
    return (
      <button
        type="button"
        data-testid="hashtag-pill"
        data-tag={tag}
        onClick={() => handler(tag)}
        className={`${MENTION_PILL_BASE}${MENTION_PILL_OTHER} cursor-pointer`}
      >
        #{display}
      </button>
    );
  }) as AnyComponent,

  'ex-giphy': ((props: CustomTagProps) => {
    const opts = useRenderOpts();
    const id = props['data-id'] ?? '';
    const width = props['data-width'] ? Number(props['data-width']) : undefined;
    const height = props['data-height'] ? Number(props['data-height']) : undefined;
    return (
      <GiphyEmbed
        id={id}
        width={width}
        height={height}
        apiKey={opts?.giphyAPIKey}
        onMediaLoad={opts?.onMediaLoad}
      />
    );
  }) as AnyComponent,

  'ex-media-literal': ((props: CustomTagProps) => (
    <span>{props['data-value']}</span>
  )) as AnyComponent,

  'ex-emoji-shortcode': ((props: CustomTagProps) => {
    const opts = useRenderOpts();
    const name = props['data-name'] ?? '';
    const skin = props['data-skin'];
    const literal = props['data-value'] ?? `:${name}:`;
    const url = !skin ? opts?.emojiMap?.[name] : undefined;
    if (url) {
      return (
        <img
          src={url}
          alt={`:${name}:`}
          title={`:${name}:`}
          className={emojiImageClass(opts?.largeEmoji)}
        />
      );
    }
    const unicode = shortcodeToUnicode(`:${name}:`);
    if (unicode !== `:${name}:`) {
      const visible = skin ? applySkinToneSuffix(unicode, skin) : unicode;
      return (
        <span
          title={skin ? `:${name}::${skin}:` : `:${name}:`}
          className={emojiGlyphClass(opts?.largeEmoji)}
        >
          {visible}
        </span>
      );
    }
    return <span>{literal}</span>;
  }) as AnyComponent,

  'ex-bare-url': ((props: CustomTagProps) => {
    const href = props['data-href'] ?? '';
    const visible = href.startsWith('https://') ? href.slice('https://'.length) : href;
    // Guard the scheme here too — same defense-in-depth as the `a` component
    // above. The server only emits this tag for matched http(s) bare URLs, but
    // the client must not depend on the server staying correct: an unsafe
    // scheme renders as inert text, never a live anchor.
    if (!isSafeUrl(href)) {
      return <span>{visible}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link transition-colors hover:text-link/80"
      >
        {visible}
      </a>
    );
  }) as AnyComponent,
};

const HAST_COMPONENTS = HAST_COMPONENTS_MAP as unknown as JsxComponents;
