package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// htmlPreviewToken stores one attachment whose object is body and returns a
// handler for it plus its media token.
func htmlPreviewToken(t *testing.T, filename, contentType, body string) (*AttachmentHandler, string) {
	t.Helper()
	st := newFakeAttachmentStore()
	key := "attachments/" + filename
	signer := &fakeSigner{objects: map[string][]byte{key: []byte(body)}, objectTypes: map[string]string{key: contentType}}
	svc := service.NewAttachmentService(st, signer, nil)
	svc.SetMediaURLCache(newFakeMediaCacheH())
	att := &model.Attachment{
		ID: "a-" + filename, SHA256: "sha-" + filename, S3Key: key,
		Filename: filename, ContentType: contentType, Size: int64(len(body)), CreatedBy: "u1",
	}
	if err := st.Create(context.Background(), att); err != nil {
		t.Fatalf("Create: %v", err)
	}
	resolved, err := svc.Get(context.Background(), att.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	parts := strings.Split(resolved.URL, "/")
	return NewAttachmentHandler(svc), parts[len(parts)-2]
}

// previewRequest is what the panel's <iframe> sends.
func previewRequest(token, filename string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, htmlPreviewRoutePrefix+token+"/"+filename, nil)
	req.SetPathValue("token", token)
	req.Header.Set("Sec-Fetch-Dest", "iframe")
	return req
}

func serveHTMLPreview(h *AttachmentHandler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.HTMLPreview(rec, req)
	return rec
}

// Every preview answer — the file or the failure notice — is a sandboxed,
// network-less document that only the app itself may frame.
func assertHTMLPreviewHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for name, want := range map[string]string{
		"Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
			"img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
			"frame-ancestors 'self'",
		"Content-Type":           "text/html; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "SAMEORIGIN",
		"Content-Disposition":    "inline",
		"Cache-Control":          "no-store",
	} {
		if got := rec.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestHTMLPreview_ServesTheFileAsItsOwnSandboxedDocument(t *testing.T) {
	const file = "<!DOCTYPE html><html><head><title>Mockup</title></head><body><h1>Hi</h1></body></html>"
	h, token := htmlPreviewToken(t, "mockup.html", "text/html", file)
	// A Range from a confused client still gets the whole document.
	req := previewRequest(token, "mockup.html")
	req.Header.Set("Range", "bytes=0-3")
	rec := serveHTMLPreview(h, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	assertHTMLPreviewHeaders(t, rec)
	if got, want := rec.Body.String(), "<!doctype html>"+htmlPreviewBeacon("ready")+file; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if rec.Header().Get("Content-Range") != "" {
		t.Errorf("served a range: %q", rec.Header().Get("Content-Range"))
	}
}

// The beacon is the frame guard's other end (src/lib/html-preview.ts): it
// must run before any of the file and keep the nonce from the file's scripts.
func TestHTMLPreview_BeaconTakesTheNonceFromTheFrameName(t *testing.T) {
	beacon := htmlPreviewBeacon("ready")
	for _, want := range []string{
		// The nonce arrives as the frame's name and is wiped before the file runs.
		`n=window.name;window.name="";`,
		// It hides itself.
		`d.currentScript.remove();`,
		// Only the document's own trusted load reports.
		`if(e.isTrusted&&e.target===d)s("ready")`,
		`addEventListener("pagehide",function(){s("gone")},true)`,
		`addEventListener("message",function(e){if(e.source===p)s("alive")},true)`,
	} {
		if !strings.Contains(beacon, want) {
			t.Errorf("beacon lacks %q: %s", want, beacon)
		}
	}
	if !strings.HasPrefix(beacon, "<script>") || !strings.HasSuffix(beacon, "</script>") {
		t.Errorf("beacon is not one inline script: %s", beacon)
	}
	if got := htmlPreviewBeacon("failed"); !strings.Contains(got, `s("failed")`) || strings.Contains(got, `s("ready")`) {
		t.Errorf("failure beacon = %s", got)
	}
}

// The panel offers Preview for an .html name whatever type it was stored as.
func TestHTMLPreview_RecognisesHTMLByExtension(t *testing.T) {
	h, token := htmlPreviewToken(t, "Mockup.HTM", "application/octet-stream", "<p>x</p>")
	rec := serveHTMLPreview(h, previewRequest(token, "Mockup.HTM"))
	if rec.Code != http.StatusOK || !strings.HasSuffix(rec.Body.String(), "<p>x</p>") {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
	h, token = htmlPreviewToken(t, "page", "Text/HTML; charset=iso-8859-1", "<p>y</p>")
	if rec := serveHTMLPreview(h, previewRequest(token, "page")); rec.Code != http.StatusOK {
		t.Fatalf("text/html by type: status %d", rec.Code)
	}
}

func assertHTMLPreviewFailed(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d", rec.Code, status)
	}
	assertHTMLPreviewHeaders(t, rec)
	if got, want := rec.Body.String(), "<!doctype html>"+htmlPreviewBeacon("failed"); got != want {
		t.Fatalf("body = %q, want the failure document %q", got, want)
	}
}

// Only HTML is ever rendered by this route: an image, SVG or text file under
// a valid token is refused, not run as a page.
func TestHTMLPreview_RefusesWhatIsNotHTML(t *testing.T) {
	for name, ct := range map[string]string{"pic.png": "image/png", "logo.svg": "image/svg+xml", "notes.txt": "text/plain"} {
		h, token := htmlPreviewToken(t, name, ct, "<script>alert(1)</script>")
		assertHTMLPreviewFailed(t, serveHTMLPreview(h, previewRequest(token, name)), http.StatusUnsupportedMediaType)
	}
}

func TestHTMLPreview_UnknownTokenIsAFailedDocument(t *testing.T) {
	h, _ := htmlPreviewToken(t, "mockup.html", "text/html", "<p>x</p>")
	assertHTMLPreviewFailed(t, serveHTMLPreview(h, previewRequest("expired", "mockup.html")), http.StatusNotFound)
}

func TestHTMLPreview_StorageFailureIsAFailedDocument(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	mc := newFakeMediaCacheH()
	mc.getErr = errors.New("redis exploded")
	svc.SetMediaURLCache(mc)
	assertHTMLPreviewFailed(t, serveHTMLPreview(NewAttachmentHandler(svc), previewRequest("some-token", "x.html")), http.StatusBadGateway)
}

// Opened as a tab, a mockup would be a scriptable page under the app's own
// URL (a fake sign-in that navigates away with what was typed). A browser
// that says what it is loading gets the document only for a frame; one that
// sends no Fetch Metadata still gets the sandboxed document.
func TestHTMLPreview_OnlyForAFrame(t *testing.T) {
	h, token := htmlPreviewToken(t, "mockup.html", "text/html", "<p>x</p>")
	for _, dest := range []string{"document", "empty", "script", "frame"} {
		req := previewRequest(token, "mockup.html")
		req.Header.Set("Sec-Fetch-Dest", dest)
		rec := serveHTMLPreview(h, req)
		if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), "<p>x</p>") {
			t.Fatalf("Sec-Fetch-Dest %s: status %d body %q", dest, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != "" {
			t.Fatalf("Sec-Fetch-Dest %s: refusal carries the preview policy %q", dest, got)
		}
	}
	req := previewRequest(token, "mockup.html")
	req.Header.Del("Sec-Fetch-Dest")
	if rec := serveHTMLPreview(h, req); rec.Code != http.StatusOK {
		t.Fatalf("no Fetch Metadata: status %d", rec.Code)
	}
}

// previewRouter is the full router with the attachment routes and an SPA.
func previewRouter(t *testing.T, h *AttachmentHandler, index string, baseURL string) http.Handler {
	t.Helper()
	var frontendFS fs.FS = fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(index)}}
	return NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: setupJWTManager(), FrontendFS: frontendFS, AppVersion: "test", AllowOrigins: []string{"*"},
		Attachment: h, BaseURL: baseURL,
	})
}

// Through the whole middleware stack the preview keeps its own policy: the
// app page's CSP, frame-ancestors 'none' / X-Frame-Options DENY and Trusted
// Types report never reach it.
func TestHTMLPreview_RouteKeepsItsOwnPolicyBehindTheMiddleware(t *testing.T) {
	h, token := htmlPreviewToken(t, "mockup.html", "text/html", "<p>x</p>")
	router := previewRouter(t, h, "<html><head></head></html>", "")
	req := httptest.NewRequest(http.MethodGet, htmlPreviewRoutePrefix+token+"/mockup.html", nil)
	req.Header.Set("Sec-Fetch-Dest", "iframe")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.HasSuffix(rec.Body.String(), "<p>x</p>") {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
	assertHTMLPreviewHeaders(t, rec)
	if got := rec.Header().Get("Content-Security-Policy-Report-Only"); got != "" {
		t.Errorf("Content-Security-Policy-Report-Only = %q, want none", got)
	}
	if got := rec.Header().Values("Content-Security-Policy"); len(got) != 1 {
		t.Errorf("Content-Security-Policy sent %d times: %q", len(got), got)
	}
}

func pageFrameSrc(t *testing.T, router http.Handler, host string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	for _, part := range strings.Split(rec.Header().Get("Content-Security-Policy"), ";") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(part), "frame-src "); ok {
			return v
		}
	}
	t.Fatalf("no frame-src in %q", rec.Header().Get("Content-Security-Policy"))
	return ""
}

// The app page may frame the preview route — on the host the browser asked
// for and on the configured public host — and nothing else.
func TestRouterCSPFramesOnlyThePreviewRoute(t *testing.T) {
	h, _ := htmlPreviewToken(t, "mockup.html", "text/html", "<p>x</p>")
	router := previewRouter(t, h, "<html><head></head></html>", "https://chat.example.com")
	if got, want := pageFrameSrc(t, router, "localhost:8080"),
		"chat.example.com/api/v1/html-preview/ localhost:8080/api/v1/html-preview/"; got != want {
		t.Errorf("frame-src = %q, want %q", got, want)
	}
	if got, want := pageFrameSrc(t, previewRouter(t, h, "<html></html>", ""), "chat.example.com"),
		"chat.example.com/api/v1/html-preview/"; got != want {
		t.Errorf("frame-src without a public URL = %q, want %q", got, want)
	}
	// No attachment routes, no preview, no frames.
	if got := pageFrameSrc(t, previewRouter(t, nil, "<html></html>", "https://chat.example.com"), "localhost:8080"); got != "'none'" {
		t.Errorf("frame-src without attachments = %q, want 'none'", got)
	}
}

// The browser suites (src/test/html-preview-server.ts) serve the preview
// and a probe page with exactly what this server sends: headers and bytes
// from this golden. Regenerate with UPDATE_GOLDEN=1 after changing them.
func TestHTMLPreviewContractGolden(t *testing.T) {
	h, token := htmlPreviewToken(t, "mockup.html", "text/html", "")
	router := previewRouter(t, h, cspProbePage, "")
	serve := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Sec-Fetch-Dest", "iframe")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	ok := serve(htmlPreviewRoutePrefix + token + "/mockup.html")
	failed := serve(htmlPreviewRoutePrefix + "expired/mockup.html")
	page := serve("/")
	if ok.Code != http.StatusOK || failed.Code != http.StatusNotFound || page.Code != http.StatusOK {
		t.Fatalf("statuses: preview %d, failed %d, page %d", ok.Code, failed.Code, page.Code)
	}
	headers := map[string]string{}
	for _, name := range []string{"Cache-Control", "Content-Disposition", "Content-Security-Policy", "Content-Type", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options"} {
		headers[name] = ok.Header().Get(name)
		if failed.Header().Get(name) != headers[name] {
			t.Fatalf("%s differs between the file and the failure document", name)
		}
	}
	contract := map[string]any{
		"preview": map[string]any{
			"headers": headers,
			// An empty file: the whole body is what precedes every file.
			"head":   ok.Body.String(),
			"failed": failed.Body.String(),
		},
		"page": map[string]any{
			"host": "example.com", // httptest's Host; the browser server swaps in its own
			"html": page.Body.String(),
			"csp":  page.Header().Get("Content-Security-Policy"),
		},
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // keep the markup readable in review
	enc.SetIndent("", "  ")
	if err := enc.Encode(contract); err != nil {
		t.Fatalf("encode: %v", err)
	}
	raw := buf.Bytes()
	path := filepath.Join("..", "..", "src", "test", "wire-fixtures", "html_preview_contract.json")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run with UPDATE_GOLDEN=1 to create it): %v", err)
	}
	if string(want) != string(raw) {
		t.Fatalf("%s is stale; rerun with UPDATE_GOLDEN=1.\nwant:\n%s\ngot:\n%s", path, want, raw)
	}
}

// cspProbePage stands in for index.html in the browser probe of the app
// page's policy (src/test/page-csp.browser.test.ts): its one inline script,
// allowed by hash, reports what the policy did to the test.
const cspProbePage = `<!doctype html><html><head></head><body><script>` +
	`addEventListener("securitypolicyviolation",function(e){parent.postMessage({csp:"violation",directive:e.effectiveDirective,blocked:e.blockedURI},"*")});` +
	`addEventListener("message",function(e){if(e.source!==parent)parent.postMessage({csp:"child",data:e.data},"*")});` +
	`parent.postMessage({csp:"hashed"},"*");` +
	`</script></body></html>`
