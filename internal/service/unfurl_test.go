package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	// Relative image URLs are resolved against the page URL so the
	// browser doesn't try to load them from our origin.
	if p.Title != "Tweet" || p.Image != "https://example.com/i.jpg" {
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

func TestNewUnfurlService_ConfiguresClientAndSetters(t *testing.T) {
	cache := newFakeUnfurlCache()
	svc := NewUnfurlService(cache)
	if svc.cache != cache {
		t.Fatal("NewUnfurlService did not retain cache")
	}
	if svc.client == nil || svc.client.Timeout != unfurlTimeout {
		t.Fatalf("client = %+v, want configured HTTP client", svc.client)
	}

	imageStore := newFakeImageStore()
	svc.SetImageStore(imageStore)
	if svc.imgStore != imageStore {
		t.Fatal("SetImageStore did not retain store")
	}
	mediaCache := newFakeMediaCache()
	svc.SetMediaURLCache(mediaCache)
	if svc.mediaCache != mediaCache {
		t.Fatal("SetMediaURLCache did not retain cache")
	}

	redirectReq := &http.Request{URL: mustParseURL(t, "https://example.com/next")}
	if err := svc.client.CheckRedirect(redirectReq, make([]*http.Request, unfurlMaxRedirect)); err == nil {
		t.Fatal("expected redirect limit error")
	}
	privateReq := &http.Request{URL: mustParseURL(t, "http://127.0.0.1/private")}
	if err := svc.client.CheckRedirect(privateReq, nil); err == nil {
		t.Fatal("expected redirect URL validation error")
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
	// covered by the dedicated tests above. skipURLValidation lets
	// the image proxy path point at httptest's 127.0.0.1 image
	// servers in unit tests.
	return &UnfurlService{
		cache:             cache,
		client:            &http.Client{Timeout: unfurlTimeout},
		skipURLValidation: true,
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

// fakeImageStore is the test stand-in for storage.S3Client. Records every
// call so tests can assert HEAD/PUT/Presign hits and seed `existing` keys
// to simulate the cache-hit path.
type fakeImageStore struct {
	existing  map[string]bool
	puts      map[string][]byte
	puttypes  map[string]string
	headCalls int
	putCalls  int
	signCalls int
	failHead  bool
	failPut   bool
	failSign  bool
}

func newFakeImageStore() *fakeImageStore {
	return &fakeImageStore{
		existing: map[string]bool{},
		puts:     map[string][]byte{},
		puttypes: map[string]string{},
	}
}

func (f *fakeImageStore) HeadObject(_ context.Context, key string) (bool, error) {
	f.headCalls++
	if f.failHead {
		return false, errors.New("head failed")
	}
	return f.existing[key], nil
}

func (f *fakeImageStore) PutObject(_ context.Context, key, contentType string, body []byte) error {
	f.putCalls++
	if f.failPut {
		return errors.New("put failed")
	}
	f.puts[key] = body
	f.puttypes[key] = contentType
	f.existing[key] = true
	return nil
}

func (f *fakeImageStore) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	f.signCalls++
	if f.failSign {
		return "", errors.New("sign failed")
	}
	return "https://s3.example/" + key + "?sig=abc", nil
}
func (f *fakeImageStore) GetObject(_ context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	body := f.puts[key]
	return io.NopCloser(bytes.NewReader(body)), f.puttypes[key], int64(len(body)), time.Time{}, nil
}

// TestUnfurlService_ImageProxiedToS3_HitsCache verifies the dedupe path:
// the second unfurl for the same upstream image must HEAD-hit and skip
// the upload, while still re-presigning the URL each time.
func TestUnfurlService_ImageProxiedToS3_HitsCache(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfake-png-bytes"))
	}))
	defer imgSrv.Close()

	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<meta property="og:title" content="t"><meta property="og:image" content="` + imgSrv.URL + `/social.png">`))
	}))
	defer pageSrv.Close()

	store := newFakeImageStore()
	svc := newLoopbackUnfurlService(nil) // bypass cache so both calls hit fetchAndScrape
	svc.SetImageStore(store)

	first, err := svc.fetchAndScrape(context.Background(), pageSrv.URL)
	if err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if !strings.HasPrefix(first.Image, "https://s3.example/unfurl/") {
		t.Errorf("first.Image not rewritten to S3 presigned URL: %q", first.Image)
	}
	if store.putCalls != 1 {
		t.Errorf("first call: putCalls = %d, want 1", store.putCalls)
	}

	second, err := svc.fetchAndScrape(context.Background(), pageSrv.URL)
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	if !strings.HasPrefix(second.Image, "https://s3.example/unfurl/") {
		t.Errorf("second.Image not rewritten to S3 presigned URL: %q", second.Image)
	}
	if store.putCalls != 1 {
		t.Errorf("second call: putCalls = %d, want 1 (cache hit, no re-upload)", store.putCalls)
	}
	if store.headCalls < 2 {
		t.Errorf("headCalls = %d, want >= 2", store.headCalls)
	}
}

// TestUnfurlService_ImageProxyFailureClearsImageField verifies that when
// the upstream image fetch fails, preview.Image is cleared but the rest
// of the preview is still returned (so the frontend can render a card
// with title/description and a placeholder).
func TestUnfurlService_ImageProxyFailureClearsImageField(t *testing.T) {
	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Image points at a definitely-dead host (.invalid is reserved
		// by RFC 2606 and never resolves).
		_, _ = w.Write([]byte(`<meta property="og:title" content="Still Has Title">
			<meta property="og:description" content="And description">
			<meta property="og:image" content="https://definitely-dead.invalid/x.png">`))
	}))
	defer pageSrv.Close()

	store := newFakeImageStore()
	svc := newLoopbackUnfurlService(nil)
	svc.SetImageStore(store)

	got, err := svc.fetchAndScrape(context.Background(), pageSrv.URL)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Image != "" {
		t.Errorf("Image = %q, want \"\" on fetch failure", got.Image)
	}
	if got.Title != "Still Has Title" {
		t.Errorf("Title cleared along with Image — got %q", got.Title)
	}
	if got.Description != "And description" {
		t.Errorf("Description cleared along with Image — got %q", got.Description)
	}
	if store.putCalls != 0 {
		t.Errorf("putCalls = %d, want 0 (upstream fetch failed)", store.putCalls)
	}
}

// TestUnfurlService_ImageProxyRespectsContentType verifies the
// `image/*`-only guard: an upstream that returns text/html or
// application/octet-stream for the image URL must be rejected and
// preview.Image cleared.
func TestUnfurlService_ImageProxyRespectsContentType(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>not an image</html>"))
	}))
	defer imgSrv.Close()

	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<meta property="og:image" content="` + imgSrv.URL + `/sneaky">`))
	}))
	defer pageSrv.Close()

	store := newFakeImageStore()
	svc := newLoopbackUnfurlService(nil)
	svc.SetImageStore(store)

	got, err := svc.fetchAndScrape(context.Background(), pageSrv.URL)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Image != "" {
		t.Errorf("Image = %q, want \"\" for non-image content-type", got.Image)
	}
	if store.putCalls != 0 {
		t.Errorf("putCalls = %d, want 0 (content-type rejected)", store.putCalls)
	}
}

// TestUnfurlService_ImageProxyRejectsOversize covers the size cap: an
// upstream image larger than unfurlImageMax must be rejected (no
// truncate-and-store).
func TestUnfurlService_ImageProxyRejectsOversize(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		// Write 1 byte over the cap.
		_, _ = w.Write(make([]byte, unfurlImageMax+1))
	}))
	defer imgSrv.Close()

	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<meta property="og:image" content="` + imgSrv.URL + `/huge.png">`))
	}))
	defer pageSrv.Close()

	store := newFakeImageStore()
	svc := newLoopbackUnfurlService(nil)
	svc.SetImageStore(store)

	got, err := svc.fetchAndScrape(context.Background(), pageSrv.URL)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Image != "" {
		t.Errorf("Image = %q, want \"\" for oversize body", got.Image)
	}
	if store.putCalls != 0 {
		t.Errorf("putCalls = %d, want 0 (oversize)", store.putCalls)
	}
}

// TestUnfurlService_ImageProxyKeyExt covers the extension-preservation
// branch of unfurlImageKey: a recognised extension is appended to the
// hash; an unknown one is dropped.
func TestUnfurlService_ImageProxyKeyExt(t *testing.T) {
	cases := []struct {
		url     string
		wantExt string
	}{
		{"https://example.com/img.png", ".png"},
		{"https://example.com/img.JPG", ".jpg"},
		{"https://example.com/path/social", ""},
		{"https://example.com/img.weird", ""},
	}
	for _, tc := range cases {
		got := unfurlImageKey(tc.url)
		if !strings.HasPrefix(got, unfurlImagePrefix) {
			t.Errorf("%q: missing prefix in %q", tc.url, got)
		}
		if tc.wantExt != "" && !strings.HasSuffix(got, tc.wantExt) {
			t.Errorf("%q: want suffix %q in %q", tc.url, tc.wantExt, got)
		}
		if tc.wantExt == "" && (strings.Contains(got[len(unfurlImagePrefix):], ".")) {
			t.Errorf("%q: expected no extension, got %q", tc.url, got)
		}
	}
}

// TestUnfurlService_ImageProxyPutFailureClearsImage verifies that an S3
// upload failure (separate from upstream fetch failure) also clears the
// image rather than leaking the upstream URL.
func TestUnfurlService_ImageProxyPutFailureClearsImage(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("\x89PNGfake"))
	}))
	defer imgSrv.Close()
	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<meta property="og:image" content="` + imgSrv.URL + `/x.png">`))
	}))
	defer pageSrv.Close()

	store := newFakeImageStore()
	store.failPut = true
	svc := newLoopbackUnfurlService(nil)
	svc.SetImageStore(store)

	got, err := svc.fetchAndScrape(context.Background(), pageSrv.URL)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Image != "" {
		t.Errorf("Image = %q, want \"\" when S3 PUT fails", got.Image)
	}
}

func TestUnfurlService_ProxyImage_DirectErrorBranches(t *testing.T) {
	svc := newLoopbackUnfurlService(nil)
	store := newFakeImageStore()
	svc.SetImageStore(store)

	for _, imageURL := range []string{"://bad-url", "/relative.png"} {
		preview := &UnfurlPreview{Image: imageURL}
		svc.proxyImage(context.Background(), preview)
		if preview.Image != "" {
			t.Fatalf("invalid image %q left Image=%q, want empty", imageURL, preview.Image)
		}
	}

	svc.skipURLValidation = false
	preview := &UnfurlPreview{Image: "http://127.0.0.1/social.png"}
	svc.proxyImage(context.Background(), preview)
	if preview.Image != "" {
		t.Fatalf("private image URL left Image=%q, want empty", preview.Image)
	}
	svc.skipURLValidation = true

	store.failHead = true
	preview = &UnfurlPreview{Image: "https://example.com/social.png"}
	svc.proxyImage(context.Background(), preview)
	if preview.Image != "" {
		t.Fatalf("head failure left Image=%q, want empty", preview.Image)
	}

	store.failHead = false
	store.existing[unfurlImageKey("https://example.com/social.png")] = true
	store.failSign = true
	preview = &UnfurlPreview{Image: "https://example.com/social.png"}
	svc.proxyImage(context.Background(), preview)
	if preview.Image != "" {
		t.Fatalf("sign failure left Image=%q, want empty", preview.Image)
	}
}

func TestUnfurlService_ProxyImage_UsesStableMediaURLWhenConfigured(t *testing.T) {
	svc := newLoopbackUnfurlService(nil)
	store := newFakeImageStore()
	imageURL := "https://example.com/social.png"
	store.existing[unfurlImageKey(imageURL)] = true
	svc.SetImageStore(store)
	svc.SetMediaURLCache(newFakeMediaCache())

	preview := &UnfurlPreview{Image: imageURL}
	svc.proxyImage(context.Background(), preview)
	if !strings.HasPrefix(preview.Image, "/api/v1/media/") {
		t.Fatalf("Image = %q, want stable media URL", preview.Image)
	}
	if store.signCalls != 0 {
		t.Fatalf("signCalls = %d, want 0 when stable media URL succeeds", store.signCalls)
	}
}

func TestUnfurlService_FetchUpstreamImage_ErrorBranches(t *testing.T) {
	svc := newLoopbackUnfurlService(nil)

	statusSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadGateway)
	}))
	defer statusSrv.Close()
	if _, _, err := svc.fetchUpstreamImage(context.Background(), statusSrv.URL); err == nil {
		t.Fatal("expected status error")
	}

	emptySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
	}))
	defer emptySrv.Close()
	if _, _, err := svc.fetchUpstreamImage(context.Background(), emptySrv.URL); err == nil {
		t.Fatal("expected empty image error")
	}
}

func TestUnfurlService_ValidationAndScrapeFallbacks(t *testing.T) {
	if err := validateURL(nil); err == nil {
		t.Fatal("expected nil URL validation error")
	}
	if err := validateURL(mustParseURL(t, "https:///missing-host")); err == nil {
		t.Fatal("expected empty host validation error")
	}
	if isPublicIP(net.ParseIP("224.0.0.1")) {
		t.Fatal("multicast IP must not be public")
	}

	linkPreview := scrapePreview(`<link rel="image_src" href="/cover.png">`, "https://example.com/post")
	if linkPreview.Image != "https://example.com/cover.png" {
		t.Fatalf("link image = %q", linkPreview.Image)
	}
	imgPreview := scrapePreview(`<img src="/photo.png">`, "https://example.com/post")
	if imgPreview.Image != "https://example.com/photo.png" {
		t.Fatalf("img image = %q", imgPreview.Image)
	}
	pixelPreview := scrapePreview(`<img src="/1x1.gif">`, "https://example.com/post")
	if pixelPreview.Image != "" {
		t.Fatalf("tracking pixel image = %q, want empty", pixelPreview.Image)
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	return u
}
