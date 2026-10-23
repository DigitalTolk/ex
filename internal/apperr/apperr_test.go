package apperr

import (
	"errors"
	"fmt"
	"testing"
)

// A Rejection reads as its message and still matches its kind, however deep
// it sits in a chain.
func TestRejectionMatchesItsKind(t *testing.T) {
	for _, tc := range []struct {
		err  error
		kind error
		msg  string
	}{
		{Forbidden("channel: owner cannot leave the channel"), ErrForbidden, "channel: owner cannot leave the channel"},
		{Invalid("name must be %d chars", 3), ErrValidation, "name must be 3 chars"},
		{NotFound("no agent @%s", "gg"), ErrNotFound, "no agent @gg"},
		{Conflict("still referenced"), ErrConflict, "still referenced"},
		{Reject(ErrAlreadyExists, "taken"), ErrAlreadyExists, "taken"},
	} {
		wrapped := fmt.Errorf("svc: op: %w", tc.err)
		if !errors.Is(wrapped, tc.kind) {
			t.Errorf("%v does not match its kind %v", tc.err, tc.kind)
		}
		if tc.err.Error() != tc.msg {
			t.Errorf("Error() = %q, want %q", tc.err.Error(), tc.msg)
		}
		if got, ok := Message(wrapped, tc.kind); !ok || got != tc.msg {
			t.Errorf("Message = %q, %v; want %q", got, ok, tc.msg)
		}
	}
}

// Message speaks only for a Rejection of the asked kind — a bare sentinel or
// a refusal of another kind has no user-facing text to offer.
func TestMessageOnlyForTheAskedKind(t *testing.T) {
	if _, ok := Message(fmt.Errorf("x: %w", ErrForbidden), ErrForbidden); ok {
		t.Error("a bare sentinel carries no rejection message")
	}
	if _, ok := Message(Forbidden("no"), ErrValidation); ok {
		t.Error("a forbidden rejection must not answer for validation")
	}
	// A rejection whose kind wraps the asked kind still speaks for it.
	derived := fmt.Errorf("%w: archived", ErrConflict)
	if msg, ok := Message(Reject(derived, "read-only"), ErrConflict); !ok || msg != "read-only" {
		t.Errorf("derived kind: %q, %v", msg, ok)
	}
}

// Each kind is its own value: none matches another.
func TestKindsAreDistinct(t *testing.T) {
	kinds := []error{ErrNotFound, ErrAlreadyExists, ErrForbidden, ErrValidation, ErrConflict}
	for i, a := range kinds {
		for j, b := range kinds {
			if i != j && errors.Is(a, b) {
				t.Errorf("%v matches %v", a, b)
			}
		}
	}
}
