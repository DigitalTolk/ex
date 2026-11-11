import { fuzzyMatch } from '@/lib/fuzzy';
import { topK } from '@/lib/topk';

// Pure ranking logic for the composer's @-mention and ~-channel autocomplete.
// Extracted from the old Lexical UserMentionsPlugin / ChannelMentionsPlugin so
// the behaviour (fuzzy match → prefix-then-online ordering → channel-member
// partitioning → @all/@here group mentions) is preserved exactly, but now lives
// in a side-effect-free module that the CodeMirror completion source consumes
// and that can be unit-tested exhaustively without an editor.

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

// The minimal shape the ranker needs from a user group ("@oncall").
export interface MentionUserGroup {
  id: string;
  handle: string;
  name: string;
  memberCount: number;
}

export type UserSuggestion =
  | { kind: 'user'; id: string; displayName: string; email?: string; avatarURL?: string; statusEmoji?: string; online: boolean; inChannel?: boolean }
  | { kind: 'group'; group: GroupName }
  | ({ kind: 'usergroup' } & MentionUserGroup);

export interface RankUsersCtx {
  users: MentionUser[];
  online: Set<string>;
  // null → no channel context (DM/flat list); a Set → partition members first.
  memberIds: Set<string> | null;
  // The enabled user groups the author may mention (none for guests).
  userGroups?: MentionUserGroup[];
}

// rankUserGroups keeps the groups whose handle or name starts with the query,
// handle matches first, then by handle.
function rankUserGroups(q: string, groups: MentionUserGroup[]): UserSuggestion[] {
  const hits = groups.filter((g) => g.handle.toLowerCase().startsWith(q) || g.name.toLowerCase().startsWith(q));
  const handleRank = (g: MentionUserGroup) => (g.handle.toLowerCase().startsWith(q) ? 0 : 1);
  return topK(hits, MAX_MENTION_RESULTS, (a, b) => handleRank(a) - handleRank(b) || a.handle.localeCompare(b.handle)).map(
    (g) => ({ kind: 'usergroup' as const, ...g }),
  );
}

interface UserHit {
  id: string;
  displayName: string;
  email?: string;
  avatarURL?: string;
  statusEmoji?: string;
  online: boolean;
  inChannel?: boolean;
}

function toSuggestion(h: UserHit): UserSuggestion {
  return { kind: 'user', id: h.id, displayName: h.displayName, email: h.email, avatarURL: h.avatarURL, statusEmoji: h.statusEmoji, online: h.online, inChannel: h.inChannel };
}

export function rankUsers(query: string, ctx: RankUsersCtx): UserSuggestion[] {
  const q = query.toLowerCase();
  const partition = ctx.memberIds !== null;
  const matches: UserHit[] = ctx.users
    .filter((u) => fuzzyMatch(q, u.displayName, u.email ?? ''))
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      avatarURL: u.avatarURL,
      statusEmoji: u.statusEmoji,
      online: ctx.online.has(u.id),
      inChannel: partition ? ctx.memberIds!.has(u.id) : undefined,
    }));

  // Prefix matches outrank substrings; ties broken by online presence.
  const prefixRank = (name: string) => (name.toLowerCase().startsWith(q) ? 0 : 1);
  const onlineRank = (u: UserHit) => (u.online ? 0 : 1);
  const byRelevance = (a: UserHit, b: UserHit) => {
    const byPrefix = prefixRank(a.displayName) - prefixRank(b.displayName);
    return byPrefix !== 0 ? byPrefix : onlineRank(a) - onlineRank(b);
  };

  // @all / @here only surface once the full keyword is typed (Slack's rule:
  // "@a" must not suggest "@all" mid-type), matched case-insensitively.
  const groups: UserSuggestion[] = GROUP_NAMES.filter((g) => g === q).map((group) => ({ kind: 'group', group }));

  const userGroups = rankUserGroups(q, ctx.userGroups ?? []);

  if (partition) {
    // Channel context: members first, then group mentions, then user groups,
    // then everyone else. Each section gets its own budget so non-members
    // ("Not in channel") always surface — even in a busy channel where
    // members alone would fill the list.
    const members = topK(matches.filter((u) => u.inChannel), MAX_MENTION_RESULTS, byRelevance);
    const nonMembers = topK(matches.filter((u) => !u.inChannel), MAX_MENTION_RESULTS, byRelevance);
    return [...members.map(toSuggestion), ...groups, ...userGroups, ...nonMembers.map(toSuggestion)];
  }
  return [...groups, ...userGroups, ...topK(matches, MAX_MENTION_RESULTS, byRelevance).map(toSuggestion)];
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
