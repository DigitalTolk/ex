package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ErrGiphyNotConfigured is returned when the workspace has no Giphy API
// key set. Callers map this to HTTP 503 so the frontend hides the GIF
// button on auth-failure-style telemetry instead of treating it as an
// unexpected error.
var ErrGiphyNotConfigured = errors.New("giphy: api key not configured")

// GiphyEndpoint is the upstream Giphy v1 base URL. Override only in
// tests via WithBaseURL.
const GiphyEndpoint = "https://api.giphy.com/v1/gifs"

// MaxGiphyResponseBytes caps how much we'll read from the upstream
// before erroring out. Giphy responses for limit=50 are well under
// 1 MiB; this guard is here to defend against a misbehaving edge.
const MaxGiphyResponseBytes = 4 << 20 // 4 MiB

// GiphyService proxies search/trending lookups against the Giphy API
// using the workspace-configured key. The frontend uses Giphy's own
// `<Grid>` component (which expects the raw Giphy response envelope:
// `{data, meta, pagination}`), so this service streams the upstream
// bytes through unchanged rather than reshaping them.
type GiphyService struct {
	settings *SettingsService
	http     *http.Client
	baseURL  string
}

// NewGiphyService returns a service that pulls the API key from
// `settings` on every call (so admin updates take effect without a
// process restart).
func NewGiphyService(settings *SettingsService) *GiphyService {
	return &GiphyService{
		settings: settings,
		http:     &http.Client{Timeout: 8 * time.Second},
		baseURL:  GiphyEndpoint,
	}
}

// WithBaseURL points the service at an alternate upstream. Used by
// tests to swap in an httptest.Server.
func (g *GiphyService) WithBaseURL(u string) *GiphyService {
	g.baseURL = u
	return g
}

// WithHTTPClient swaps the HTTP client. Tests use this to inject a
// short timeout / instrumented transport.
func (g *GiphyService) WithHTTPClient(c *http.Client) *GiphyService {
	g.http = c
	return g
}

// Search proxies /v1/gifs/search. `query` is required.
func (g *GiphyService) Search(ctx context.Context, query string, limit, offset int) ([]byte, error) {
	if query == "" {
		// Empty-search short-circuits with a Giphy-shaped empty
		// envelope so the frontend Grid clears its results without
		// burning an upstream round-trip.
		return []byte(`{"data":[],"meta":{"status":200,"msg":"OK","response_id":""},"pagination":{"total_count":0,"count":0,"offset":0}}`), nil
	}
	q := url.Values{}
	q.Set("q", query)
	return g.fetch(ctx, "/search", q, limit, offset)
}

// Trending proxies /v1/gifs/trending.
func (g *GiphyService) Trending(ctx context.Context, limit, offset int) ([]byte, error) {
	return g.fetch(ctx, "/trending", url.Values{}, limit, offset)
}

func (g *GiphyService) fetch(ctx context.Context, path string, q url.Values, limit, offset int) ([]byte, error) {
	key := g.settings.Effective(ctx).GiphyAPIKey
	if key == "" {
		return nil, ErrGiphyNotConfigured
	}
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	q.Set("api_key", key)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))
	// `g` rating keeps everything family-friendly; admins who want
	// looser ratings can configure their key on a paid Giphy account.
	q.Set("rating", "g")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.baseURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("giphy: build request: %w", err)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("giphy: request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, ErrGiphyNotConfigured
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("giphy: upstream %d: %s", resp.StatusCode, string(body))
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, io.LimitReader(resp.Body, MaxGiphyResponseBytes)); err != nil {
		return nil, fmt.Errorf("giphy: read upstream: %w", err)
	}
	return buf.Bytes(), nil
}
