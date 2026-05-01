import {
  ORDERED_LIST as STOCK_ORDERED_LIST,
  TRANSFORMERS,
  UNORDERED_LIST as STOCK_UNORDERED_LIST,
  type ElementTransformer,
  type TextMatchTransformer,
} from '@lexical/markdown';
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode } from '@lexical/rich-text';
import type { LexicalNode, TextNode } from 'lexical';
import { $createMentionNode, $isMentionNode, MentionNode } from '../nodes/MentionNode';
import { $createChannelMentionNode, $isChannelMentionNode, ChannelMentionNode } from '../nodes/ChannelMentionNode';

// Round-trip `@[userID|displayName]` between markdown and a MentionNode.
// dependencies + type are required by Lexical's transformer pipeline so
// it knows the node belongs in the editor schema.
export const MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MentionNode],
  type: 'text-match',
  importRegExp: /@\[([^|\]]+)\|([^\]]+)\]/,
  regExp: /@\[([^|\]]+)\|([^\]]+)\]$/,
  replace: (textNode, match) => {
    const [, userId, displayName] = match;
    const node = $createMentionNode(userId.trim(), displayName.trim());
    textNode.replace(node);
  },
  export: (node) => ($isMentionNode(node) ? `@[${node.getUserId()}|${node.getDisplayName()}]` : null),
  trigger: ']',
};

// Round-trip `~[channelID|slug]` between markdown and a ChannelMentionNode.
export const CHANNEL_MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ChannelMentionNode],
  type: 'text-match',
  importRegExp: /~\[([^|\]]+)\|([^\]]+)\]/,
  regExp: /~\[([^|\]]+)\|([^\]]+)\]$/,
  replace: (textNode: TextNode, match: RegExpMatchArray) => {
    const [, channelId, slug] = match;
    const node = $createChannelMentionNode(channelId.trim(), slug.trim());
    textNode.replace(node);
  },
  export: (node) => ($isChannelMentionNode(node) ? `~[${node.getChannelId()}|${node.getSlug()}]` : null),
  trigger: ']',
};

// Wrap Lexical's stock UNORDERED_LIST / ORDERED_LIST with a `replace`
// that always creates a fresh ListNode for live typing. Stock merges
// into an adjacent same-type list, so a user who closed a list and
// typed `- ` in the next paragraph perceives "the markdown shortcut
// didn't fire". Stock import behaviour (single list across blank
// lines) is preserved so stored markdown messages still round-trip.
//
// (Auto-merge by Lexical's ListNode.$transform is separately disabled
// via ExListNode — without that, `parentNode.replace(list)` here is
// silently undone by the merge transform on the next reconciliation.)
function makeListTransformer(
  stock: ElementTransformer,
  listType: 'bullet' | 'number',
): ElementTransformer {
  return {
    ...stock,
    dependencies: [ListNode, ListItemNode],
    replace: (parentNode, children, match, isImport) => {
      if (isImport) return stock.replace(parentNode, children, match, isImport);
      const list = $createListNode(listType, listType === 'number' ? Number(match[2]) : undefined);
      const item = $createListItemNode();
      list.append(item);
      parentNode.replace(list);
      item.append(...(children as LexicalNode[]));
      item.select(0, 0);
    },
  };
}

const NEW_UNORDERED_LIST = makeListTransformer(STOCK_UNORDERED_LIST, 'bullet');
const NEW_ORDERED_LIST = makeListTransformer(STOCK_ORDERED_LIST, 'number');

// Headings (`# foo`) are deliberately excluded — stored messages
// render them via `renderMarkdown` in the message list, but the
// composer keeps them as literal text so it doesn't switch into
// heading typography while the user is mid-thought.
const STRIPPED_NODE_TYPES = new Set([HeadingNode.getType(), ListNode.getType()]);
export const EX_TRANSFORMERS = [
  MENTION_TRANSFORMER,
  CHANNEL_MENTION_TRANSFORMER,
  NEW_UNORDERED_LIST,
  NEW_ORDERED_LIST,
  ...TRANSFORMERS.filter((t) => {
    if (t.type !== 'element') return true;
    return !(t.dependencies ?? []).some((d) => STRIPPED_NODE_TYPES.has(d.getType()));
  }),
];

