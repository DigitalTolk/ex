import { fuzzyMatch } from '@/lib/fuzzy';
import { topK } from '@/lib/topk';

// Pure ranking logic for the composer's @-mention and ~-channel autocomplete:
// fuzzy match, then sections (the thread's writers, the chat's members, the
// @all/@here group mentions, everyone else), each ordered prefix match first,
// then the people the writer mentions and messages most, then online. A
// side-effect-free module the CodeMirror completion source consumes, tested
// without an editor.

export const MAX_MENTION_RESULTS = 20;

export type GroupName = 'all' | 'here';
const GROUP_NAMES: GroupName[] = ['all', 'here'];

// The minimal shape the ranker needs from a roster entry.
export interface MentionUser {
  id: string;
  displayName: string;
  email?: string;
  avatarURL?: string;
  // Active custom-status emoji (already resolved by the caller), if any.
  statusEmoji?: string;
}

export type UserSuggestion =
  | { kind: 'user'; id: string; displayName: string; email?: string; avatarURL?: string; statusEmoji?: string; online: boolean; inChannel?: boolean; inThread?: boolean }
  | { kind: 'group'; group: GroupName };

export interface RankUsersCtx {
  users: MentionUser[];
  online: Set<string>;
  // The people of the chat being written in (a channel's members, a DM's
  // participants), listed first; null when unknown (an edit, a roster
  // still loading): one flat list.
  memberIds: Set<string> | null;
  // Who has written in the thread being replied to: ahead of the members.
  threadIds?: Set<string> | null;
  // The writer's people ranking (person ID → rank, 0 the most frequent):
  // within each section, the people they mention and message most come
  // first.
  frequent?: ReadonlyMap<string, number>;
}

interface UserHit {
  id: string;
  displayName: string;
  email?: string;
  avatarURL?: string;
  statusEmoji?: string;
  online: boolean;
  inChannel?: boolean;
  inThread?: boolean;
}

function toSuggestion(h: UserHit): UserSuggestion {
  return { kind: 'user', id: h.id, displayName: h.displayName, email: h.email, avatarURL: h.avatarURL, statusEmoji: h.statusEmoji, online: h.online, inChannel: h.inChannel, inThread: h.inThread };
}

const NOT_FREQUENT = Number.MAX_SAFE_INTEGER;

export function rankUsers(query: string, ctx: RankUsersCtx): UserSuggestion[] {
  const q = query.toLowerCase();
  const threadIds = ctx.threadIds && ctx.threadIds.size > 0 ? ctx.threadIds : null;
  const partition = ctx.memberIds !== null || threadIds !== null;
  const matches: UserHit[] = ctx.users
    .filter((u) => fuzzyMatch(q, u.displayName, u.email ?? ''))
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      avatarURL: u.avatarURL,
      statusEmoji: u.statusEmoji,
      online: ctx.online.has(u.id),
      inChannel: partition ? !!ctx.memberIds?.has(u.id) : undefined,
      inThread: threadIds ? threadIds.has(u.id) : undefined,
    }));

  // Prefix matches outrank substrings; then the people the writer mentions
  // and messages most; then online presence.
  const prefixRank = (name: string) => (name.toLowerCase().startsWith(q) ? 0 : 1);
  const frequentRank = (u: UserHit) => ctx.frequent?.get(u.id) ?? NOT_FREQUENT;
  const onlineRank = (u: UserHit) => (u.online ? 0 : 1);
  const byRelevance = (a: UserHit, b: UserHit) =>
    prefixRank(a.displayName) - prefixRank(b.displayName) || frequentRank(a) - frequentRank(b) || onlineRank(a) - onlineRank(b);

  // @all / @here only surface once the full keyword is typed (Slack's rule:
  // "@a" must not suggest "@all" mid-type), matched case-insensitively.
  const groups: UserSuggestion[] = GROUP_NAMES.filter((g) => g === q).map((group) => ({ kind: 'group', group }));

  if (partition) {
    // A chat's own people first (the thread's writers, then its members),
    // then group mentions, then everyone else. Each section gets its own
    // budget so the later ones always surface, even in a busy channel.
    const section = (keep: (u: UserHit) => boolean) =>
      topK(matches.filter(keep), MAX_MENTION_RESULTS, byRelevance).map(toSuggestion);
    return [
      ...section((u) => !!u.inThread),
      ...section((u) => !u.inThread && !!u.inChannel),
      ...groups,
      ...section((u) => !u.inThread && !u.inChannel),
    ];
  }
  return [...groups, ...topK(matches, MAX_MENTION_RESULTS, byRelevance).map(toSuggestion)];
}

export interface ChannelInput {
  channelID: string;
  channelName: string;
  channelType: string;
}

export interface ChannelHit {
  id: string;
  slug: string;
  isPrivate: boolean;
}

export function rankChannels(query: string, channels: ChannelInput[]): ChannelHit[] {
  const q = query.toLowerCase();
  const hits: ChannelHit[] = channels
    .map((c) => ({ id: c.channelID, slug: c.channelName, isPrivate: c.channelType === 'private' }))
    .filter((c) => fuzzyMatch(q, c.slug));
  const prefixRank = (slug: string) => (slug.toLowerCase().startsWith(q) ? 0 : 1);
  return topK(hits, MAX_MENTION_RESULTS, (a, b) => prefixRank(a.slug) - prefixRank(b.slug));
}
