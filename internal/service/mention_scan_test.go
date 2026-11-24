package service

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// mentionScanCase is one case of the fixture the Go and TypeScript scanners
// both run (src/lib/mention-syntax.test.ts reads the same file).
type mentionScanCase struct {
	Name   string `json:"name"`
	Text   string `json:"text"`
	Tokens []struct {
		Kind  string `json:"kind"`
		ID    string `json:"id"`
		Label string `json:"label"`
		Raw   string `json:"raw"`
	} `json:"tokens"`
}

func loadMentionScanCases(t *testing.T) []mentionScanCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/mention_scan_cases.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []mentionScanCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return cases
}

func TestScanMentions_SharedFixture(t *testing.T) {
	for _, tc := range loadMentionScanCases(t) {
		t.Run(tc.Name, func(t *testing.T) {
			got := ScanMentions(tc.Text)
			if len(got) != len(tc.Tokens) {
				t.Fatalf("ScanMentions(%q) = %d tokens, want %d: %+v", tc.Text, len(got), len(tc.Tokens), got)
			}
			for i, want := range tc.Tokens {
				tok := got[i]
				kind := "user"
				if tok.Kind == MentionTokenUserGroup {
					kind = "usergroup"
				}
				if kind != want.Kind || tok.ID != want.ID || tok.Label != want.Label || tc.Text[tok.Start:tok.End] != want.Raw {
					t.Errorf("token %d = {%s %q %q %q}, want {%s %q %q %q}", i, kind, tok.ID, tok.Label, tc.Text[tok.Start:tok.End], want.Kind, want.ID, want.Label, want.Raw)
				}
			}
		})
	}
}

func TestIsUserGroupID(t *testing.T) {
	for id, want := range map[string]bool{"group-01J": true, "01JGROUP": false, "bot-group-x": false, "": false} {
		if got := IsUserGroupID(id); got != want {
			t.Errorf("IsUserGroupID(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestReplaceMentions_SplicesEveryToken(t *testing.T) {
	text := "a @[U1|Ann] b @[group-G|ops] c"
	got := ReplaceMentions(text, func(tok MentionToken) string { return "<" + tok.ID + ">" })
	if want := "a <U1> b <group-G> c"; got != want {
		t.Fatalf("ReplaceMentions = %q, want %q", got, want)
	}
	if plain := "no tokens here"; ReplaceMentions(plain, nil) != plain {
		t.Fatal("ReplaceMentions changed a text without tokens")
	}
}

func TestPlainMentions_FlattensUsersAndGroups(t *testing.T) {
	got := PlainMentions("@[U1|Ann] paged @[group-G|oncall] and ~[C1|ops]")
	if want := "@Ann paged @oncall and ~[C1|ops]"; got != want {
		t.Fatalf("PlainMentions = %q, want %q", got, want)
	}
}

func TestParseMentions_SplitsUserGroupsFromUsers(t *testing.T) {
	got := ParseMentions("@[U1|Ann] @[group-G1| oncall ] @[group-G1|oncall] @[U1|Ann] @[group-G2|sre] `@[group-G3|code]` @here")
	wantUsers := []MentionUser{{UserID: "U1", DisplayName: "Ann"}}
	wantGroups := []MentionUserGroup{{ID: "group-G1", Handle: "oncall"}, {ID: "group-G2", Handle: "sre"}}
	if !reflect.DeepEqual(got.Users, wantUsers) {
		t.Errorf("Users = %+v, want %+v", got.Users, wantUsers)
	}
	if !reflect.DeepEqual(got.UserGroups, wantGroups) {
		t.Errorf("UserGroups = %+v, want %+v", got.UserGroups, wantGroups)
	}
	if !got.Here || got.All {
		t.Errorf("flags = all %v here %v, want here only", got.All, got.Here)
	}
}

func TestParsedMentions_EmptyCountsUserGroups(t *testing.T) {
	if (ParsedMentions{UserGroups: []MentionUserGroup{{ID: "group-G"}}}).Empty() {
		t.Fatal("a message mentioning only a user group reads as mentioning nobody")
	}
	if !(ParsedMentions{}).Empty() {
		t.Fatal("no mentions reads as non-empty")
	}
}
