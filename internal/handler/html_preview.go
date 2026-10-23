package handler

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/store"
)

// HTML attachment preview: design mockups (agents post them as .html) shown
// live inside the chat. The file is served from this route as its OWN
// document, never as an <iframe srcdoc>: a srcdoc document inherits the
// embedding page's CSP, which would force the app page to allow every inline
// script. Loaded from the network, the preview runs under htmlPreviewCSP
// alone and the app page keeps a hash-based script-src.
//
// The panel (src/components/chat/HtmlPreviewPanel.tsx) frames it with
// sandbox="allow-scripts" and a per-preview nonce as the frame's name; the
// frame guard on that side is in src/lib/html-preview.ts.

// htmlPreviewRoutePrefix is the route, and the one path the app page's
// frame-src allows (middleware.CSPOptions.FramePath).
const htmlPreviewRoutePrefix = "/api/v1/html-preview/"

// htmlPreviewCSP is the preview document's whole policy:
//   - sandbox allow-scripts: an opaque origin (no cookies, storage or API as
//     the viewer) with forms, popups, top navigation, modals and downloads
//     off, even when the URL is opened outside the app's sandboxed frame;
//   - inline script and style, data:/blob: media, and nothing that can reach
//     the network (no beacon, no remote pixel, no nested frame);
//   - frame-ancestors 'self': only the app may frame it.
const htmlPreviewCSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
	"frame-ancestors 'self'"

// htmlPreviewBeacon is the frame guard's other end: the document's first
// script, ahead of any of the file. It takes the nonce from window.name and
// clears that before the file's scripts run, holds it in a closure and
// removes its own <script> element, so neither the file nor a page it
// navigates to can produce it. It posts "<nonce>:<onLoad>" on the document's
// own trusted load, "<nonce>:gone" on pagehide, and "<nonce>:alive" for every
// message from the parent.
func htmlPreviewBeacon(onLoad string) string {
	return `<script>(function(){` +
		`var p=parent,d=document,n=window.name;window.name="";` +
		`d.currentScript.remove();` +
		`function s(k){p.postMessage(n+":"+k,"*")}` +
		`addEventListener("load",function(e){if(e.isTrusted&&e.target===d)s("` + onLoad + `")},true);` +
		`addEventListener("pagehide",function(){s("gone")},true);` +
		`addEventListener("message",function(e){if(e.source===p)s("alive")},true)` +
		`})()</script>`
}

var (
	// htmlPreviewHead precedes the file. A doctype inside the file is
	// ignored by the parser at that point, which is harmless.
	htmlPreviewHead = []byte("<!doctype html>" + htmlPreviewBeacon("ready"))
	// htmlPreviewFailed is the whole answer when there is no file to show:
	// the panel replaces the frame with its error state.
	htmlPreviewFailed = []byte("<!doctype html>" + htmlPreviewBeacon("failed"))
)

// HTMLPreview handles GET /api/v1/html-preview/{token}/{filename...}: the HTML
// file behind a media token — the same bearer capability as /api/v1/media,
// no cookie involved — as a sandboxed document for the preview frame.
func (h *AttachmentHandler) HTMLPreview(w http.ResponseWriter, r *http.Request) {
	// Only ever as a frame. Opened as a tab, the file would be a scriptable
	// page under the app's own URL, free to draw a fake sign-in and navigate
	// away with what is typed. A browser without Fetch Metadata sends no
	// Sec-Fetch-Dest; it still gets the sandboxed document.
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "iframe" {
		writeError(w, http.StatusBadRequest, "not_a_frame", "HTML previews open only inside the app")
		return
	}
	hdr := w.Header()
	hdr.Set("Content-Security-Policy", htmlPreviewCSP)
	// The Trusted Types report is about the app's own code, not the file's.
	hdr.Del("Content-Security-Policy-Report-Only")
	hdr.Set("X-Frame-Options", "SAMEORIGIN")
	hdr.Set("Content-Type", "text/html; charset=utf-8")
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Content-Disposition", "inline")
	// The head is tied to this server's frame guard; never reuse a copy.
	hdr.Set("Cache-Control", "no-store")

	media, err := h.svc.OpenMedia(r.Context(), pathParam(r, "token"), r.URL.Query().Get("g"), "")
	if err != nil {
		status := http.StatusNotFound
		if !errors.Is(err, store.ErrNotFound) {
			// The path is not logged: the token in it is the credential.
			slog.Error("html preview failed",
				"code", "media_error",
				"requestID", middleware.RequestIDFromContext(r.Context()),
				"error", err)
			status = http.StatusBadGateway
		}
		writeHTMLPreviewFailed(w, status)
		return
	}
	defer func() { _ = media.Body.Close() }()
	if !isHTMLMedia(media.ContentType, media.Filename) {
		writeHTMLPreviewFailed(w, http.StatusUnsupportedMediaType)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(htmlPreviewHead)
	_, _ = io.Copy(w, media.Body)
}

func writeHTMLPreviewFailed(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
	_, _ = w.Write(htmlPreviewFailed)
}

// isHTMLMedia mirrors the client's isHtmlAttachment (src/lib/html-attachment.ts):
// HTML by stored type or by file extension.
func isHTMLMedia(contentType, filename string) bool {
	mediaType, _, _ := mime.ParseMediaType(contentType)
	ext := strings.ToLower(path.Ext(filename))
	return mediaType == "text/html" || ext == ".html" || ext == ".htm"
}
