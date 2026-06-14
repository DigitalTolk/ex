import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import {
  rankUsers,
  rankChannels,
  type ChannelInput,
  type MentionUser,
  type UserSuggestion,
} from './mentionData';

// CodeMirror completion sources for @-mentions and ~-channels. The editor's
// document stays raw markdown: selecting a suggestion inserts the canonical
// token (`@[id|name]`, `~[id|slug]`, `@all`/`@here`) — exactly what the message
// renderer and the Go validator parse — followed by a trailing space. The
// matching mirrors the old Lexical trigger: the sigil must sit at a word
// boundary so "email@host" doesn't pop the menu.

export interface MentionProviders {
  users: () => MentionUser[];
  online: () => Set<string>;
  memberIds: () => Set<string> | null;
  channels: () => ChannelInput[];
}

// Insert `text` over the matched range and drop the caret just after it.
function applyInsert(text: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
}

function userCompletion(s: UserSuggestion): Completion {
  if (s.kind === 'group') {
    return { label: `@${s.group}`, type: 'keyword', apply: applyInsert(`@${s.group} `) };
  }
  return {
    label: s.displayName,
    detail: s.email,
    type: 'variable',
    apply: applyInsert(`@[${s.id}|${s.displayName}] `),
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
    const options = rankUsers(query, {
      users: providers.users(),
      online: providers.online(),
      memberIds: providers.memberIds(),
    }).map(userCompletion);
    return { from: before.from, to: before.to, options, filter: false };
  };
}

export function channelMentionSource(providers: MentionProviders): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/~[\w-]*/);
    if (!before) return null;
    if (!atBoundary(context, before.from)) return null;
    const query = before.text.slice(1);
    const options = rankChannels(query, providers.channels()).map((c) => ({
      label: `~${c.slug}`,
      type: c.isPrivate ? 'class' : 'variable',
      apply: applyInsert(`~[${c.id}|${c.slug}] `),
    }));
    return { from: before.from, to: before.to, options, filter: false };
  };
}
