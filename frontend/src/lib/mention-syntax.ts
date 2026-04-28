// Single source of truth for the @-mention markdown syntax. The same
// patterns are recognised by the message renderer (markdown.tsx) and the
// editor's HTML→markdown round-trip (wysiwyg.ts). Backend-side regexes
// live in internal/service/mention.go and must stay in sync; tests pin
// the wire format from both sides so drift surfaces immediately.

// USER_MENTION_RE matches "@[<userID>|<displayName>]". Inner brackets
// are forbidden in either half so a stray "]" can't terminate early.
export const USER_MENTION_RE = /@\[([^|\]]+)\|([^\]]+)\]/;

// USER_MENTION_RE_GLOBAL is the global-flag form for `replace`-style
// passes through a longer string.
export const USER_MENTION_RE_GLOBAL = /@\[([^|\]]+)\|([^\]]+)\]/g;

// GROUP_MENTION_RE matches "@all" / "@here" only when they stand alone:
// preceded by start-of-string, whitespace, or punctuation (anything but
// a word char or another @). Avoids eating email local-parts like
// "user@all-hands.example.com".
export const GROUP_MENTION_RE = /(^|[^\w@])@(all|here)\b/;

// CHANNEL_MENTION_RE matches "~[<channelID>|<slug>]". The slug shows in
// rendered text; the ID is what survives renames so the link still
// resolves. Mirrors USER_MENTION_RE's structural rules.
export const CHANNEL_MENTION_RE = /~\[([^|\]]+)\|([^\]]+)\]/;
export const CHANNEL_MENTION_RE_GLOBAL = /~\[([^|\]]+)\|([^\]]+)\]/g;
