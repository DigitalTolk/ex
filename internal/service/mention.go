package service

import (
	"regexp"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// MentionUser is a single in-message mention of a specific user. The
// rendered text in the message is "@<DisplayName>" — the ID is the
// authoritative routing target for notifications.
type MentionUser struct {
	UserID      string
	DisplayName string
}

// MentionUserGroup is a single in-message mention of a user group. The ID
// carries model.UserGroupIDPrefix; Handle is the handle typed next to it.
type MentionUserGroup struct {
	ID     string
	Handle string
}

// ParsedMentions is the result of scanning a message body for @-mentions.
// Group flags are recorded as booleans rather than fake user IDs so the
// notification dispatcher can branch on them without a stringly-typed
// switch on a "userID" that isn't actually one.
type ParsedMentions struct {
	Users      []MentionUser
	UserGroups []MentionUserGroup
	All        bool // @all → notify every channel/conversation member
	Here       bool // @here → notify online members only
}

// Empty reports whether the message contained no @-mentions of any kind.
func (m ParsedMentions) Empty() bool {
	return !m.All && !m.Here && len(m.Users) == 0 && len(m.UserGroups) == 0
}

// mentionTokenPattern matches the "@[<id>|<label>]" form emitted by the
// editor when the author picks a person or a user group from the
// autocomplete. The inner brackets are forbidden in the label half so a
// stray "]" can't terminate the mention early. It is private on purpose:
// every reader goes through ScanMentions, so the user/user-group split
// lives in one place.
var mentionTokenPattern = regexp.MustCompile(`@\[([^|\]]+)\|([^\]]+)\]`)

// MentionTokenKind says what an @[id|label] token names.
type MentionTokenKind int

const (
	MentionTokenUser MentionTokenKind = iota
	MentionTokenUserGroup
)

// MentionToken is one @[id|label] token: its byte offsets in the scanned
// text, its kind, its trimmed ID and its label exactly as typed.
type MentionToken struct {
	Start, End int
	Kind       MentionTokenKind
	ID, Label  string
}

// IsUserGroupID reports whether a mention ID names a user group.
func IsUserGroupID(id string) bool { return strings.HasPrefix(id, model.UserGroupIDPrefix) }

// ScanMentions returns every @[id|label] token in text, in order, classified
// by ID: a "group-" ID is a user group, anything else a user. It does not
// strip code; callers that must ignore code (ParseMentions) do that first.
func ScanMentions(text string) []MentionToken {
	matches := mentionTokenPattern.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return nil
	}
	out := make([]MentionToken, 0, len(matches))
	for _, m := range matches {
		id := strings.TrimSpace(text[m[2]:m[3]])
		kind := MentionTokenUser
		if IsUserGroupID(id) {
			kind = MentionTokenUserGroup
		}
		out = append(out, MentionToken{Start: m[0], End: m[1], Kind: kind, ID: id, Label: text[m[4]:m[5]]})
	}
	return out
}

// ReplaceMentions rebuilds text with every @[id|label] token replaced by
// what fn returns for it.
func ReplaceMentions(text string, fn func(MentionToken) string) string {
	tokens := ScanMentions(text)
	if len(tokens) == 0 {
		return text
	}
	var b strings.Builder
	b.Grow(len(text))
	cursor := 0
	for _, t := range tokens {
		b.WriteString(text[cursor:t.Start])
		b.WriteString(fn(t))
		cursor = t.End
	}
	b.WriteString(text[cursor:])
	return b.String()
}

// PlainMentions rewrites "@[id|Name]" mentions to plain "@Name", for text
// read by something that is not a renderer (an agent's task brief). A user
// group reads as its handle, "@oncall".
func PlainMentions(body string) string {
	return ReplaceMentions(body, func(t MentionToken) string { return "@" + t.Label })
}

// groupMentionPattern matches the literal "@all" / "@here" group mentions
// only when they stand alone — i.e. surrounded by whitespace or string
// boundary or punctuation. This avoids matching strings like "email@all-
// hands@example.com" (yes, contrived, but the rule is cheap to enforce).
var groupMentionPattern = regexp.MustCompile(`(^|[^\w@])@(all|here)\b`)

// Code segments are QUOTED syntax, not speech: a mention inside a fenced
// block or inline code span must neither notify nor invoke. Discovered the
// hard way — an agent pasting a guide full of example mentions summoned
// every agent the examples named. The renderer already keeps code literal
// (walkAndExtractCustom skips <code>/<pre>); this makes dispatch agree.
var (
	fencedCodePattern = regexp.MustCompile("(?s)(^|\n)\\s*```.*?(```|$)")
	inlineCodePattern = regexp.MustCompile("`[^`\n]*`")
)

// stripCodeSegments blanks fenced blocks and inline code spans so mention
// scanning never sees them. Replacement keeps a space so adjacent tokens
// don't fuse into false positives.
func stripCodeSegments(body string) string {
	if !strings.Contains(body, "`") {
		return body
	}
	body = fencedCodePattern.ReplaceAllString(body, " ")
	return inlineCodePattern.ReplaceAllString(body, " ")
}

// ParseMentions extracts all @-mentions from a message body.
//
// Duplicate user mentions (the same userID mentioned twice in one message)
// are de-duplicated — notifying twice would be noise. The DisplayName from
// the first occurrence wins; subsequent occurrences are dropped.
func ParseMentions(body string) ParsedMentions {
	out := ParsedMentions{}
	if body == "" {
		return out
	}
	body = stripCodeSegments(body)

	seen := make(map[string]bool)
	for _, t := range ScanMentions(body) {
		if t.ID == "" || seen[t.ID] {
			continue
		}
		seen[t.ID] = true
		label := strings.TrimSpace(t.Label)
		if t.Kind == MentionTokenUserGroup {
			out.UserGroups = append(out.UserGroups, MentionUserGroup{ID: t.ID, Handle: label})
			continue
		}
		out.Users = append(out.Users, MentionUser{UserID: t.ID, DisplayName: label})
	}

	for _, m := range groupMentionPattern.FindAllStringSubmatch(body, -1) {
		switch m[2] {
		case "all":
			out.All = true
		case "here":
			out.Here = true
		}
	}

	return out
}
