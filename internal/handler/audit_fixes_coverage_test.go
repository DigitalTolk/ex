package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// Coverage for the audit-driven handler fixes: the shared sentinel→status
// table (one sentinel, one status, everywhere), the standard two-factor
// envelope, and the bounded post-idempotency map.

// writeServiceError's table is the single mapping five handler files used to
// each have their own version of — and disagree about.
func TestServiceStatusTable(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"not found", store.ErrNotFound, http.StatusNotFound, "not_found"},
		{"already exists", store.ErrAlreadyExists, http.StatusConflict, "already_exists"},
		{"validation", service.ErrValidation, http.StatusBadRequest, "bad_request"},
		{"forbidden", service.ErrForbidden, http.StatusForbidden, "forbidden"},
		{"no run access", agents.ErrNoRunAccess, http.StatusForbidden, "forbidden"},
		{"context full", agents.ErrContextFull, http.StatusConflict, "context_full"},
		{"run closed", agents.ErrRunClosed, http.StatusConflict, "run_closed"},
		{"wrong runner", agents.ErrWrongRunner, http.StatusConflict, "wrong_runner"},
		{"approval settled", agents.ErrApprovalSettled, http.StatusConflict, "settled"},
		{"not invoker", agents.ErrNotInvoker, http.StatusForbidden, "forbidden"},
		{"artifact cap", agents.ErrArtifactCap, http.StatusTooManyRequests, "artifact_cap"},
		{"connector invalid", agents.ErrConnectorInvalid, http.StatusBadRequest, "bad_request"},
		{"token rejected", agents.ErrTokenRejected, http.StatusUnauthorized, "token_rejected"},
		{"login failed", agents.ErrLoginFailed, http.StatusUnauthorized, "login_failed"},
		{"service unreachable", agents.ErrServiceUnreachable, http.StatusFailedDependency, "unreachable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, ok := lookupError(c.err)
			if !ok || m.status != c.status || m.code != c.code {
				t.Fatalf("lookupError(%v) = %d/%q ok=%v, want %d/%q", c.err, m.status, m.code, ok, c.status, c.code)
			}
			// And the writer answers with the same thing.
			rec := httptest.NewRecorder()
			writeServiceError(rec, httptest.NewRequest(http.MethodPost, "/x", nil), c.err)
			if rec.Code != c.status {
				t.Fatalf("writeServiceError status = %d, want %d", rec.Code, c.status)
			}
		})
	}

	// Anything unmapped is a LOGGED generic 500, never a leaked chain.
	if _, ok := lookupError(errors.New("some wrapped store failure")); ok {
		t.Fatal("an unmapped error must not claim a status")
	}
	rec := httptest.NewRecorder()
	writeServiceError(rec, httptest.NewRequest(http.MethodPost, "/x", nil), errors.New("dynamo: table gone"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unmapped status = %d", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "table gone") {
		t.Fatalf("the internal chain leaked to the caller: %s", body)
	}
}

// The two-factor challenge keeps the standard error envelope plus the access
// code, so a client has ONE error grammar to parse on that route.
func TestWriteError2FAEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError2FA(rec, "AC42")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`"code":"two_factor_required"`, `"message":`, `"accessCode":"AC42"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
}

// The post-dedup map is bounded and FIFO-evicted, and claiming a key is
// atomic: the old code checked, released the lock, posted, then set — so two
// retries of the same post both passed the check and posted twice.
func TestPostIdempotencyClaim(t *testing.T) {
	h := &AgentRunToolHandler{posts: map[string]string{}}

	if prev, ok := h.claimPost("k1"); !ok || prev != "" {
		t.Fatalf("first claim = %q %v", prev, ok)
	}
	// A concurrent retry sees the claim while the post is still in flight.
	if prev, ok := h.claimPost("k1"); ok || prev != "" {
		t.Fatalf("in-flight retry = %q %v, want not-ok", prev, ok)
	}
	h.posts["k1"] = "m-1"
	if prev, ok := h.claimPost("k1"); ok || prev != "m-1" {
		t.Fatalf("settled retry = %q %v, want m-1 and not-ok", prev, ok)
	}

	// A failed post releases the key so a retry can go through.
	if _, ok := h.claimPost("k2"); !ok {
		t.Fatal("claim k2")
	}
	h.forgetPost("k2")
	if _, ok := h.claimPost("k2"); !ok {
		t.Fatal("a released key must be claimable again")
	}
	h.forgetPost("no-such-key") // no-op

	// The map is bounded: the oldest keys fall off.
	for i := 0; i < maxPostIdempotencyKeys+10; i++ {
		h.claimPost("bulk-" + strings.Repeat("x", i%5) + string(rune('a'+i%26)) + string(rune('0'+i/26%10)) + string(rune('0'+i/260)))
	}
	if len(h.posts) > maxPostIdempotencyKeys {
		t.Fatalf("map grew past its bound: %d entries", len(h.posts))
	}
	if len(h.postKeys) > maxPostIdempotencyKeys {
		t.Fatalf("key ring grew past its bound: %d entries", len(h.postKeys))
	}
}

// A run-tool failure's default arm is a LOGGED generic 500. It used to be a
// blanket 400 carrying err.Error() — an internal chain handed back to the
// caller as a "bad request", with nothing recorded server-side.
func TestWriteToolErrorArms(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"not found", store.ErrNotFound, http.StatusNotFound, "not_found"},
		{"run closed", agents.ErrRunClosed, http.StatusConflict, "run_closed"},
		{"validation", service.ErrValidation, http.StatusBadRequest, "bad_request"},
		{"internal", errors.New("dynamo: table vanished"), http.StatusInternalServerError, "internal server error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeServiceError(rec, httptest.NewRequest(http.MethodPost, "/x", nil), c.err)
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.body) {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if c.status == http.StatusInternalServerError && strings.Contains(rec.Body.String(), "table vanished") {
				t.Fatalf("the internal chain leaked: %s", rec.Body.String())
			}
		})
	}
}
