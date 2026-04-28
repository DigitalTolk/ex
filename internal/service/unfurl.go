package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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

// UnfurlService fetches HTML for a URL, scrapes OpenGraph / Twitter Card
// metadata, and caches the result. The HTTP client is hardened against
// SSRF: private/loopback/link-local hosts, redirects to private hosts,
// and non-HTTP schemes are rejected; the response body is size-capped.
type UnfurlService struct {
	cache  UnfurlCache
	client *http.Client
}

const (
	unfurlCacheTTL    = 7 * 24 * time.Hour
	unfurlBodyMax     = 256 * 1024
	unfurlTimeout     = 5 * time.Second
	unfurlMaxRedirect = 3
	unfurlUserAgent   = "exbot/1 (+link preview)"
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

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(strings.ToLower(ct), "html") {
		return nil, fmt.Errorf("unfurl: non-HTML content-type %q", ct)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, unfurlBodyMax))
	if err != nil {
		return nil, fmt.Errorf("unfurl: read body: %w", err)
	}

	preview := scrapePreview(string(body), urlStr)
	if s.cache != nil {
		_ = s.cache.Set(ctx, cacheKey, preview, unfurlCacheTTL)
	}
	return preview, nil
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

// scrapePreview pulls OG/Twitter/standard metadata out of an HTML
// document. The output URL is always the requested URL; everything else
// is best-effort.
func scrapePreview(html string, requestedURL string) *UnfurlPreview {
	preview := &UnfurlPreview{URL: requestedURL}
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
		case "og:image", "twitter:image":
			if preview.Image == "" {
				preview.Image = val
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
	return preview
}
