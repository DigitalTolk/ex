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
  type MentionUserGroup,
  type UserSuggestion,
} from './mentionData';
import type { MentionCompletion } from './optionRender';

// CodeMirror completion sources for @-mentions and ~-channels. The editor's
// document stays raw markdown: selecting a suggestion inserts the canonical
// token (`@[id|name]` for a person or a user group, `~[id|slug]`, `@all`/`@here`) — exactly what the message
// renderer and the Go validator parse — followed by a trailing space. The
// matching mirrors the old Lexical trigger: the sigil must sit at a word
// boundary so "email@host" doesn't pop the menu.

export interface MentionProviders {
  users: () => MentionUser[];
  online: () => Set<string>;
  memberIds: () => Set<string> | null;
  channels: () => ChannelInput[];
  // The enabled user groups the author may mention; omitted → none.
  userGroups?: () => MentionUserGroup[];
}

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
const SECTION_MEMBERS = mkSection('Channel members', 0);
const SECTION_SPECIAL = mkSection('Special mentions', 1);
const SECTION_USERGROUPS = mkSection('User groups', 2);
const SECTION_OTHERS = mkSection('Not in channel', 3);
// `useUserChannels` returns only the channels the user has joined, so the
// ~-popup is always "My Channels".
const SECTION_CHANNELS = mkSection('My Channels', 0);

const GROUP_DETAIL: Record<GroupName, string> = {
  all: 'Notify everyone in this channel',
  here: 'Notify everyone currently online',
};

function memberCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'member' : 'members'}`;
}

function userCompletion(s: UserSuggestion, partitioned: boolean): MentionCompletion {
  if (s.kind === 'usergroup') {
    const description = `${s.name} · ${memberCountLabel(s.memberCount)}`;
    return {
      label: `@${s.handle}`,
      detail: description,
      type: 'keyword',
      section: partitioned ? SECTION_USERGROUPS : undefined,
      apply: applyInsert(`@[${s.id}|${s.handle}] `),
      meta: { kind: 'group', title: `@${s.handle}`, description },
    };
  }
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
    // Only group under headers when there's a channel roster to partition by;
    // DMs / edits show a flat ranked list with no headers.
    section: partitioned ? (s.inChannel ? SECTION_MEMBERS : SECTION_OTHERS) : undefined,
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
    const partitioned = memberIds !== null;
    const options = rankUsers(query, {
      users: providers.users(),
      online: providers.online(),
      memberIds,
      userGroups: providers.userGroups?.() ?? [],
    }).map((s) => userCompletion(s, partitioned));
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
