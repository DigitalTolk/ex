package service

import (
	"testing"
)

func TestParseMentions_Empty(t *testing.T) {
	if !ParseMentions("").Empty() {
		t.Error("empty body should yield empty mentions")
	}
	if !ParseMentions("just a regular message").Empty() {
		t.Error("body without @ markers should yield empty mentions")
	}
}

func TestParseMentions_SingleUser(t *testing.T) {
	got := ParseMentions("hi @[U-1|Alice], how are you?")
	if len(got.Users) != 1 {
		t.Fatalf("expected 1 user, got %d", len(got.Users))
	}
	if got.Users[0].UserID != "U-1" || got.Users[0].DisplayName != "Alice" {
		t.Errorf("got %+v, want {U-1, Alice}", got.Users[0])
	}
	if got.All || got.Here {
		t.Error("group flags must not be set for a single user mention")
	}
}

func TestParseMentions_MultipleUsersAndDedup(t *testing.T) {
	body := "@[U-1|Alice] @[U-2|Bob] said @[U-1|Alice] again"
	got := ParseMentions(body)
	if len(got.Users) != 2 {
		t.Fatalf("expected 2 unique users, got %d", len(got.Users))
	}
	if got.Users[0].UserID != "U-1" || got.Users[1].UserID != "U-2" {
		t.Errorf("ordering not preserved: %+v", got.Users)
	}
}

func TestParseMentions_AtAll(t *testing.T) {
	got := ParseMentions("@all please review")
	if !got.All {
		t.Error("@all should set All flag")
	}
	if got.Here {
		t.Error("@all must not also set Here")
	}
}

func TestParseMentions_AtHere(t *testing.T) {
	got := ParseMentions("hey @here, anyone around?")
	if !got.Here {
		t.Error("@here should set Here flag")
	}
	if got.All {
		t.Error("@here must not also set All")
	}
}

func TestParseMentions_AtAllAndAtHere(t *testing.T) {
	got := ParseMentions("@all and also @here")
	if !got.All || !got.Here {
		t.Errorf("expected both group flags, got All=%v Here=%v", got.All, got.Here)
	}
}

func TestParseMentions_DoesNotMatchEmailLikeStrings(t *testing.T) {
	// Email addresses contain @ but should not parse as group mentions.
	cases := []string{
		"contact me at user@all-hands.example.com",
		"hello@example.com is my address",
		"x@allowedlist@y.com",
	}
	for _, c := range cases {
		got := ParseMentions(c)
		if got.All || got.Here {
			t.Errorf("body %q wrongly produced group mention: %+v", c, got)
		}
	}
}

func TestParseMentions_AtAllAtStartOfString(t *testing.T) {
	// The regex's leading-anchor branch ((^|[^\w@])) needs the very-first-
	// position case covered — without it, "@all" at the start of the body
	// would never match (no preceding character).
	got := ParseMentions("@all hands on deck")
	if !got.All {
		t.Error("@all at the start of the message should match")
	}
}

func TestParseMentions_GroupAtEndAndPunctuation(t *testing.T) {
	got := ParseMentions("ping @all.")
	if !got.All {
		t.Error("@all followed by punctuation should still match")
	}
}

func TestParseMentions_IgnoresBlankUserID(t *testing.T) {
	// Defensive: a malformed marker with empty ID half should be skipped,
	// not produce a mention with no routing target.
	got := ParseMentions("@[|Alice] hello")
	if len(got.Users) != 0 {
		t.Errorf("expected empty mention list for blank id; got %+v", got.Users)
	}
}

func TestParseMentions_TrimsWhitespaceInsideMarker(t *testing.T) {
	got := ParseMentions("@[ U-9 | Bob ]")
	if len(got.Users) != 1 || got.Users[0].UserID != "U-9" || got.Users[0].DisplayName != "Bob" {
		t.Errorf("expected trimmed parse, got %+v", got.Users)
	}
}

func TestParseMentions_MixedUsersAndGroup(t *testing.T) {
	got := ParseMentions("@all and @[U-9|Cara]")
	if !got.All {
		t.Error("expected All=true")
	}
	if len(got.Users) != 1 || got.Users[0].UserID != "U-9" {
		t.Errorf("expected single user U-9; got %+v", got.Users)
	}
}
