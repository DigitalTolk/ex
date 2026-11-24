import { scanMentions } from './mention-syntax';

export interface MentionedUser {
  id: string;
  displayName: string;
}

// nonMemberMentions extracts the @[id|name] user mentions from a message body
// that target people who are NOT in `memberIds` (skipping the author and
// de-duplicating). @all/@here carry no id and are ignored; user groups are
// expanded by nonMemberGroupMentions.
// Used to offer the author a one-click "add them to the channel" prompt.
export function nonMemberMentions(
  body: string,
  memberIds: Set<string>,
  selfId?: string,
): MentionedUser[] {
  const seen = new Set<string>();
  const out: MentionedUser[] = [];
  for (const t of scanMentions(body)) {
    if (t.kind !== 'user') continue;
    const { id, label: displayName } = t;
    if (id === selfId || memberIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, displayName });
  }
  return out;
}

export interface MentionedUserGroup {
  groupId: string;
  handle: string;
  // The group's members who aren't in the channel (author and inactive
  // accounts excluded), for the "add them" prompt.
  missingUserIds: string[];
}

export interface UserGroupRef {
  id: string;
  handle: string;
}

// userGroupTokens lists, de-duplicated, the user groups a body mentions by
// their "@[group-…|handle]" token.
export function userGroupTokens(body: string): UserGroupRef[] {
  const out: UserGroupRef[] = [];
  for (const t of scanMentions(body)) {
    if (t.kind === 'usergroup' && !out.some((g) => g.id === t.id)) out.push({ id: t.id, handle: t.label.trim() });
  }
  return out;
}

// nonMemberGroupMentions lists, per mentioned group, its members outside
// `memberIds`. groupMembers answers a group's current member IDs (undefined
// while unknown or disabled: that group is skipped).
export function nonMemberGroupMentions(
  groups: UserGroupRef[],
  memberIds: Set<string>,
  groupMembers: (groupId: string) => string[] | undefined,
  selfId?: string,
  isInactive: (userId: string) => boolean = () => false,
): MentionedUserGroup[] {
  const out: MentionedUserGroup[] = [];
  for (const g of groups) {
    const members = groupMembers(g.id);
    if (!members) continue;
    const missingUserIds = members.filter((id) => id !== selfId && !memberIds.has(id) && !isInactive(id));
    if (missingUserIds.length > 0) out.push({ groupId: g.id, handle: g.handle, missingUserIds });
  }
  return out;
}

// A bare "@word" as the server's typed-handle conversion finds it, outside
// code: the leading guard keeps it out of emails, paths and "@[" tokens.
const TYPED_HANDLE_RE = /(^|[^\w@/:.\-[])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const CODE_RE = /```[\s\S]*?(```|$)|`[^`\n]*`/g;

// typedUserGroupMentions returns, de-duplicated, the known groups a body names
// by a typed "@handle" (not picked from the autocomplete) — the server stores
// those as the group's mention on send. Trailing '.', '-' or '_' is tried off
// ("ping @oncall.").
export function typedUserGroupMentions(
  body: string,
  groups: ReadonlyArray<{ id: string; handle: string }>,
): { id: string; handle: string }[] {
  if (groups.length === 0 || !body.includes('@')) return [];
  const byHandle = new Map(groups.map((g) => [g.handle.toLowerCase(), g]));
  const out: { id: string; handle: string }[] = [];
  for (const m of body.replace(CODE_RE, ' ').matchAll(TYPED_HANDLE_RE)) {
    const word = m[2].toLowerCase();
    const g = byHandle.get(word) ?? byHandle.get(word.replace(/[._-]+$/, ''));
    if (g && !out.some((o) => o.id === g.id)) out.push({ id: g.id, handle: g.handle });
  }
  return out;
}
