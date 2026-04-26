package service

import (
	"regexp"
	"strings"
)

// MentionUser is a single in-message mention of a specific user. The
// rendered text in the message is "@<DisplayName>" — the ID is the
// authoritative routing target for notifications.
type MentionUser struct {
	UserID      string
	DisplayName string
}

// ParsedMentions is the result of scanning a message body for @-mentions.
// Group flags are recorded as booleans rather than fake user IDs so the
// notification dispatcher can branch on them without a stringly-typed
// switch on a "userID" that isn't actually one.
type ParsedMentions struct {
	Users []MentionUser
	All   bool // @all → notify every channel/conversation member
	Here  bool // @here → notify online members only
}

// Empty reports whether the message contained no @-mentions of any kind.
func (m ParsedMentions) Empty() bool {
	return !m.All && !m.Here && len(m.Users) == 0
}

// userMentionPattern matches the "@[<userID>|<displayName>]" form emitted
// by the editor when the author picks a name from the autocomplete. The
// inner brackets are forbidden in the display-name half so a stray "]"
// can't terminate the mention early; the editor is responsible for
// normalising names before serialisation.
var userMentionPattern = regexp.MustCompile(`@\[([^|\]]+)\|([^\]]+)\]`)

// groupMentionPattern matches the literal "@all" / "@here" group mentions
// only when they stand alone — i.e. surrounded by whitespace or string
// boundary or punctuation. This avoids matching strings like "email@all-
// hands@example.com" (yes, contrived, but the rule is cheap to enforce).
var groupMentionPattern = regexp.MustCompile(`(^|[^\w@])@(all|here)\b`)

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

	seen := make(map[string]bool)
	for _, m := range userMentionPattern.FindAllStringSubmatch(body, -1) {
		userID := strings.TrimSpace(m[1])
		name := strings.TrimSpace(m[2])
		if userID == "" || seen[userID] {
			continue
		}
		seen[userID] = true
		out.Users = append(out.Users, MentionUser{UserID: userID, DisplayName: name})
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
