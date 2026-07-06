package handler

import (
	"testing"
)

// The Connect error-arm tests that need a live broker (and therefore the
// shared Redis container) live in ws_error_integration_test.go.

// TestWSHandler_SetOriginPolicy_SkipsEmptyPattern covers the `if p == ""`
// continue arm in SetOriginPolicy: a blank entry is dropped without being
// added to the allowlist and without enabling the wildcard.
func TestWSHandler_SetOriginPolicy_SkipsEmptyPattern(t *testing.T) {
	h := &WSHandler{}
	h.SetOriginPolicy([]string{"", "app.example.com", ""})
	if h.allowAllOrigin {
		t.Fatal("blank patterns must not enable wildcard")
	}
	if len(h.originPatterns) != 1 || h.originPatterns[0] != "app.example.com" {
		t.Fatalf("originPatterns = %v, want [app.example.com] (blanks skipped)", h.originPatterns)
	}
}
