import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import {
  rankUsers,
  rankChannels,
  type ChannelInput,
  type GroupName,
  type MentionUser,
  type UserSuggestion,
} from './mentionData';
import type { MentionCompletion } from './optionRender';

// CodeMirror completion sources for @-mentions and ~-channels. The editor's
// document stays raw markdown: selecting a suggestion inserts the canonical
// token (`@[id|name]`, `~[id|slug]`, `@all`/`@here`) — exactly what the message
// renderer and the Go validator parse — followed by a trailing space. The
// matching mirrors the old Lexical trigger: the sigil must sit at a word
// boundary so "email@host" doesn't pop the menu.

export interface MentionProviders {
  users: () => MentionUser[];
  online: () => Set<string>;
  // The chat's people, listed first (see RankUsersCtx.memberIds), and what
  // they are: a channel's members or a DM's participants (headers differ).
  memberIds: () => Set<string> | null;
  memberScope?: () => MemberScope;
  // The writers of the thread being replied to, ahead of the members.
  threadIds?: () => Set<string> | null;
  // The writer's people ranking, person ID → rank (0 most frequent).
  frequent?: () => ReadonlyMap<string, number>;
  channels: () => ChannelInput[];
}

export type MemberScope = 'channel' | 'conversation';

// Insert `text` over the matched range and drop the caret just after it.
function applyInsert(text: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
}

// Section headers shown in the @-mention popup when there is a channel context
// (member / not-in-channel partitioning), mirroring the old Lexical typeahead.
// `rank` fixes their order regardless of how options interleave.
function mkSection(name: string, rank: number): CompletionSection {
  return {
    name,
    rank,
    header: () => {
      const el = document.createElement('div');
      el.className = 'cm-mention-section';
      el.textContent = name;
      return el;
    },
  };
}
const SECTION_THREAD = mkSection('In this thread', 0);
const SECTION_MEMBERS: Record<MemberScope, CompletionSection> = {
  channel: mkSection('Channel members', 1),
  conversation: mkSection('In this conversation', 1),
};
const SECTION_SPECIAL = mkSection('Special mentions', 2);
const SECTION_OTHERS: Record<MemberScope, CompletionSection> = {
  channel: mkSection('Not in channel', 3),
  conversation: mkSection('Not in this conversation', 3),
};
// `useUserChannels` returns only the channels the user has joined, so the
// ~-popup is always "My Channels".
const SECTION_CHANNELS = mkSection('My Channels', 0);

const GROUP_DETAIL: Record<GroupName, string> = {
  all: 'Notify everyone in this channel',
  here: 'Notify everyone currently online',
};

function userSection(s: Extract<UserSuggestion, { kind: 'user' }>, scope: MemberScope): CompletionSection {
  if (s.inThread) return SECTION_THREAD;
  return s.inChannel ? SECTION_MEMBERS[scope] : SECTION_OTHERS[scope];
}

function userCompletion(s: UserSuggestion, partitioned: boolean, scope: MemberScope): MentionCompletion {
  if (s.kind === 'group') {
    return {
      label: `@${s.group}`,
      detail: GROUP_DETAIL[s.group],
      type: 'keyword',
      section: partitioned ? SECTION_SPECIAL : undefined,
      apply: applyInsert(`@${s.group} `),
      meta: { kind: 'group', title: `@${s.group}`, description: GROUP_DETAIL[s.group] },
    };
  }
  return {
    label: s.displayName,
    detail: s.email,
    type: 'variable',
    // Only group under headers when there's a chat roster to partition by;
    // edits (and a roster still loading) show a flat ranked list.
    section: partitioned ? userSection(s, scope) : undefined,
    apply: applyInsert(`@[${s.id}|${s.displayName}] `),
    meta: { kind: 'user', displayName: s.displayName, email: s.email, avatarURL: s.avatarURL, online: s.online, statusEmoji: s.statusEmoji },
  };
}

// True when the sigil at `from` is at the start of the line/doc or preceded by
// a non-word character — i.e. a genuine mention start, not part of a word.
function atBoundary(context: CompletionContext, from: number): boolean {
  if (from === 0) return true;
  return !/\w/.test(context.state.sliceDoc(from - 1, from));
}

export function userMentionSource(providers: MentionProviders): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/@[\w.-]*/);
    if (!before) return null;
    if (!atBoundary(context, before.from)) return null;
    const query = before.text.slice(1);
    const memberIds = providers.memberIds();
    const threadIds = providers.threadIds?.() ?? null;
    const partitioned = memberIds !== null || (threadIds !== null && threadIds.size > 0);
    const scope = providers.memberScope?.() ?? 'channel';
    const options = rankUsers(query, {
      users: providers.users(),
      online: providers.online(),
      memberIds,
      threadIds,
      frequent: providers.frequent?.(),
    }).map((s) => userCompletion(s, partitioned, scope));
    return { from: before.from, to: before.to, options, filter: false };
  };
}

export function channelMentionSource(providers: MentionProviders): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/~[\w-]*/);
    if (!before) return null;
    if (!atBoundary(context, before.from)) return null;
    const query = before.text.slice(1);
    const options = rankChannels(query, providers.channels()).map((c): MentionCompletion => ({
      label: `~${c.slug}`,
      type: c.isPrivate ? 'class' : 'variable',
      section: SECTION_CHANNELS,
      apply: applyInsert(`~[${c.id}|${c.slug}] `),
      meta: { kind: 'channel', slug: c.slug, isPrivate: c.isPrivate },
    }));
    return { from: before.from, to: before.to, options, filter: false };
  };
}
