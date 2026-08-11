package handler

import (
	"testing"

	"github.com/DigitalTolk/ex/internal/store"
)

// classifyConfirm gates a cross-app write, so its edge cases matter: a reply
// carrying extra instruction must NOT be read as a bare "yes" (that would run the
// un-amended write), and "no"-prefixed words must not be read as "no".
func TestClassifyConfirm(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		// Affirmations.
		{"yes", confirmYes},
		{"Yes.", confirmYes},
		{"YES!", confirmYes},
		{"y", confirmYes},
		{"yep", confirmYes},
		{"ok", confirmYes},
		{"sure", confirmYes},
		{"go ahead", confirmYes},
		{"do it", confirmYes},
		{"confirm", confirmYes},
		// Negations.
		{"no", confirmNo},
		{"n", confirmNo},
		{"nope", confirmNo},
		{"cancel", confirmNo},
		{"don't", confirmNo},
		{"stop", confirmNo},
		// Must fall through (NOT a bare confirmation) so a correction is honored.
		{"yes, but change the title first", confirmNone},
		{"yes but make it urgent", confirmNone},
		{"do it, and assign to me", confirmNone},
		// "no"-prefixed words that are NOT negations.
		{"now do it", confirmNone},
		{"note that it's urgent", confirmNone},
		{"nothing else for now", confirmNone},
		// Neither.
		{"", confirmNone},
		{"maybe later", confirmNone},
		{"what did that create?", confirmNone},
	}
	for _, tc := range cases {
		if got := classifyConfirm(tc.in); got != tc.want {
			t.Errorf("classifyConfirm(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// sameWriteTarget guards the repair path: an agent-regenerated proposal may only
// correct the body of the action the user approved, never redirect to a
// different verb or resource.
func TestSameWriteTarget(t *testing.T) {
	approved := &store.CliffyPendingWrite{Method: "POST", Path: "api/tasks"}
	cases := []struct {
		name     string
		repaired *store.CliffyPendingWrite
		want     bool
	}{
		{"same method+path", &store.CliffyPendingWrite{Method: "POST", Path: "api/tasks"}, true},
		{"method case-insensitive", &store.CliffyPendingWrite{Method: "post", Path: "api/tasks"}, true},
		{"leading-slash normalized", &store.CliffyPendingWrite{Method: "POST", Path: "/api/tasks"}, true},
		{"different verb rejected", &store.CliffyPendingWrite{Method: "DELETE", Path: "api/tasks"}, false},
		{"different resource rejected", &store.CliffyPendingWrite{Method: "POST", Path: "api/projects"}, false},
		{"nil repaired rejected", nil, false},
	}
	for _, tc := range cases {
		if got := sameWriteTarget(tc.repaired, approved); got != tc.want {
			t.Errorf("%s: sameWriteTarget = %v, want %v", tc.name, got, tc.want)
		}
	}
}
