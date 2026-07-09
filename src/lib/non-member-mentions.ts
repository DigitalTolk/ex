import { USER_MENTION_RE_GLOBAL } from './mention-syntax';

export interface MentionedUser {
  id: string;
  displayName: string;
}

// nonMemberMentions extracts the @[id|name] user mentions from a message body
// that target people who are NOT in `memberIds` (skipping the author and
// de-duplicating). Group mentions (@all/@here) carry no id and are ignored.
// Used to offer the author a one-click "add them to the channel" prompt.
export function nonMemberMentions(
  body: string,
  memberIds: Set<string>,
  selfId?: string,
): MentionedUser[] {
  const seen = new Set<string>();
  const out: MentionedUser[] = [];
  for (const m of body.matchAll(USER_MENTION_RE_GLOBAL)) {
    const id = m[1];
    const displayName = m[2];
    if (id === selfId || memberIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, displayName });
  }
  return out;
}
