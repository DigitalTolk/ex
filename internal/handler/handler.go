package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// JSON is a convenience type for building JSON response objects.
type JSON map[string]interface{}

// writeJSON serialises data as JSON and writes it to the response with the
// given HTTP status code.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

// writeError writes a structured error response.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, JSON{
		"error": JSON{
			"code":    code,
			"message": message,
		},
	})
}

// writeInternalError writes a GENERIC 500 to the client (so wrapped S3/Dynamo/
// OIDC internals never leak), while logging the real error server-side keyed by
// the request ID for diagnosis. Use it for any 5xx whose error is an internal
// chain rather than a user-actionable message.
func writeInternalError(w http.ResponseWriter, r *http.Request, code string, err error) {
	slog.Error("request failed",
		"code", code,
		"requestID", middleware.RequestIDFromContext(r.Context()),
		"method", r.Method,
		"path", r.URL.Path,
		"error", err)
	writeError(w, http.StatusInternalServerError, code, "internal server error")
}

// readJSON decodes the request body (up to 1 MB) into dest.
func readJSON(r *http.Request, dest interface{}) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20) // 1 MB
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	var extra struct{}
	if err := dec.Decode(&extra); err == nil {
		return errors.New("invalid JSON: trailing data")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return nil
}

// maxAgentBodyBytes caps the agent-facing APIs' request bodies. Same 1 MB
// default as readJSON; the runner's event batches get eventBatchBodyBytes.
const (
	maxAgentBodyBytes   int64 = 1 << 20 // 1 MB
	eventBatchBodyBytes int64 = 4 << 20 // 4 MB — a batch carries many tool payloads
)

// readAgentJSON decodes a body from the desktop runner or the run-scoped MCP
// server, bounded at `limit` bytes.
//
// It exists alongside readJSON because those two clients ship as an
// independently-versioned binary: rejecting unknown fields the way readJSON
// does would make any field a newer desktop build adds a hard 400 against an
// older server. The cap is the part that matters here — without it a giant
// JSON string is buffered whole before any field-level clip applies.
func readAgentJSON(r *http.Request, dest interface{}, limit int64) error {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(dest); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return nil
}

// serviceStatus is the ONE mapping from a service sentinel to its HTTP status
// and error code.
//
// Five handler files each grew their own ladder, and they disagreed: the same
// ErrContextFull answered 429 in the runner API and 409 in the SPA API,
// ErrLoginFailed answered 401 in one place and 502 in another (its two
// meanings are now two sentinels), and
// ErrConnectorInvalid meant both 400 and 503. A client cannot be written
// against that. Codes are stable strings the SPA already switches on.
func serviceStatus(err error) (status int, code, message string, ok bool) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return http.StatusNotFound, "not_found", "not found", true
	case errors.Is(err, store.ErrAlreadyExists):
		return http.StatusConflict, "already_exists", "already exists", true
	case errors.Is(err, service.ErrValidation):
		return http.StatusBadRequest, "bad_request", err.Error(), true
	case errors.Is(err, service.ErrForbidden):
		return http.StatusForbidden, "forbidden", "no access", true
	case errors.Is(err, service.ErrNoRunAccess):
		return http.StatusForbidden, "forbidden", "no access to this run", true
	case errors.Is(err, service.ErrContextFull):
		// 409, not 429: the channel's shared context is FULL, which retrying
		// will not fix — nothing here is rate-limited.
		return http.StatusConflict, "context_full", "shared context is full for this channel", true
	case errors.Is(err, service.ErrRunClosed):
		return http.StatusConflict, "run_closed", "run reached a terminal state", true
	case errors.Is(err, service.ErrWrongRunner):
		return http.StatusConflict, "wrong_runner", "run is leased to another runner", true
	case errors.Is(err, service.ErrApprovalSettled):
		return http.StatusConflict, "settled", "approval already settled", true
	case errors.Is(err, service.ErrNotInvoker):
		return http.StatusForbidden, "forbidden", "only the invoker decides this", true
	case errors.Is(err, service.ErrArtifactCap):
		return http.StatusTooManyRequests, "artifact_cap", "per-run artifact cap reached", true
	case errors.Is(err, service.ErrConnectorInvalid):
		return http.StatusBadRequest, "bad_request", err.Error(), true
	case errors.Is(err, service.ErrTokenRejected):
		return http.StatusUnauthorized, "token_rejected", "the service rejected that credential", true
	case errors.Is(err, service.ErrLoginFailed):
		// The external service rejected the CALLER's credentials.
		return http.StatusUnauthorized, "login_failed", err.Error(), true
	case errors.Is(err, service.ErrServiceUnreachable):
		// We could not reach it at all — nothing is wrong with the caller.
		return http.StatusBadGateway, "unreachable", err.Error(), true
	}
	return 0, "", "", false
}

// writeAgentError answers with the shared mapping, or a logged generic 500 for
// anything unmapped — the agent/connector/context surfaces, which have no
// legacy status contract to preserve. fallbackCode names the operation in the
// server log.
func writeAgentError(w http.ResponseWriter, r *http.Request, err error, fallbackCode string) {
	if status, code, message, ok := serviceStatus(err); ok {
		writeError(w, status, code, message)
		return
	}
	writeInternalError(w, r, fallbackCode, err)
}

// writeError2FA is the two-factor challenge response: a 409 carrying the
// access code the client must echo back with the code. It keeps the SAME
// envelope as every other error (error.code / error.message) plus the code —
// the old shape put a bare string in "error", so a client had two error
// grammars to parse on one route.
func writeError2FA(w http.ResponseWriter, accessCode string) {
	writeJSON(w, http.StatusConflict, JSON{
		"error": JSON{
			"code":    "two_factor_required",
			"message": "a two-factor code is required",
		},
		"accessCode": accessCode,
	})
}

// writeRunAccessError maps the orchestrator's run-read outcomes to one status
// set, so "not found", "not yours" and "broken" can't drift apart across the
// handlers that read runs.
func writeRunAccessError(w http.ResponseWriter, r *http.Request, err error, code string) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "run not found")
	case errors.Is(err, service.ErrNoRunAccess):
		writeError(w, http.StatusForbidden, "forbidden", "no access to this run")
	default:
		writeInternalError(w, r, code, err)
	}
}

// pathParam extracts a named path parameter using Go 1.22+ routing.
func pathParam(r *http.Request, name string) string {
	return r.PathValue(name)
}

// queryParam returns a query string parameter, or the fallback if absent.
func queryParam(r *http.Request, name, fallback string) string {
	v := r.URL.Query().Get(name)
	if v == "" {
		return fallback
	}
	return v
}

// requireAdmin writes a 403 to w and returns false unless the request is
// authenticated as a system admin. Use at the top of admin-only handlers.
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil || claims.SystemRole != model.SystemRoleAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "admin only")
		return false
	}
	return true
}

// queryInt returns a query string parameter as an integer, or the fallback on
// parse failure or absence.
func queryInt(r *http.Request, name string, fallback int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func clampInt(n, min, max int) int {
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}
