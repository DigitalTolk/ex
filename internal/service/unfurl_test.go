package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestScrapePreview_OpenGraph(t *testing.T) {
	html := `<html><head>
		<meta property="og:title" content="Hello World">
		<meta property="og:description" content="A friendly page">
		<meta property="og:image" content="https://example.com/cover.jpg">
		<meta property="og:site_name" content="Example">
		<title>fallback title</title>
	</head><body>x</body></html>`
	p := scrapePreview(html, "https://example.com/post")
	if p.Title != "Hello World" {
		t.Errorf("title = %q, want Hello World", p.Title)
	}
	if p.Description != "A friendly page" {
		t.Errorf("description = %q", p.Description)
	}
	if p.Image != "https://example.com/cover.jpg" {
		t.Errorf("image = %q", p.Image)
	}
	if p.SiteName != "Example" {
		t.Errorf("siteName = %q", p.SiteName)
	}
}

func TestScrapePreview_FallsBackToTitleAndMetaDescription(t *testing.T) {
	html := `<html><head>
		<title>Just a title</title>
		<meta name="description" content="legacy description">
	</head></html>`
	p := scrapePreview(html, "https://example.com")
	if p.Title != "Just a title" {
		t.Errorf("title = %q", p.Title)
	}
	if p.Description != "legacy description" {
		t.Errorf("description = %q", p.Description)
	}
}

func TestScrapePreview_TwitterCardFallback(t *testing.T) {
	html := `<meta name="twitter:title" content="Tweet"><meta name="twitter:image" content="i.jpg">`
	p := scrapePreview(html, "https://example.com")
	if p.Title != "Tweet" || p.Image != "i.jpg" {
		t.Errorf("twitter fallback: %+v", p)
	}
}

func TestUnfurlService_RejectsPrivateIPs(t *testing.T) {
	svc := NewUnfurlService(newFakeUnfurlCache())
	if _, err := svc.Unfurl(context.Background(), "http://127.0.0.1/"); err == nil {
		t.Error("expected SSRF guard to block loopback")
	}
	if _, err := svc.Unfurl(context.Background(), "http://10.0.0.1/"); err == nil {
		t.Error("expected SSRF guard to block private")
	}
}

func TestUnfurlService_RejectsNonHTTPScheme(t *testing.T) {
	svc := NewUnfurlService(newFakeUnfurlCache())
	if _, err := svc.Unfurl(context.Background(), "file:///etc/passwd"); err == nil {
		t.Error("expected non-http scheme to be rejected")
	}
	if _, err := svc.Unfurl(context.Background(), "javascript:alert(1)"); err == nil {
		t.Error("expected non-http scheme to be rejected")
	}
}

func TestUnfurlService_RejectsEmptyURL(t *testing.T) {
	svc := NewUnfurlService(newFakeUnfurlCache())
	if _, err := svc.Unfurl(context.Background(), ""); err == nil {
		t.Error("expected empty url to be rejected")
	}
}

// fakeUnfurlCache mirrors the slim UnfurlCache interface used by
// UnfurlService — JSON-serialises the value the way RedisCache does.
type fakeUnfurlCache struct {
	store map[string][]byte
}

func newFakeUnfurlCache() *fakeUnfurlCache {
	return &fakeUnfurlCache{store: map[string][]byte{}}
}

func (f *fakeUnfurlCache) Get(_ context.Context, key string, dest interface{}) error {
	v, ok := f.store[key]
	if !ok {
		return errors.New("cache miss")
	}
	return json.Unmarshal(v, dest)
}

func (f *fakeUnfurlCache) Set(_ context.Context, key string, val interface{}, _ time.Duration) error {
	b, err := json.Marshal(val)
	if err != nil {
		return err
	}
	f.store[key] = b
	return nil
}

func TestUnfurlService_CachesPreview(t *testing.T) {
	// Pre-seed the cache so we don't have to reach a real network: the
	// service returns the cached value without calling out.
	cache := newFakeUnfurlCache()
	preview := UnfurlPreview{URL: "https://example.com/x", Title: "Cached"}
	b, _ := json.Marshal(preview)
	cache.store["unfurl:https://example.com/x"] = b

	svc := NewUnfurlService(cache)
	got, err := svc.Unfurl(context.Background(), "https://example.com/x")
	if err != nil {
		t.Fatalf("Unfurl from cache: %v", err)
	}
	if got.Title != "Cached" {
		t.Errorf("title = %q, want Cached", got.Title)
	}
}

func newLoopbackUnfurlService(cache UnfurlCache) *UnfurlService {
	// Plain http.Client without the safeDialContext guard so the test
	// can hit httptest's 127.0.0.1 server. fetchAndScrape skips
	// validateURL too — both layers of the SSRF guard are still
	// covered by the dedicated tests above.
	return &UnfurlService{
		cache:  cache,
		client: &http.Client{Timeout: unfurlTimeout},
	}
}

func TestUnfurlService_FetchScrapesAndCaches(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head>
			<meta property="og:title" content="Page Title">
			<meta property="og:description" content="Page Description">
		</head></html>`))
	}))
	defer srv.Close()

	cache := newFakeUnfurlCache()
	svc := newLoopbackUnfurlService(cache)
	got, err := svc.fetchAndScrape(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Title != "Page Title" {
		t.Errorf("title = %q", got.Title)
	}
	if got.Description != "Page Description" {
		t.Errorf("description = %q", got.Description)
	}
	if !strings.HasPrefix(got.URL, "http") {
		t.Errorf("URL = %q", got.URL)
	}
	// Second call comes from cache — the upstream server is gone but
	// the warm cache still resolves.
	srv.Close()
	cached, err := svc.fetchAndScrape(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("cached fetchAndScrape: %v", err)
	}
	if cached.Title != "Page Title" {
		t.Errorf("cached title = %q", cached.Title)
	}
}

func TestUnfurlService_RejectsNonHTMLContentType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.4"))
	}))
	defer srv.Close()
	svc := newLoopbackUnfurlService(newFakeUnfurlCache())
	if _, err := svc.fetchAndScrape(context.Background(), srv.URL); err == nil {
		t.Error("expected error for non-HTML content-type")
	}
}

// TestSafeDialContext_BlocksPrivateAndLoopback covers the dial-layer
// SSRF guard. Production callers wire safeDialContext into the unfurl
// http.Transport so a hostname that only resolves to private IPs (post-
// validateURL bypass) still cannot connect.
func TestSafeDialContext_BlocksPrivateAndLoopback(t *testing.T) {
	cases := []struct {
		name string
		addr string
	}{
		{"loopback v4 host", "127.0.0.1:80"},
		{"loopback v6 host", "[::1]:80"},
		{"private 10/8", "10.0.0.1:80"},
		{"private 192.168/16", "192.168.0.1:80"},
		{"private 172.16/12", "172.16.0.1:80"},
		{"link-local", "169.254.169.254:80"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn, err := safeDialContext(context.Background(), "tcp", tc.addr)
			if err == nil {
				_ = conn.Close()
				t.Fatalf("expected dial to be blocked for %q", tc.addr)
			}
			if !strings.Contains(err.Error(), "blocked private IP") {
				t.Errorf("unexpected error for %q: %v", tc.addr, err)
			}
		})
	}
}

// TestSafeDialContext_RejectsMissingPort covers the SplitHostPort
// guard.
func TestSafeDialContext_RejectsMissingPort(t *testing.T) {
	if _, err := safeDialContext(context.Background(), "tcp", "127.0.0.1"); err == nil {
		t.Error("expected SplitHostPort error for malformed addr")
	}
}

// TestSafeDialContext_LookupFailure covers the resolver-error path: an
// obviously-invalid host should fail before any dialing happens.
func TestSafeDialContext_LookupFailure(t *testing.T) {
	// .invalid is reserved by RFC 2606 and guaranteed never to resolve.
	if _, err := safeDialContext(context.Background(), "tcp", "definitely-not-a-real-host.invalid:80"); err == nil {
		t.Error("expected lookup error for .invalid host")
	}
}
