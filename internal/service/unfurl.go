package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
)

// UnfurlPreview is the payload returned for a successfully unfurled URL.
// All fields are optional — the client renders whatever is available.
type UnfurlPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
}

// UnfurlCache is the slim slice of RedisCache UnfurlService uses; defined
// as an interface so tests can stub it without bringing up Redis.
type UnfurlCache interface {
	Get(ctx context.Context, key string, dest interface{}) error
	Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error
}

// UnfurlImageStore is the slim S3 surface UnfurlService needs to proxy
// scraped preview images. Concrete impl: storage.S3Client. Defined as an
// interface so tests can stub it without bringing up real S3 / MinIO.
//
// Lifecycle: keys live under the `unfurl/` prefix so an external S3
// lifecycle rule (Terraform / IaC) can expire them on a schedule (e.g.
// 30 days). Nothing in this codebase manages that policy.
type UnfurlImageStore interface {
	HeadObject(ctx context.Context, key string) (bool, error)
	PutObject(ctx context.Context, key, contentType string, body []byte) error
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
}

// UnfurlService fetches HTML for a URL, scrapes OpenGraph / Twitter Card
// metadata, and caches the result. The HTTP client is hardened against
// SSRF: private/loopback/link-local hosts, redirects to private hosts,
// and non-HTTP schemes are rejected; the response body is size-capped.
//
// When an UnfurlImageStore is configured, the scraped Image URL is
// proxied through S3: the upstream image is fetched once, uploaded under
// `unfurl/<sha256>.<ext>`, and the public preview.Image is rewritten to
// a presigned GET on that key. Subsequent requests reuse the existing
// object via a HEAD check. If the upstream image fetch fails for any
// reason (timeout, non-image content-type, oversize, network), Image is
// cleared so the frontend can render a placeholder rather than a broken
// image icon.
type UnfurlService struct {
	cache      UnfurlCache
	client     *http.Client
	imgStore   UnfurlImageStore
	mediaCache MediaURLCache
	// skipURLValidation, when true, bypasses validateURL for the image
	// proxy path. Production wiring (NewUnfurlService) leaves this false
	// so the SSRF guard runs on every upstream image URL; tests that
	// need to point at httptest's 127.0.0.1 server flip it on. The
	// transport's safeDialContext is already swapped out in tests via
	// newLoopbackUnfurlService.
	skipURLValidation bool
}

const (
	unfurlCacheTTL    = 7 * 24 * time.Hour
	unfurlBodyMax     = 256 * 1024
	unfurlTimeout     = 5 * time.Second
	unfurlMaxRedirect = 3
	unfurlUserAgent   = "exbot/1 (+link preview)"
	// unfurlImageMax caps the size of an upstream preview image. 2 MiB
	// is comfortably above any legitimate OG image (typical: 50–500 KiB)
	// and well below anything that would burn S3 storage cost.
	unfurlImageMax     = 2 * 1024 * 1024
	unfurlImagePrefix  = "unfurl/"
	unfurlImageExpires = 7 * 24 * time.Hour
)

// NewUnfurlService builds an UnfurlService backed by the supplied cache.
func NewUnfurlService(cache UnfurlCache) *UnfurlService {
	return &UnfurlService{
		cache: cache,
		client: &http.Client{
			Timeout: unfurlTimeout,
			Transport: &http.Transport{
				DialContext:         safeDialContext,
				DisableKeepAlives:   true,
				MaxIdleConnsPerHost: 1,
			},
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= unfurlMaxRedirect {
					return errors.New("unfurl: too many redirects")
				}
				return validateURL(req.URL)
			},
		},
	}
}

// SetImageStore wires the S3-backed image proxy. When set, scraped
// preview.Image URLs are rewritten to presigned URLs on objects we own;
// when nil, the original upstream URL flows through unchanged (legacy
// behaviour).
func (s *UnfurlService) SetImageStore(store UnfurlImageStore) {
	s.imgStore = store
}

func (s *UnfurlService) SetMediaURLCache(c MediaURLCache) { s.mediaCache = c }

// Unfurl returns a preview for rawURL. Cache is hit first; on a miss the
// service fetches, scrapes, and caches the result. Errors are returned
// to the caller — callers typically swallow them and just skip the
// preview for that link.
func (s *UnfurlService) Unfurl(ctx context.Context, rawURL string) (*UnfurlPreview, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("unfurl: invalid url: %w", err)
	}
	if err := validateURL(parsed); err != nil {
		return nil, err
	}
	return s.fetchAndScrape(ctx, parsed.String())
}

// fetchAndScrape performs cache-check / fetch / parse without re-running
// URL validation. Package-internal so the test suite can drive a
// httptest server (which binds to 127.0.0.1) through it without the
// SSRF guard that legitimately blocks loopback in production.
func (s *UnfurlService) fetchAndScrape(ctx context.Context, urlStr string) (*UnfurlPreview, error) {
	cacheKey := "unfurl:" + urlStr
	if s.cache != nil {
		var cached UnfurlPreview
		if err := s.cache.Get(ctx, cacheKey, &cached); err == nil && cached.URL != "" {
			return &cached, nil
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return nil, fmt.Errorf("unfurl: build request: %w", err)
	}
	req.Header.Set("User-Agent", unfurlUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("unfurl: fetch: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("unfurl: upstream %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(strings.ToLower(ct), "html") {
		return nil, fmt.Errorf("unfurl: non-HTML content-type %q", ct)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, unfurlBodyMax))
	if err != nil {
		return nil, fmt.Errorf("unfurl: read body: %w", err)
	}

	preview := scrapePreview(string(body), urlStr)
	// Proxy the preview image through S3 (folder `unfurl/`) when an
	// image store is configured. Failures clear preview.Image so the
	// frontend renders a placeholder rather than chasing a dead URL.
	s.proxyImage(ctx, preview)
	if s.cache != nil {
		_ = s.cache.Set(ctx, cacheKey, preview, unfurlCacheTTL)
	}
	return preview, nil
}

// proxyImage rewrites preview.Image to a presigned URL on an S3 object
// we own. Behaviour:
//   - no image store configured → no-op (upstream URL flows through).
//   - HEAD hit → just regenerate the presigned URL.
//   - HEAD miss → fetch upstream (size/type/timeout-capped, SSRF-guarded),
//     upload, then presign.
//   - Any failure (fetch error, non-image, oversize, S3 error) → clear
//     preview.Image to "" so the frontend shows a placeholder.
func (s *UnfurlService) proxyImage(ctx context.Context, preview *UnfurlPreview) {
	if s == nil || s.imgStore == nil || preview == nil || preview.Image == "" {
		return
	}
	imgURL := preview.Image
	parsed, err := url.Parse(imgURL)
	if err != nil || !parsed.IsAbs() {
		preview.Image = ""
		return
	}
	if !s.skipURLValidation {
		if err := validateURL(parsed); err != nil {
			preview.Image = ""
			return
		}
	}

	key := unfurlImageKey(imgURL)

	exists, err := s.imgStore.HeadObject(ctx, key)
	if err != nil {
		// HEAD failed for a non-404 reason (auth, network) — drop the
		// image rather than leaking the upstream URL to clients.
		preview.Image = ""
		return
	}
	if !exists {
		body, contentType, fetchErr := s.fetchUpstreamImage(ctx, imgURL)
		if fetchErr != nil {
			preview.Image = ""
			return
		}
		if err := s.imgStore.PutObject(ctx, key, contentType, body); err != nil {
			preview.Image = ""
			return
		}
	}

	if s.mediaCache != nil {
		if mediaURL, err := StableMediaURL(ctx, s.mediaCache, "unfurl", key, key, path.Base(key), "", 0); err == nil {
			preview.Image = mediaURL
			return
		}
	}
	signed, err := s.imgStore.PresignedGetURL(ctx, key, unfurlImageExpires)
	if err != nil {
		preview.Image = ""
		return
	}
	preview.Image = signed
}

// fetchUpstreamImage pulls the upstream image with the same SSRF-hardened
// HTTP client used for HTML scraping. Enforces a 2 MiB size cap and an
// `image/*` content-type.
func (s *UnfurlService) fetchUpstreamImage(ctx context.Context, imgURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imgURL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("unfurl: build image request: %w", err)
	}
	req.Header.Set("User-Agent", unfurlUserAgent)
	req.Header.Set("Accept", "image/*")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("unfurl: fetch image: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("unfurl: image upstream %d", resp.StatusCode)
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])), "image/") {
		return nil, "", fmt.Errorf("unfurl: non-image content-type %q", contentType)
	}

	// Read 1 byte past the cap so we can distinguish "exactly cap" from
	// "oversize"; oversize is rejected outright (don't truncate-and-store).
	body, err := io.ReadAll(io.LimitReader(resp.Body, unfurlImageMax+1))
	if err != nil {
		return nil, "", fmt.Errorf("unfurl: read image body: %w", err)
	}
	if len(body) > unfurlImageMax {
		return nil, "", fmt.Errorf("unfurl: image body exceeds %d bytes", unfurlImageMax)
	}
	if len(body) == 0 {
		return nil, "", errors.New("unfurl: empty image body")
	}
	return body, contentType, nil
}

// unfurlImageKey builds the S3 key for a given upstream image URL. The
// hash gives us a stable, dedupable key; the extension (when discoverable
// from the URL path) is preserved purely so S3 console / CDN behaviour
// stays sensible — the actual content-type stored on the object is what
// HTTP clients use.
func unfurlImageKey(imgURL string) string {
	sum := sha256.Sum256([]byte(imgURL))
	hash := hex.EncodeToString(sum[:])
	ext := imageExtFromURL(imgURL)
	if ext == "" {
		return unfurlImagePrefix + hash
	}
	return unfurlImagePrefix + hash + ext
}

// imageExtFromURL returns a normalised lower-case extension (including
// the leading dot) parsed from the URL path, or "" if the path doesn't
// end in a recognised image extension.
func imageExtFromURL(imgURL string) string {
	u, err := url.Parse(imgURL)
	if err != nil {
		return ""
	}
	ext := strings.ToLower(path.Ext(u.Path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico":
		return ext
	}
	return ""
}

// validateURL rejects schemes other than http/https and hostnames that
// resolve to (or already are) private/loopback/link-local IPs. Run on
// the original URL and on every redirect target.
func validateURL(u *url.URL) error {
	if u == nil {
		return errors.New("unfurl: nil url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unfurl: scheme %q not allowed", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("unfurl: empty host")
	}
	if ip := net.ParseIP(host); ip != nil {
		if !isPublicIP(ip) {
			return fmt.Errorf("unfurl: host %q is private", host)
		}
	}
	return nil
}

// safeDialContext blocks connections to private addresses at the dial
// layer — defence-in-depth in case validateURL missed a hostname that
// only resolves to private IPs.
func safeDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if !isPublicIP(ip) {
			return nil, fmt.Errorf("unfurl: blocked private IP %s", ip)
		}
	}
	d := net.Dialer{Timeout: unfurlTimeout}
	return d.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
}

func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if ip.IsPrivate() {
		return false
	}
	return true
}

// metaTagRE matches a self-closing or open <meta …> tag in any order.
// Cheap & good-enough: we only care about a fixed set of name/property
// values, never the surrounding HTML structure.
var metaTagRE = regexp.MustCompile(`(?is)<meta\b([^>]+)>`)
var attrRE = regexp.MustCompile(`(?is)([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)')`)
var titleRE = regexp.MustCompile(`(?is)<title\b[^>]*>(.*?)</title>`)
var linkTagRE = regexp.MustCompile(`(?is)<link\b([^>]+)>`)
var imgTagRE = regexp.MustCompile(`(?is)<img\b([^>]+)>`)

// scrapePreview pulls OG/Twitter/standard metadata out of an HTML
// document. The output URL is always the requested URL; everything else
// is best-effort.
func scrapePreview(html string, requestedURL string) *UnfurlPreview {
	preview := &UnfurlPreview{URL: requestedURL}
	base, _ := url.Parse(requestedURL)
	resolveImage := func(raw string) string {
		raw = strings.TrimSpace(raw)
		if raw == "" || base == nil {
			return raw
		}
		ref, err := url.Parse(raw)
		if err != nil {
			return raw
		}
		// Absolute URL → return as-is. Relative or protocol-relative
		// (`//cdn/x.png`, `/social.png`, `social.png`) → resolve
		// against the page URL so the browser doesn't load them
		// from our own origin.
		if ref.IsAbs() {
			return raw
		}
		return base.ResolveReference(ref).String()
	}
	tagAttrs := func(tagBody string) map[string]string {
		out := make(map[string]string, 4)
		for _, m := range attrRE.FindAllStringSubmatch(tagBody, -1) {
			val := m[3]
			if val == "" {
				val = m[4]
			}
			out[strings.ToLower(m[1])] = val
		}
		return out
	}
	for _, m := range metaTagRE.FindAllStringSubmatch(html, -1) {
		attrs := tagAttrs(m[1])
		key := attrs["property"]
		if key == "" {
			key = attrs["name"]
		}
		val := attrs["content"]
		if val == "" {
			continue
		}
		switch strings.ToLower(key) {
		case "og:title", "twitter:title":
			if preview.Title == "" {
				preview.Title = val
			}
		case "og:description", "twitter:description", "description":
			if preview.Description == "" {
				preview.Description = val
			}
		case "og:image", "twitter:image", "twitter:image:src":
			if preview.Image == "" {
				preview.Image = resolveImage(val)
			}
		case "og:site_name":
			if preview.SiteName == "" {
				preview.SiteName = val
			}
		}
	}
	if preview.Title == "" {
		if m := titleRE.FindStringSubmatch(html); m != nil {
			preview.Title = strings.TrimSpace(m[1])
		}
	}
	if preview.Image == "" {
		// <link rel="image_src" href="…"> — used by some sites
		// (coveralls.io, older blogs) instead of og:image.
		for _, m := range linkTagRE.FindAllStringSubmatch(html, -1) {
			attrs := tagAttrs(m[1])
			if strings.EqualFold(attrs["rel"], "image_src") && attrs["href"] != "" {
				preview.Image = resolveImage(attrs["href"])
				break
			}
		}
	}
	if preview.Image == "" {
		// Last resort: first reasonably-sized <img> in the document.
		// Tracking pixels ("1x1.gif") are common in the head; skip
		// images whose src clearly points at a pixel.
		if m := imgTagRE.FindStringSubmatch(html); m != nil {
			attrs := tagAttrs(m[1])
			if src := attrs["src"]; src != "" && !strings.Contains(src, "1x1") {
				preview.Image = resolveImage(src)
			}
		}
	}
	return preview
}
