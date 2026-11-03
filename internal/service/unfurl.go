package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/DigitalTolk/ex/internal/netguard"
)

// UnfurlPreview is the payload returned for a successfully unfurled URL.
// All fields are optional — the client renders whatever is available.
type UnfurlPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	// Intrinsic pixel dimensions of Image (0 when unknown). For internal
	// message-link previews this lets the client size a shared image exactly
	// as the original message does, rather than expanding it to fill the card.
	ImageWidth  int    `json:"imageWidth,omitempty"`
	ImageHeight int    `json:"imageHeight,omitempty"`
	SiteName    string `json:"siteName,omitempty"`

	// Internal message-link preview (Slack/Mattermost-style). When Kind is
	// "message" the client renders a rich author/body/channel card instead
	// of the generic OpenGraph card. These fields are populated only by the
	// MessageLinkService, never by web scraping.
	Kind            string `json:"kind,omitempty"`            // "" (web) | "message"
	AuthorName      string `json:"authorName,omitempty"`      // display name (or webhook username)
	AuthorAvatarURL string `json:"authorAvatarURL,omitempty"` // signed avatar URL
	ChannelLabel    string `json:"channelLabel,omitempty"`    // "~slug" / group name / "Direct message"
	Body            string `json:"body,omitempty"`            // message body excerpt
	CreatedAt       string `json:"createdAt,omitempty"`       // RFC3339
	// Attachments lists the message's non-image uploaded file attachments so
	// the client renders the same file-type icons it uses in the message
	// list (instead of a paperclip emoji baked into the body). Image files
	// are surfaced via Image above and omitted here.
	Attachments []UnfurlAttachment `json:"attachments,omitempty"`
}

// UnfurlAttachment is the minimal file descriptor a message-link preview
// carries so the client can pick a file-type icon by content type / name.
type UnfurlAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"contentType,omitempty"`
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
// SSRF (netguard): every dial — the first hop, each redirect, a name that
// resolves to a private address — must reach a public address, the proxy
// environment is ignored, and non-HTTP schemes are rejected; the response
// body is size-capped.
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
	// youTubeOEmbed is the oEmbed endpoint YouTube video links are read
	// through (youTubeOEmbedEndpoint; tests point it at a local server).
	youTubeOEmbed string
	// skipURLValidation, when true, bypasses validateURL for the image
	// proxy path. Production wiring (NewUnfurlService) leaves this false
	// so the SSRF guard runs on every upstream image URL; tests that
	// need to point at httptest's 127.0.0.1 server flip it on. The
	// guarded client is already swapped out in tests via
	// newLoopbackUnfurlService.
	skipURLValidation bool
}

const (
	// unfurlCacheKeyPrefix keys a URL's cached preview. v2: YouTube videos
	// are read through oEmbed; a v1 entry may hold what the watch page gave.
	unfurlCacheKeyPrefix = "unfurl:v2:"
	unfurlCacheTTL       = 7 * 24 * time.Hour
	unfurlBodyMax        = 256 * 1024
	unfurlTimeout        = 5 * time.Second
	unfurlMaxRedirect    = 3
	// unfurlUserAgent names the fetcher to the sites it reads, in the usual
	// crawler form (name/version, then a URL to learn about it), so a site's
	// operator can see what is asking and where it comes from. The name says
	// bot, as link-preview fetchers do (Mattermost-Bot, Slackbot): some sites
	// (Instagram) give a fetcher that doesn't a sign-in page, not the post.
	unfurlUserAgent = "ex-bot/1 (+https://github.com/DigitalTolk/ex)"
	// unfurlImageMax caps the size of an upstream preview image. 2 MiB
	// is comfortably above any legitimate OG image (typical: 50–500 KiB)
	// and well below anything that would burn S3 storage cost.
	unfurlImageMax     = 2 * 1024 * 1024
	unfurlImagePrefix  = "unfurl/"
	unfurlImageExpires = 7 * 24 * time.Hour
	// youTubeOEmbedEndpoint is YouTube's own way to describe a video to
	// another site (oEmbed): its title, channel and thumbnail, as JSON. The
	// watch page is not read for these.
	youTubeOEmbedEndpoint = "https://www.youtube.com/oembed"
	// oEmbedBodyMax caps an oEmbed answer, a few hundred bytes of JSON.
	oEmbedBodyMax = 64 * 1024
)

// NewUnfurlService builds an UnfurlService backed by the supplied cache.
func NewUnfurlService(cache UnfurlCache) *UnfurlService {
	return &UnfurlService{
		cache: cache,
		// Redirect targets need no URL check of their own: each hop dials
		// through the same guard, which judges the address actually reached.
		client: netguard.NewClient(netguard.Options{
			Timeout:           unfurlTimeout,
			MaxRedirects:      unfurlMaxRedirect,
			DisableKeepAlives: true,
		}),
		youTubeOEmbed: youTubeOEmbedEndpoint,
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

// ProxyImageURL fetches and caches an arbitrary trusted-by-feature image URL
// through the same hardened image proxy used by unfurls.
func (s *UnfurlService) ProxyImageURL(ctx context.Context, rawURL string) string {
	preview := &UnfurlPreview{Image: rawURL}
	s.proxyImage(ctx, preview)
	return preview.Image
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
	cacheKey := unfurlCacheKeyPrefix + urlStr
	if s.cache != nil {
		var cached UnfurlPreview
		if err := s.cache.Get(ctx, cacheKey, &cached); err == nil && cached.URL != "" {
			return &cached, nil
		}
	}

	// Pre-flight the target BEFORE any HTTP request: users routinely paste
	// links to internal hosts (intranet tools resolving to 10.x), and those
	// are POLICY blocks, not faults. Failing here means no outbound request
	// ever starts, so no APM client span exists to be error-tagged — the
	// event is a WARN log instead of a recurring APM error. Runs after the
	// cache check (a cached preview shouldn't pay a DNS lookup) and is
	// skipped by the loopback test harness alongside validateURL.
	// safeDialContext stays as the security boundary underneath (it re-checks
	// at dial time, covering redirects and DNS rebinding).
	if !s.skipURLValidation {
		if err := preflightPublicTarget(ctx, urlStr); err != nil {
			return nil, err
		}
	}

	preview := s.youTubePreview(ctx, urlStr)
	if preview == nil {
		var err error
		if preview, err = s.scrapePage(ctx, urlStr); err != nil {
			return nil, err
		}
	}
	// Proxy the preview image through S3 (folder `unfurl/`) when an
	// image store is configured. Failures clear preview.Image so the
	// frontend renders a placeholder rather than chasing a dead URL.
	s.proxyImage(ctx, preview)
	if s.cache != nil {
		_ = s.cache.Set(ctx, cacheKey, preview, unfurlCacheTTL)
	}
	return preview, nil
}

// scrapePage fetches urlStr and reads its preview from the page's metadata.
func (s *UnfurlService) scrapePage(ctx context.Context, urlStr string) (*UnfurlPreview, error) {
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
	return scrapePreview(string(body), urlStr), nil
}

// youTubePreview describes a YouTube video from YouTube's oEmbed answer:
// its title, the channel as the description, and its thumbnail. It returns
// nil when urlStr is no video link or no usable answer comes, and the page
// is then read like any other.
func (s *UnfurlService) youTubePreview(ctx context.Context, urlStr string) *UnfurlPreview {
	target := youTubeOEmbedTarget(urlStr)
	if target == "" {
		return nil
	}
	endpoint := s.youTubeOEmbed + "?" + url.Values{"url": {target}, "format": {"json"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", unfurlUserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var answer struct {
		Title        string `json:"title"`
		AuthorName   string `json:"author_name"`
		ProviderName string `json:"provider_name"`
		ThumbnailURL string `json:"thumbnail_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, oEmbedBodyMax)).Decode(&answer); err != nil || answer.Title == "" {
		return nil
	}
	return &UnfurlPreview{
		URL:         urlStr,
		Title:       answer.Title,
		Description: answer.AuthorName,
		Image:       answer.ThumbnailURL,
		SiteName:    answer.ProviderName,
	}
}

// youTubeOEmbedTarget returns the link to ask YouTube's oEmbed about for
// raw, or "" when raw is no YouTube video or playlist: a watch page, a short,
// a live stream, an embed, a playlist, or a youtu.be link (the links
// Mattermost reads through the same endpoint). oEmbed answers an embed or
// /v/ link with 404, so those are asked about as the video's watch page.
func youTubeOEmbedTarget(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "youtu.be" {
		if len(u.Path) > 1 {
			return raw
		}
		return ""
	}
	if host != "youtube.com" && !strings.HasSuffix(host, ".youtube.com") {
		return ""
	}
	if u.Path == "/watch" || (u.Path == "/playlist" && u.Query().Get("list") != "") ||
		strings.HasPrefix(u.Path, "/shorts/") || strings.HasPrefix(u.Path, "/live/") {
		return raw
	}
	for _, prefix := range []string{"/embed/", "/v/"} {
		if id, ok := strings.CutPrefix(u.Path, prefix); ok && id != "" {
			return "https://www.youtube.com/watch?v=" + url.QueryEscape(id)
		}
	}
	return ""
}

// proxyImage rewrites preview.Image to a presigned URL on an S3 object
// we own. Behaviour:
//   - no image store configured → no-op (upstream URL flows through).
//   - already stored (cache record or HEAD hit) → just sign the URL.
//   - not stored → fetch upstream (size/type/timeout-capped, SSRF-guarded),
//     upload, then sign.
//   - Any failure (fetch error, non-image, oversize, S3 error) → clear
//     preview.Image to "" so the frontend shows a placeholder.
func (s *UnfurlService) proxyImage(ctx context.Context, preview *UnfurlPreview) {
	if s == nil || s.imgStore == nil || preview == nil || preview.Image == "" {
		return
	}
	key, _, ok := s.storeImage(ctx, preview.Image, false)
	if !ok {
		preview.Image = ""
		return
	}
	preview.Image = s.signImageKey(ctx, key)
}

// storeImage makes sure the image at imgURL is held in S3 under its
// unfurlImageKey and returns that key with the image's cache record; with
// measure set, the record carries the image's dimensions when they can be
// read. ok is false when the URL is unusable or the image could not be
// fetched or stored.
func (s *UnfurlService) storeImage(ctx context.Context, imgURL string, measure bool) (key string, rec imageDims, ok bool) {
	parsed, err := url.Parse(imgURL)
	if err != nil || !parsed.IsAbs() {
		return "", imageDims{}, false
	}
	if !s.skipURLValidation {
		if err := validateURL(parsed); err != nil {
			return "", imageDims{}, false
		}
	}
	key = unfurlImageKey(imgURL)
	// A cache record proves the object is stored, so the HEAD is skipped: a
	// webhook post with a few images used to pay one sequential S3 round trip
	// per image field, on every post.
	rec, known := s.loadImageRecord(ctx, key)
	if !known {
		exists, err := s.imgStore.HeadObject(ctx, key)
		if err != nil {
			// HEAD failed for a non-404 reason (auth, network) — drop the
			// image rather than leaking the upstream URL to clients.
			return "", imageDims{}, false
		}
		if !exists {
			body, contentType, err := s.fetchUpstreamImage(ctx, imgURL)
			if err != nil {
				return "", imageDims{}, false
			}
			if err := s.imgStore.PutObject(ctx, key, contentType, body); err != nil {
				return "", imageDims{}, false
			}
			w, h := decodeImageDims(body)
			rec = imageDims{W: w, H: h, Measured: true}
		}
	}
	dirty := !known
	if measure && !rec.measured() {
		if measured, ok := s.measureStoredImage(ctx, key); ok {
			rec, dirty = measured, true
		}
	}
	if dirty {
		s.saveImageRecord(ctx, key, rec)
	}
	return key, rec, true
}

// measureStoredImage reads a stored image back to decode its dimensions — an
// object stored before its record (or its dimensions) was kept. ok is false
// when the object could not be read; an undecodable one is still measured
// (as 0×0), so it is not read again on the next post.
func (s *UnfurlService) measureStoredImage(ctx context.Context, key string) (imageDims, bool) {
	body, _, _, _, err := s.imgStore.GetObject(ctx, key)
	if err != nil {
		return imageDims{}, false
	}
	data, err := io.ReadAll(io.LimitReader(body, unfurlImageMax+1))
	_ = body.Close()
	if err != nil {
		return imageDims{}, false
	}
	w, h := decodeImageDims(data)
	return imageDims{W: w, H: h, Measured: true}, true
}

// signImageKey turns an S3 object key we own into a client-facing URL:
// a stable media-cache URL when one is configured, otherwise a presigned
// GET. Returns "" on failure so callers can drop the image.
func (s *UnfurlService) signImageKey(ctx context.Context, key string) string {
	if s.mediaCache != nil {
		if mediaURL, err := StableMediaURL(ctx, s.mediaCache, "unfurl", key, key, path.Base(key), "", 0); err == nil {
			return mediaURL
		}
	}
	signed, err := s.imgStore.PresignedGetURL(ctx, key, unfurlImageExpires)
	if err != nil {
		return ""
	}
	return signed
}

// ProxyImageWithSize behaves like ProxyImageURL but also reports the
// intrinsic pixel dimensions of the cached image. Width/height are
// decoded from the upstream bytes the first time the image is cached
// and memoised in the cache keyed by the S3 object; an object stored
// without recorded dimensions (legacy objects) is read back once and
// decoded. Returns ("", 0, 0) on any failure.
//
// When no image store is configured it degrades to the plain proxy and
// reports unknown dimensions.
func (s *UnfurlService) ProxyImageWithSize(ctx context.Context, rawURL string) (string, int, int) {
	if s == nil || s.imgStore == nil {
		return s.ProxyImageURL(ctx, rawURL), 0, 0
	}
	key, rec, ok := s.storeImage(ctx, strings.TrimSpace(rawURL), true)
	if !ok {
		return "", 0, 0
	}
	signed := s.signImageKey(ctx, key)
	if signed == "" {
		return "", 0, 0
	}
	return signed, rec.W, rec.H
}

// imageDims is the cache record of a proxied image key. Its presence proves
// the object is stored in S3; W/H are its intrinsic dimensions when known.
type imageDims struct {
	W int `json:"w"`
	H int `json:"h"`
	// Measured is set once the stored bytes were decoded for their size, so
	// an undecodable image is not re-read on every post. Records written
	// before the flag existed always carry non-zero dimensions.
	Measured bool `json:"m,omitempty"`
}

func (d imageDims) measured() bool { return d.Measured || (d.W > 0 && d.H > 0) }

func imageDimsKey(objectKey string) string { return "imgdim:" + objectKey }

func (s *UnfurlService) saveImageRecord(ctx context.Context, key string, rec imageDims) {
	if s.cache == nil {
		return
	}
	_ = s.cache.Set(ctx, imageDimsKey(key), rec, unfurlCacheTTL)
}

func (s *UnfurlService) loadImageRecord(ctx context.Context, key string) (imageDims, bool) {
	if s.cache == nil {
		return imageDims{}, false
	}
	var d imageDims
	if err := s.cache.Get(ctx, imageDimsKey(key), &d); err != nil {
		return imageDims{}, false
	}
	return d, true
}

// decodeImageDims reads the intrinsic dimensions from image bytes. The
// png/jpeg/gif/webp decoders are registered package-wide (see emoji.go),
// so DecodeConfig resolves the format by magic bytes. Returns (0,0) for
// undecodable input.
func decodeImageDims(data []byte) (int, int) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
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
	declared := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if declared == "image/svg+xml" {
		return nil, "", errors.New("unfurl: SVG preview images are not allowed")
	}
	if !strings.HasPrefix(declared, "image/") {
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
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(body), ";")[0]))
	if !strings.HasPrefix(detected, "image/") {
		return nil, "", fmt.Errorf("unfurl: image magic mismatch %q", detected)
	}
	// Store what the bytes are, never the upstream's header verbatim: a list
	// such as "image/png, text/html" passes the prefix check above, yet a
	// browser takes the last valid entry and would render the object as HTML.
	return body, detected, nil
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
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico":
		return ext
	}
	return ""
}

// validateURL rejects schemes other than http/https and IP-literal hosts
// outside the public address space (netguard's deny list). Hostnames are
// judged at dial time, on the address they resolve to.
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
		if !netguard.IsPublicIP(ip) {
			return fmt.Errorf("unfurl: host %q is private", host)
		}
	}
	return nil
}

// preflightPublicTarget resolves a URL's host once, before any request is
// made, and rejects targets that resolve to a non-public address. This is
// noise control, not the security boundary: the same rule is enforced again
// by the netguard client at dial time.
func preflightPublicTarget(ctx context.Context, urlStr string) error {
	parsed, err := url.Parse(urlStr)
	if err != nil {
		return fmt.Errorf("unfurl: invalid url: %w", err)
	}
	host := parsed.Hostname()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return fmt.Errorf("unfurl: resolve %s: %w", host, err)
	}
	for _, ip := range ips {
		if !netguard.IsPublicIP(ip) {
			slog.WarnContext(ctx, "unfurl: link target resolves to a private address; preview skipped",
				"host", host, "ip", ip.String())
			return fmt.Errorf("unfurl: blocked private IP %s", ip)
		}
	}
	return nil
}

// scrapePreview pulls OG/Twitter/standard metadata out of an HTML
// document using x/net/html's tokenizer — spec-grade lexing (quoting,
// entities, attribute order) instead of HTML-by-regex. The output URL is
// always the requested URL; everything else is best-effort.
func scrapePreview(doc string, requestedURL string) *UnfurlPreview {
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

	// Fallback candidates are collected during the single token pass and
	// applied after it, preserving the precedence of the old scraper:
	// og/twitter meta beats <title> / <link rel=image_src>, which beats
	// the first <img> in the document.
	var (
		titleText string
		titleDone bool
		inTitle   bool
		linkImage string
		firstImg  string
		sawImg    bool
	)

	z := html.NewTokenizer(strings.NewReader(doc))
scan:
	for {
		switch z.Next() {
		case html.ErrorToken:
			// io.EOF or malformed input — either way, keep what we have.
			break scan
		case html.TextToken:
			if inTitle {
				titleText += string(z.Text())
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			attrs := make(map[string]string, 4)
			for hasAttr {
				var key, val []byte
				key, val, hasAttr = z.TagAttr()
				attrs[string(key)] = string(val)
			}
			switch string(name) {
			case "meta":
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
			case "title":
				if !titleDone {
					inTitle = true
				}
			case "link":
				// <link rel="image_src" href="…"> — used by some sites
				// (coveralls.io, older blogs) instead of og:image.
				if linkImage == "" && strings.EqualFold(attrs["rel"], "image_src") && attrs["href"] != "" {
					linkImage = attrs["href"]
				}
			case "img":
				if !sawImg {
					sawImg = true
					firstImg = attrs["src"]
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			if string(name) == "title" && inTitle {
				inTitle = false
				titleDone = true
			}
		}
	}
	if preview.Title == "" {
		preview.Title = strings.TrimSpace(titleText)
	}
	if preview.Image == "" && linkImage != "" {
		preview.Image = resolveImage(linkImage)
	}
	// Last resort: the first <img> in the document — but skip obvious
	// tracking pixels ("1x1.gif"), which are common in the head.
	if preview.Image == "" && firstImg != "" && !strings.Contains(firstImg, "1x1") {
		preview.Image = resolveImage(firstImg)
	}
	return preview
}
