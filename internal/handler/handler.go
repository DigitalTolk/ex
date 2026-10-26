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
// the request ID for diagnosis. writeServiceError ends here for any error the
// table does not map; call it directly only for a failure that is not a
// service's (encoding a response, signing a token in the handler). The path is
// logged redacted: a webhook's or media link's secret rides in it.
func writeInternalError(w http.ResponseWriter, r *http.Request, code string, err error) {
	slog.ErrorContext(r.Context(), "request failed",
		"code", code,
		"requestID", middleware.RequestIDFromContext(r.Context()),
		"method", r.Method,
		"path", middleware.RedactPath(r.URL.Path),
		"error", err)
	writeError(w, http.StatusInternalServerError, code, "internal server error")
}

// readJSON decodes the request body (up to 1 MB) into dest.
func readJSON(r *http.Request, dest interface{}) error {
	return readJSONLimit(r, dest, 1<<20) // 1 MB
}

// readJSONLimit is readJSON with a route-specific body cap, for endpoints whose
// valid bodies are far smaller than 1 MB.
func readJSONLimit(r *http.Request, dest interface{}, limit int64) error {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
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
// The role it reads is the STORED one: the auth middleware
// (AuthWithUserStatus) replaces the access token's role claim with the
// user store's on every request, so a demotion takes effect immediately
// instead of when the 15-minute token expires.
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
