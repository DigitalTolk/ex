// Single source of truth for the @-mention markdown syntax. The same
// patterns are recognised by the message renderer (markdown.tsx) and the
// editor's HTML→markdown round-trip (wysiwyg.ts). Backend-side regexes
// live in internal/service/mention.go and must stay in sync; tests pin
// the wire format from both sides so drift surfaces immediately.

// MENTION_TOKEN_RE matches "@[<id>|<label>]" — a person or a user group.
// Inner brackets are forbidden in either half so a stray "]" can't
// terminate early. Readers never classify a match themselves: they use
// scanMentions, or (markdown-to-hast's regex engine) mentionTokenFromMatch,
// so the person/user-group split lives here and in ScanMentions (Go) only.
export const MENTION_TOKEN_RE = /@\[([^|\]]+)\|([^\]]+)\]/;

// USER_GROUP_ID_PREFIX starts every user-group ID (model.UserGroupIDPrefix).
export const USER_GROUP_ID_PREFIX = 'group-';

export type MentionTokenKind = 'user' | 'usergroup';

// MentionToken is one "@[id|label]" token: its UTF-16 offsets in the scanned
// text (as String.slice and CodeMirror use), its kind, the trimmed ID and the
// label exactly as typed.
export interface MentionToken {
  start: number;
  end: number;
  kind: MentionTokenKind;
  id: string;
  label: string;
}

export function isUserGroupId(id: string): boolean {
  return id.startsWith(USER_GROUP_ID_PREFIX);
}

// mentionTokenFromMatch classifies one MENTION_TOKEN_RE match.
export function mentionTokenFromMatch(m: RegExpExecArray | RegExpMatchArray): MentionToken {
  const id = m[1].trim();
  const start = m.index ?? 0;
  return { start, end: start + m[0].length, kind: isUserGroupId(id) ? 'usergroup' : 'user', id, label: m[2] };
}

const MENTION_TOKEN_RE_GLOBAL = new RegExp(MENTION_TOKEN_RE.source, 'g');

// scanMentions returns every "@[id|label]" token in text, in order. Mirrors
// ScanMentions in internal/service/mention.go; both run the shared fixture
// internal/service/testdata/mention_scan_cases.json.
export function scanMentions(text: string): MentionToken[] {
  return Array.from(text.matchAll(MENTION_TOKEN_RE_GLOBAL), mentionTokenFromMatch);
}

// replaceMentions rebuilds text with every token replaced by fn's result.
export function replaceMentions(text: string, fn: (t: MentionToken) => string): string {
  let out = '';
  let cursor = 0;
  for (const t of scanMentions(text)) {
    out += text.slice(cursor, t.start) + fn(t);
    cursor = t.end;
  }
  return out + text.slice(cursor);
}

// GROUP_MENTION_RE matches "@all" / "@here" only when they stand alone:
// preceded by start-of-string, whitespace, or punctuation (anything but
// a word char or another @). Avoids eating email local-parts like
// "user@all-hands.example.com".
export const GROUP_MENTION_RE = /(^|[^\w@])@(all|here)\b/;

// CHANNEL_MENTION_RE matches "~[<channelID>|<slug>]". The slug shows in
// rendered text; the ID is what survives renames so the link still
// resolves. Mirrors MENTION_TOKEN_RE's structural rules.
export const CHANNEL_MENTION_RE = /~\[([^|\]]+)\|([^\]]+)\]/;
export const CHANNEL_MENTION_RE_GLOBAL = /~\[([^|\]]+)\|([^\]]+)\]/g;
