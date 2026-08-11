package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrCliffyNoAccount means the signed-in ex user has no usable CliffHub
// identity (no matching employee, or an inactive one). CliffHub answers the
// mint request with 403; Cliffy is simply unavailable for that user. Callers
// distinguish this from a transient outage so the UI can say "you don't have a
// CliffHub account" rather than "try again".
var ErrCliffyNoAccount = errors.New("cliffy: no CliffHub account for this user")

// bridgeAssertionIssuer / bridgeAssertionAudience pin the `iss` and `aud`
// claims of the assertion ex signs. CliffHub's CliffyBridgeService rejects any
// assertion whose issuer/audience don't match these, so a token minted for the
// bridge can't be replayed against another verifier sharing the secret.
const (
	bridgeAssertionIssuer   = "ex"
	bridgeAssertionAudience = "cliffy-bridge"
)

// BridgeTokenCache is the slice of the Redis cache the bridge needs — kept
// tiny so tests can substitute a map and *cache.RedisCache satisfies it as-is.
// A miss is signalled by a non-nil error (any error is treated as "not
// cached"); the bridge never depends on the specific error value.
type BridgeTokenCache interface {
	Get(ctx context.Context, key string, dest interface{}) error
	Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

// CliffyBridgeConfig configures the bridge client. Secret and MintURL are
// required; an empty Secret or MintURL disables the feature (NewCliffyBridge
// returns a nil service, mirroring NewOneSignalPushSender).
type CliffyBridgeConfig struct {
	// Secret is shared with CliffHub (its CLIFFY_BRIDGE_SECRET). It signs the
	// HS256 assertion; it is never sent over the wire.
	Secret string
	// MintURL is CliffHub's mint endpoint, e.g.
	// https://cliffhub.example/api/ai/bridge/mint.
	MintURL string
	// AssertionTTL bounds the signed assertion's lifetime. Must stay at or
	// under CliffHub's assertion_max_age (default 60s). Default 45s.
	AssertionTTL time.Duration
	// RefreshMargin re-mints a cached token this long before it expires, so a
	// token never expires mid-request. Default 60s.
	RefreshMargin time.Duration
	// HTTPClient is injectable for tests; defaults to an 8s-timeout client.
	HTTPClient *http.Client
	// Cache is optional. When nil, every call mints a fresh token.
	Cache BridgeTokenCache
	// now is a clock seam for tests.
	now func() time.Time
}

// CliffyBridge exchanges an ex user's identity for a short-TTL CliffHub token
// that acts as that user under RBAC. It signs a per-user assertion, posts it
// to CliffHub's mint endpoint, and caches the returned token until shortly
// before it expires.
type CliffyBridge struct {
	secret        []byte
	mintURL       string
	revokeURL     string
	assertionTTL  time.Duration
	refreshMargin time.Duration
	client        *http.Client
	cache         BridgeTokenCache
	now           func() time.Time
}

// NewCliffyBridge builds the bridge, or returns (nil, nil) when disabled
// (Secret or MintURL empty) so the caller can treat Cliffy as off.
func NewCliffyBridge(cfg CliffyBridgeConfig) (*CliffyBridge, error) {
	secret := strings.TrimSpace(cfg.Secret)
	mintURL := strings.TrimSpace(cfg.MintURL)
	if secret == "" || mintURL == "" {
		return nil, nil
	}

	u, err := url.ParseRequestURI(mintURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("cliffybridge: invalid mint URL")
	}

	assertionTTL := cfg.AssertionTTL
	if assertionTTL <= 0 {
		assertionTTL = 45 * time.Second
	}
	refreshMargin := cfg.RefreshMargin
	if refreshMargin <= 0 {
		refreshMargin = 60 * time.Second
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	nowFn := cfg.now
	if nowFn == nil {
		nowFn = time.Now
	}

	// The revoke endpoint sits beside mint (…/bridge/mint → …/bridge/revoke).
	revokeURL := ""
	if strings.HasSuffix(mintURL, "/mint") {
		revokeURL = strings.TrimSuffix(mintURL, "/mint") + "/revoke"
	}

	return &CliffyBridge{
		secret:        []byte(secret),
		mintURL:       mintURL,
		revokeURL:     revokeURL,
		assertionTTL:  assertionTTL,
		refreshMargin: refreshMargin,
		client:        client,
		cache:         cfg.Cache,
		now:           nowFn,
	}, nil
}

type cachedBridgeToken struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// TokenFor returns a valid CliffHub bearer token for the given ex user,
// serving it from cache when one is still comfortably in date and minting a
// fresh one otherwise. The token is never exposed to the browser — only ex's
// backend holds it, forwarding it to CliffHub on the user's behalf.
func (b *CliffyBridge) TokenFor(ctx context.Context, userID, email string) (token string, expiresAt time.Time, err error) {
	if b == nil {
		return "", time.Time{}, errors.New("cliffybridge: disabled")
	}
	userID = strings.TrimSpace(userID)
	email = strings.TrimSpace(email)
	if userID == "" || email == "" {
		// No email → no way to resolve a CliffHub employee. Treat as no account
		// rather than round-tripping to be rejected.
		return "", time.Time{}, ErrCliffyNoAccount
	}

	if cached, ok := b.fromCache(ctx, userID); ok {
		return cached.Token, cached.ExpiresAt, nil
	}

	minted, err := b.mint(ctx, userID, email)
	if err != nil {
		return "", time.Time{}, err
	}

	b.toCache(ctx, userID, minted)
	return minted.Token, minted.ExpiresAt, nil
}

func (b *CliffyBridge) cacheKey(userID string) string {
	return "cliffy:bridge:tok:" + userID
}

// fromCache returns a cached token only if it is still valid past the refresh
// margin. Any cache error (miss, decode, backend down) is treated as "mint a
// fresh one" — the cache is an optimization, never a dependency.
func (b *CliffyBridge) fromCache(ctx context.Context, userID string) (cachedBridgeToken, bool) {
	if b.cache == nil {
		return cachedBridgeToken{}, false
	}
	var rec cachedBridgeToken
	if err := b.cache.Get(ctx, b.cacheKey(userID), &rec); err != nil {
		return cachedBridgeToken{}, false
	}
	if rec.Token == "" || rec.ExpiresAt.Sub(b.now()) <= b.refreshMargin {
		return cachedBridgeToken{}, false
	}
	return rec, true
}

// toCache stores the token with a TTL that expires it at the refresh margin,
// so the next lookup after that point re-mints. Best-effort: a cache write
// failure is non-fatal (the token was already returned to the caller).
func (b *CliffyBridge) toCache(ctx context.Context, userID string, rec cachedBridgeToken) {
	if b.cache == nil {
		return
	}
	ttl := rec.ExpiresAt.Sub(b.now()) - b.refreshMargin
	if ttl <= 0 {
		return
	}
	_ = b.cache.Set(ctx, b.cacheKey(userID), rec, ttl)
}

type mintResponse struct {
	Token     string    `json:"token"`
	TokenType string    `json:"token_type"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (b *CliffyBridge) mint(ctx context.Context, userID, email string) (cachedBridgeToken, error) {
	// HS256 signing with a []byte key cannot fail, so there is no error to guard
	// here — a guard would be unreachable (and uncoverable) code.
	body, _ := json.Marshal(map[string]string{"assertion": b.signAssertion(userID, email)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.mintURL, bytes.NewReader(body))
	if err != nil {
		return cachedBridgeToken{}, fmt.Errorf("cliffybridge: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	res, err := b.client.Do(req)
	if err != nil {
		return cachedBridgeToken{}, fmt.Errorf("cliffybridge: mint request: %w", err)
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()

	// 403 is definitive: this user has no usable CliffHub identity. Anything
	// else non-2xx is treated as transient/unavailable.
	if res.StatusCode == http.StatusForbidden {
		return cachedBridgeToken{}, ErrCliffyNoAccount
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return cachedBridgeToken{}, fmt.Errorf("cliffybridge: mint failed with status %d", res.StatusCode)
	}

	var parsed mintResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&parsed); err != nil {
		return cachedBridgeToken{}, fmt.Errorf("cliffybridge: decode mint response: %w", err)
	}
	if parsed.Token == "" || parsed.ExpiresAt.IsZero() {
		return cachedBridgeToken{}, fmt.Errorf("cliffybridge: mint response missing token or expiry")
	}

	return cachedBridgeToken{Token: parsed.Token, ExpiresAt: parsed.ExpiresAt}, nil
}

// signAssertion mints the short-lived HS256 assertion CliffHub verifies. It
// uses MapClaims so the `aud` claim serializes as a plain string (CliffHub
// accepts either shape) and the JSON is exactly what firebase/php-jwt expects.
//
// Returns no error: HMAC signing only fails on a key that is not a []byte, and
// b.secret always is (see mustSigned).
func (b *CliffyBridge) signAssertion(userID, email string) string {
	now := b.now()
	claims := jwt.MapClaims{
		"iss":   bridgeAssertionIssuer,
		"aud":   bridgeAssertionAudience,
		"sub":   userID,
		"email": email,
		"iat":   now.Unix(),
		"exp":   now.Add(b.assertionTTL).Unix(),
	}
	return mustSigned(jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(b.secret))
}

// Revoke tears down a user's bridged session on ex logout: it clears the cached
// token (so ex can't reuse it) and best-effort asks CliffHub to delete the
// user's short-lived bridge tokens (so the session can't outlive the ex login
// even within its TTL). Safe to call with a disabled bridge or unknown user.
func (b *CliffyBridge) Revoke(ctx context.Context, userID, email string) error {
	if b == nil {
		return nil
	}
	userID = strings.TrimSpace(userID)
	if userID != "" && b.cache != nil {
		_ = b.cache.Delete(ctx, b.cacheKey(userID))
	}
	if b.revokeURL == "" || userID == "" || strings.TrimSpace(email) == "" {
		return nil
	}

	body, _ := json.Marshal(map[string]string{"assertion": b.signAssertion(userID, strings.TrimSpace(email))})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.revokeURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cliffybridge: build revoke request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	res, err := b.client.Do(req)
	if err != nil {
		return fmt.Errorf("cliffybridge: revoke request: %w", err)
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("cliffybridge: revoke failed with status %d", res.StatusCode)
	}
	return nil
}
