package handler

import (
	"encoding/json"
	"fmt"
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

// readJSON decodes the request body (up to 1 MB) into dest.
func readJSON(r *http.Request, dest interface{}) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20) // 1 MB
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return nil
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
