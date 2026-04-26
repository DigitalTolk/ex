package handler

import "net/http"

// VersionHandler exposes the build version of the running binary so the
// browser can detect when a deploy has rolled out and trigger a reload.
//
// The version string is opaque — the frontend only needs to compare for
// equality with the version it shipped with. We don't enforce any format
// here; CI sets it via -ldflags at build time.
type VersionHandler struct {
	version string
}

// NewVersionHandler builds a VersionHandler that always returns the
// supplied version string. An empty value is replaced with "dev" so the
// endpoint never returns an ambiguous blank.
func NewVersionHandler(version string) *VersionHandler {
	if version == "" {
		version = "dev"
	}
	return &VersionHandler{version: version}
}

// Get returns {"version": "<build version>"}. No auth — the version is
// not sensitive and the frontend needs to fetch it before login completes.
func (h *VersionHandler) Get(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, JSON{"version": h.version})
}
