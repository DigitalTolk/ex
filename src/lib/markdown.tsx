import { type ReactNode } from 'react';
import type { HastNode } from '@/types';
import { renderHastTree } from './markdown-hast';
import { markdownToHast } from './markdown-to-hast';

export interface RenderOpts {
  // Server-rendered hast tree. When set, renderMarkdown skips the
  // client-side fallback parser entirely and just hydrates the tree
  // with React. Per-viewer behaviour still applies via the components
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

// renderMarkdown is the public render entry point. ONE render pipeline:
// everything goes through the hast hydrator (renderHastTree + its
// components map — the single place markdown presentation is defined).
//
// Two ways to get a tree:
//   1. Server-rendered hast (preferred). Backend pre-parses every
//      message body and ships the tree on the API response.
//   2. Client-side fallback parse (markdownToHast) emitting the same
//      hast vocabulary — used when `tree` is missing (optimistic
//      sends, older messages, webhook attachment fields, unfurl
//      descriptions, search hits).
//
// Per-viewer behaviour (self-mention pill, hashtag click handler,
// renderUserMention wrapper, custom emoji map, GIPHY API key) is
// applied at the React-component level in BOTH cases — the tree holds
// viewer-agnostic ex-* sentinel tags and the components map closes
// over `opts` to render them.
export function renderMarkdown(body: string, opts?: RenderOpts): ReactNode {
  if (opts?.tree) return renderHastTree(opts.tree, opts);
  if (!body) return null;
  return renderHastTree(markdownToHast(body), opts);
}
