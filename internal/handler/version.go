package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
)

// AppVersionMetaName is the HTML meta-tag name the SPA reads to learn
// which build it loaded with. The same string is hard-coded on the
// frontend (lib/version-meta.ts) — keep them in sync.
const AppVersionMetaName = "app-version"

// VersionHandler exposes the build version of the running binary so the
// browser can detect when a deploy has rolled out and trigger a reload.
//
// The version string is opaque — the frontend only needs to compare for
// equality with the version it shipped with.
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

// AppVersion derives the build version from the SHA-256 of the embedded
// `index.html`. Vite bakes hashed asset filenames into index.html, so any
// change to any source file or dependency produces a different document
// — and therefore a different version. This replaces the old VERSION
// ldflag dance: the version derives from the artifact itself, not from
// build-time env-var plumbing.
//
// Returns "dev" when the FS is unavailable or index.html can't be read.
// The caller (typically main.go) treats both the version endpoint and
// the SPA's served meta tag as the same string, so the only way for the
// frontend to detect a mismatch is for the bundle to actually change.
func AppVersion(frontendFS fs.FS) string {
	if frontendFS == nil {
		return "dev"
	}
	f, err := frontendFS.Open("index.html")
	if err != nil {
		return "dev"
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "dev"
	}
	// 12 hex chars (48 bits) is plenty for collision avoidance across
	// the rebuild cadence of a single workspace and keeps logs/network
	// frames compact.
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// Get returns {"version": "<build version>"}. No auth — the version is
// not sensitive and the frontend needs to fetch it before login completes.
//
// The version doubles as a strong ETag. Pollers send If-None-Match on
// every tick; once the version stabilises after a deploy, those polls
// resolve to a 0-byte 304 instead of the JSON payload.
func (h *VersionHandler) Get(w http.ResponseWriter, r *http.Request) {
	etag := `"` + h.version + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"version": h.version})
}
