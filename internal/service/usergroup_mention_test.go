package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/limits"
)

func TestCanonicalizeMentions_TypedHandles(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	oncall := f.create(t, "oncall", "u-1")
	sre := f.create(t, "sre.team", "u-2")
	off := f.create(t, "off", "u-3")
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, off.ID, false); err != nil {
		t.Fatal(err)
	}
	tok := func(id, handle string) string { return "@[" + id + "|" + handle + "]" }

	cases := map[string]string{
		"ping @oncall now":                        "ping " + tok(oncall.ID, "oncall") + " now",
		"@OnCall at the start":                    tok(oncall.ID, "oncall") + " at the start",
		"end of sentence @oncall.":                "end of sentence " + tok(oncall.ID, "oncall") + ".",
		"dotted handle @sre.team, please":         "dotted handle " + tok(sre.ID, "sre.team") + ", please",
		"(@oncall)":                               "(" + tok(oncall.ID, "oncall") + ")",
		"twice @oncall @oncall":                   "twice " + tok(oncall.ID, "oncall") + " " + tok(oncall.ID, "oncall"),
		"disabled @off stays":                     "disabled @off stays",
		"unknown @nobody stays":                   "unknown @nobody stays",
		"broadcast @here and @all stay":           "broadcast @here and @all stay",
		"email ops@oncall stays":                  "email ops@oncall stays",
		"url https://x.com/@oncall stays":         "url https://x.com/@oncall stays",
		"inline `@oncall` stays":                  "inline `@oncall` stays",
		"```\n@oncall\n```":                       "```\n@oncall\n```",
		"[link](https://x.com/@oncall) stays":     "[link](https://x.com/@oncall) stays",
		"<https://x.com/@oncall>":                 "<https://x.com/@oncall>",
		"token " + tok(oncall.ID, "oncall") + "!": "token " + tok(oncall.ID, "oncall") + "!",
		"~[C1|general] and @oncall":               "~[C1|general] and " + tok(oncall.ID, "oncall"),
		"no handles at all":                       "no handles at all",
	}
	for in, want := range cases {
		if got := f.svc.CanonicalizeMentions(ctx, "u-1", in); got != want {
			t.Errorf("CanonicalizeMentions(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCanonicalizeMentions_GuestsAndFailuresLeaveTheBody(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.create(t, "oncall", "u-1")
	body := "ping @oncall"
	if got := f.svc.CanonicalizeMentions(ctx, "u-guest", body); got != body {
		t.Errorf("guest body = %q, want it unchanged", got)
	}
	f.people.err = errors.New("users down")
	if got := f.svc.CanonicalizeMentions(ctx, "u-1", body); got != body {
		t.Errorf("author lookup failure = %q, want it unchanged", got)
	}
	f.people.err = nil
	f.store.ownerErr = errors.New("boom")
	if got := f.svc.CanonicalizeMentions(ctx, "u-1", body); got != body {
		t.Errorf("handle lookup failure = %q, want it unchanged", got)
	}
	f.store.ownerErr = nil
	f.store.batchErr = errors.New("boom")
	if got := f.svc.CanonicalizeMentions(ctx, "u-1", body); got != body {
		t.Errorf("group read failure = %q, want it unchanged", got)
	}
}

func TestCanonicalizeMentions_NoLookupWithoutCandidates(t *testing.T) {
	f := newUserGroupFixture()
	for _, body := range []string{"plain text", "only @all here", "`@code`"} {
		f.svc.CanonicalizeMentions(context.Background(), "u-1", body)
	}
	if f.people.calls != 0 {
		t.Fatalf("looked up the author %d times for bodies without handles", f.people.calls)
	}
}

func TestCanonicalizeMentions_BoundsLookupsAndLength(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	oncall := f.create(t, "oncall", "u-1")

	var b strings.Builder
	for i := range maxTypedHandleLookups + 5 {
		b.WriteString("@h")
		b.WriteString(strings.Repeat("x", i+1))
		b.WriteString(" ")
	}
	b.WriteString("@oncall")
	// The 26th distinct handle is past the lookup budget: left as typed.
	if got := f.svc.CanonicalizeMentions(ctx, "u-1", b.String()); strings.Contains(got, oncall.ID) {
		t.Errorf("a handle past the lookup budget was converted: %q", got)
	}

	// A body the tokens would push past the cap is stored as typed.
	long := strings.Repeat("a", limits.MaxMessageBodyChars-len(" @oncall")) + " @oncall"
	if got := f.svc.CanonicalizeMentions(ctx, "u-1", long); strings.Contains(got, oncall.ID) {
		t.Error("conversion pushed the body past the length cap")
	}
}
