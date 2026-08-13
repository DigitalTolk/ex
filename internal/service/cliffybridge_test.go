package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testBridgeSecret = "test-bridge-secret-at-least-32-characters"

// fakeCache is a minimal in-memory BridgeTokenCache for tests.
type fakeCache struct {
	mu   sync.Mutex
	data map[string][]byte
}

func newFakeCache() *fakeCache { return &fakeCache{data: map[string][]byte{}} }

func (c *fakeCache) Get(_ context.Context, key string, dest interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.data[key]
	if !ok {
		return errors.New("miss")
	}
	return json.Unmarshal(b, dest)
}

func (c *fakeCache) Set(_ context.Context, key string, val interface{}, _ time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := json.Marshal(val)
	if err != nil {
		return err
	}
	c.data[key] = b
	return nil
}

func (c *fakeCache) Delete(_ context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.data, key)
	return nil
}

func (c *fakeCache) has(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.data[key]
	return ok
}

// mintServer stands in for CliffHub's /api/ai/bridge/mint. It verifies the
// assertion exactly as CliffHub does (HS256 + iss/aud), records the parsed
// claims, counts calls, and returns whatever status/token the test wants.
type mintServer struct {
	calls      int32
	status     int
	token      string
	expiresAt  time.Time
	lastClaims jwt.MapClaims
}

func newMintServer() *mintServer {
	return &mintServer{status: http.StatusOK, token: "cliffhub-token-abc", expiresAt: time.Now().Add(15 * time.Minute)}
}

func (m *mintServer) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&m.calls, 1)

		var body struct {
			Assertion string `json:"assertion"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Assertion == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		claims := jwt.MapClaims{}
		_, err := jwt.ParseWithClaims(body.Assertion, claims, func(*jwt.Token) (interface{}, error) {
			return []byte(testBridgeSecret), nil
		}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired())
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		m.lastClaims = claims

		if m.status != http.StatusOK {
			w.WriteHeader(m.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":      m.token,
			"token_type": "Bearer",
			"expires_at": m.expiresAt.UTC().Format(time.RFC3339Nano),
		})
	}
}

func newTestBridge(t *testing.T, url string, cache BridgeTokenCache, now func() time.Time) *CliffyBridge {
	t.Helper()
	b, err := NewCliffyBridge(CliffyBridgeConfig{
		Secret:        testBridgeSecret,
		MintURL:       url,
		AssertionTTL:  45 * time.Second,
		RefreshMargin: 60 * time.Second,
		Cache:         cache,
		now:           now,
	})
	if err != nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	if b == nil {
		t.Fatal("NewCliffyBridge returned nil for a configured bridge")
	}
	return b
}

func TestNewCliffyBridge_DisabledWhenUnset(t *testing.T) {
	for _, tc := range []CliffyBridgeConfig{
		{Secret: "", MintURL: "https://x/api"},
		{Secret: "s", MintURL: ""},
		{},
	} {
		b, err := NewCliffyBridge(tc)
		if err != nil || b != nil {
			t.Errorf("NewCliffyBridge(%+v) = (%v,%v), want (nil,nil)", tc, b, err)
		}
	}
}

func TestNewCliffyBridge_InvalidMintURL(t *testing.T) {
	b, err := NewCliffyBridge(CliffyBridgeConfig{Secret: "s", MintURL: "not-a-url"})
	if err == nil || b != nil {
		t.Fatalf("expected error for invalid mint URL, got (%v,%v)", b, err)
	}
}

func TestTokenFor_MintsAndSignsVerifiableAssertion(t *testing.T) {
	ms := newMintServer()
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()

	b := newTestBridge(t, srv.URL, nil, time.Now)

	token, expiresAt, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com")
	if err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if token != ms.token {
		t.Errorf("token = %q, want %q", token, ms.token)
	}
	if expiresAt.IsZero() {
		t.Error("expiresAt is zero")
	}
	// The server verified the signature; assert the claims it parsed.
	if got := ms.lastClaims["iss"]; got != bridgeAssertionIssuer {
		t.Errorf("iss = %v, want %v", got, bridgeAssertionIssuer)
	}
	if got := ms.lastClaims["aud"]; got != bridgeAssertionAudience {
		t.Errorf("aud = %v, want %v (must be a plain string)", got, bridgeAssertionAudience)
	}
	if got := ms.lastClaims["email"]; got != "user@example.com" {
		t.Errorf("email = %v, want user@example.com", got)
	}
	if got := ms.lastClaims["sub"]; got != "ex-user-1" {
		t.Errorf("sub = %v, want ex-user-1", got)
	}
}

func TestTokenFor_EmptyEmailIsNoAccount(t *testing.T) {
	ms := newMintServer()
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, nil, time.Now)

	_, _, err := b.TokenFor(context.Background(), "ex-user-1", "")
	if !errors.Is(err, ErrCliffyNoAccount) {
		t.Fatalf("err = %v, want ErrCliffyNoAccount", err)
	}
	if atomic.LoadInt32(&ms.calls) != 0 {
		t.Error("expected no server call for an empty email")
	}
}

func TestTokenFor_ForbiddenIsNoAccount(t *testing.T) {
	ms := newMintServer()
	ms.status = http.StatusForbidden
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, nil, time.Now)

	_, _, err := b.TokenFor(context.Background(), "ex-user-1", "guest@example.com")
	if !errors.Is(err, ErrCliffyNoAccount) {
		t.Fatalf("err = %v, want ErrCliffyNoAccount", err)
	}
}

func TestTokenFor_ServerErrorIsTransient(t *testing.T) {
	ms := newMintServer()
	ms.status = http.StatusInternalServerError
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, nil, time.Now)

	_, _, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com")
	if err == nil || errors.Is(err, ErrCliffyNoAccount) {
		t.Fatalf("err = %v, want a transient (non-no-account) error", err)
	}
}

func TestTokenFor_CachesToken(t *testing.T) {
	ms := newMintServer()
	ms.expiresAt = time.Now().Add(15 * time.Minute)
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, newFakeCache(), time.Now)

	for i := 0; i < 3; i++ {
		if _, _, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com"); err != nil {
			t.Fatalf("TokenFor #%d: %v", i, err)
		}
	}
	if n := atomic.LoadInt32(&ms.calls); n != 1 {
		t.Errorf("mint calls = %d, want 1 (cached thereafter)", n)
	}
}

func TestTokenFor_RemintsWithinRefreshMargin(t *testing.T) {
	ms := newMintServer()
	// Token expires in 30s; refresh margin is 60s → always considered stale.
	ms.expiresAt = time.Now().Add(30 * time.Second)
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, newFakeCache(), time.Now)

	for i := 0; i < 2; i++ {
		if _, _, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com"); err != nil {
			t.Fatalf("TokenFor #%d: %v", i, err)
		}
	}
	if n := atomic.LoadInt32(&ms.calls); n != 2 {
		t.Errorf("mint calls = %d, want 2 (token too close to expiry to cache)", n)
	}
}

func TestRevoke_ClearsCacheAndCallsCliffHub(t *testing.T) {
	var revokeCalls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ai/bridge/mint", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "tok", "token_type": "Bearer",
			"expires_at": time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339Nano),
		})
	})
	mux.HandleFunc("/api/ai/bridge/revoke", func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&revokeCalls, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "revoked": 1})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cache := newFakeCache()
	b := newTestBridge(t, srv.URL+"/api/ai/bridge/mint", cache, time.Now)

	// Seed a cached token, then revoke.
	if _, _, err := b.TokenFor(context.Background(), "u1", "user@example.com"); err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if !cache.has("cliffy:bridge:tok:u1") {
		t.Fatal("expected a cached token before revoke")
	}

	if err := b.Revoke(context.Background(), "u1", "user@example.com"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if cache.has("cliffy:bridge:tok:u1") {
		t.Error("cached token should be cleared after revoke")
	}
	if atomic.LoadInt32(&revokeCalls) != 1 {
		t.Errorf("CliffHub revoke calls = %d, want 1", revokeCalls)
	}
}

func TestSignAssertion_RespectsTTL(t *testing.T) {
	base := time.Unix(1_800_000_000, 0)
	b := newTestBridge(t, "https://cliffhub.example/api/ai/bridge/mint", nil, func() time.Time { return base })

	assertion := b.signAssertion("ex-user-1", "user@example.com")
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(assertion, claims, func(*jwt.Token) (interface{}, error) {
		return []byte(testBridgeSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		t.Fatalf("parse: %v", err)
	}
	iat, _ := claims["iat"].(float64)
	exp, _ := claims["exp"].(float64)
	if int64(exp-iat) != 45 {
		t.Errorf("exp-iat = %d, want 45", int64(exp-iat))
	}
}

// The construction, cache, mint, and revoke arms the round-trip tests don't reach.

func TestNewCliffyBridge_Arms(t *testing.T) {
	t.Run("disabled when either half is missing", func(t *testing.T) {
		// Returning (nil, nil) lets the caller treat Cliffy as simply off, which is
		// how the router decides whether to register its routes at all.
		for _, cfg := range []CliffyBridgeConfig{
			{},
			{Secret: testBridgeSecret},
			{MintURL: "https://cliffhub.example/api/ai/bridge/mint"},
			{Secret: "   ", MintURL: "   "},
		} {
			b, err := NewCliffyBridge(cfg)
			if err != nil || b != nil {
				t.Errorf("NewCliffyBridge(%+v) = (%v, %v), want (nil, nil)", cfg, b, err)
			}
		}
	})

	t.Run("an unusable mint URL is a construction error", func(t *testing.T) {
		for _, u := range []string{"not-a-url", "/relative/only", "https://"} {
			if _, err := NewCliffyBridge(CliffyBridgeConfig{Secret: testBridgeSecret, MintURL: u}); err == nil {
				t.Errorf("MintURL %q was accepted, want a construction error", u)
			}
		}
	})

	t.Run("defaults fill in the optional knobs", func(t *testing.T) {
		b, err := NewCliffyBridge(CliffyBridgeConfig{
			Secret: testBridgeSecret, MintURL: "https://cliffhub.example/api/ai/bridge/mint",
		})
		if err != nil || b == nil {
			t.Fatalf("NewCliffyBridge = (%v, %v)", b, err)
		}
		if b.assertionTTL <= 0 || b.refreshMargin <= 0 || b.client == nil || b.now == nil {
			t.Errorf("bridge = %+v, want defaults for TTL, margin, client, and clock", b)
		}
		// The revoke endpoint is derived from mint (…/mint → …/revoke).
		if b.revokeURL != "https://cliffhub.example/api/ai/bridge/revoke" {
			t.Errorf("revokeURL = %q", b.revokeURL)
		}
	})

	t.Run("a mint URL that does not end in /mint yields no revoke URL", func(t *testing.T) {
		// Guessing a revoke path from an arbitrary URL would POST assertions at
		// something that isn't the revoke endpoint.
		b, err := NewCliffyBridge(CliffyBridgeConfig{
			Secret: testBridgeSecret, MintURL: "https://cliffhub.example/api/ai/bridge/exchange",
		})
		if err != nil {
			t.Fatalf("NewCliffyBridge: %v", err)
		}
		if b.revokeURL != "" {
			t.Errorf("revokeURL = %q, want empty", b.revokeURL)
		}
	})
}

// A nil bridge is the "Cliffy disabled" case and must be safe to call.
func TestCliffyBridge_NilReceiver(t *testing.T) {
	var b *CliffyBridge
	if _, _, err := b.TokenFor(context.Background(), "u1", "u1@example.com"); err == nil {
		t.Error("TokenFor on a disabled bridge should report it is disabled")
	}
	if err := b.Revoke(context.Background(), "u1", "u1@example.com"); err != nil {
		t.Errorf("Revoke on a disabled bridge = %v, want nil", err)
	}
}

// Without an email there is no way to resolve a CliffHub employee, so ex refuses
// locally rather than round-tripping to be rejected.
func TestCliffyBridge_TokenForRequiresUserAndEmail(t *testing.T) {
	b, err := NewCliffyBridge(CliffyBridgeConfig{
		Secret: testBridgeSecret, MintURL: "https://cliffhub.example/api/ai/bridge/mint",
	})
	if err != nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	for _, tc := range [][2]string{{"", "u1@example.com"}, {"u1", ""}, {"  ", "  "}} {
		if _, _, err := b.TokenFor(context.Background(), tc[0], tc[1]); !errors.Is(err, ErrCliffyNoAccount) {
			t.Errorf("TokenFor(%q, %q) = %v, want ErrCliffyNoAccount", tc[0], tc[1], err)
		}
	}
}

// bridgeWithServer builds a bridge pointed at srv with a controllable clock.
func bridgeWithServer(t *testing.T, srv *httptest.Server, cache BridgeTokenCache, now func() time.Time) *CliffyBridge {
	t.Helper()
	b, err := NewCliffyBridge(CliffyBridgeConfig{
		Secret:     testBridgeSecret,
		MintURL:    srv.URL + "/api/ai/bridge/mint",
		HTTPClient: srv.Client(),
		Cache:      cache,
		now:        now,
	})
	if err != nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	return b
}

func TestCliffyBridge_MintFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("403 means the user has no CliffHub identity", func(t *testing.T) {
		// Definitive, not transient: the UI shows "unavailable" rather than retrying.
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer srv.Close()
		b := bridgeWithServer(t, srv, nil, time.Now)
		if _, _, err := b.TokenFor(ctx, "u1", "u1@example.com"); !errors.Is(err, ErrCliffyNoAccount) {
			t.Fatalf("err = %v, want ErrCliffyNoAccount", err)
		}
	})

	t.Run("any other non-2xx is transient", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		}))
		defer srv.Close()
		b := bridgeWithServer(t, srv, nil, time.Now)
		_, _, err := b.TokenFor(ctx, "u1", "u1@example.com")
		if err == nil || errors.Is(err, ErrCliffyNoAccount) {
			t.Fatalf("err = %v, want a transient failure distinct from ErrCliffyNoAccount", err)
		}
	})

	t.Run("a malformed response body is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not json"))
		}))
		defer srv.Close()
		b := bridgeWithServer(t, srv, nil, time.Now)
		if _, _, err := b.TokenFor(ctx, "u1", "u1@example.com"); err == nil {
			t.Fatal("want a decode error")
		}
	})

	t.Run("a response missing the token or expiry is an error", func(t *testing.T) {
		// A blank token would be forwarded to CliffHub and fail confusingly later.
		for _, body := range []string{`{}`, `{"token":"t"}`, `{"expires_at":"2030-01-01T00:00:00Z"}`} {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(body))
			}))
			b := bridgeWithServer(t, srv, nil, time.Now)
			_, _, err := b.TokenFor(ctx, "u1", "u1@example.com")
			srv.Close()
			if err == nil {
				t.Errorf("body %s was accepted, want an error", body)
			}
		}
	})

	t.Run("an unreachable mint endpoint is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		b := bridgeWithServer(t, srv, nil, time.Now)
		srv.Close() // closed → connection refused
		if _, _, err := b.TokenFor(ctx, "u1", "u1@example.com"); err == nil {
			t.Fatal("want a transport error")
		}
	})
}

// A cached token past its refresh margin is not reused — the cache is an
// optimization, and a nearly-expired token would fail mid-request.
func TestCliffyBridge_CacheFreshness(t *testing.T) {
	ctx := context.Background()
	var mints atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mints.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "tok", "expires_at": time.Now().Add(30 * time.Second),
		})
	}))
	defer srv.Close()

	cache := newFakeCache()
	b := bridgeWithServer(t, srv, cache, time.Now)
	// Expiry (30s) is inside the default refresh margin (60s), so toCache declines
	// to store it and the next call must mint again.
	if _, _, err := b.TokenFor(ctx, "u1", "u1@example.com"); err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if cache.has(b.cacheKey("u1")) {
		t.Error("a token inside the refresh margin should not be cached")
	}
	if _, _, err := b.TokenFor(ctx, "u1", "u1@example.com"); err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if mints.Load() != 2 {
		t.Errorf("mints = %d, want 2 (the short-lived token must not be reused)", mints.Load())
	}
}

// A cached record that is present but unusable (blank token, or too close to
// expiry) is ignored rather than served.
func TestCliffyBridge_IgnoresUnusableCacheRecords(t *testing.T) {
	ctx := context.Background()
	var mints atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mints.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "fresh", "expires_at": time.Now().Add(15 * time.Minute),
		})
	}))
	defer srv.Close()

	for _, rec := range []cachedBridgeToken{
		{Token: "", ExpiresAt: time.Now().Add(time.Hour)},
		{Token: "stale", ExpiresAt: time.Now().Add(5 * time.Second)},
	} {
		cache := newFakeCache()
		b := bridgeWithServer(t, srv, cache, time.Now)
		if err := cache.Set(ctx, b.cacheKey("u1"), rec, time.Hour); err != nil {
			t.Fatalf("seed cache: %v", err)
		}
		before := mints.Load()
		tok, _, err := b.TokenFor(ctx, "u1", "u1@example.com")
		if err != nil {
			t.Fatalf("TokenFor: %v", err)
		}
		if tok != "fresh" || mints.Load() != before+1 {
			t.Errorf("record %+v was served from cache; want a fresh mint", rec)
		}
	}
}

// A cache backend that is down must not break the bridge — it just means every
// call mints.
func TestCliffyBridge_CacheBackendFailureIsNonFatal(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "tok", "expires_at": time.Now().Add(15 * time.Minute),
		})
	}))
	defer srv.Close()

	b := bridgeWithServer(t, srv, failingBridgeCache{}, time.Now)
	tok, _, err := b.TokenFor(ctx, "u1", "u1@example.com")
	if err != nil || tok != "tok" {
		t.Fatalf("TokenFor = (%q, %v), want the minted token", tok, err)
	}
}

// failingBridgeCache fails every operation.
type failingBridgeCache struct{}

func (failingBridgeCache) Get(context.Context, string, interface{}) error {
	return errors.New("cache down")
}

func (failingBridgeCache) Set(context.Context, string, interface{}, time.Duration) error {
	return errors.New("cache down")
}

func (failingBridgeCache) Delete(context.Context, string) error { return errors.New("cache down") }

func TestCliffyBridge_Revoke(t *testing.T) {
	ctx := context.Background()

	t.Run("clears the cache and calls CliffHub", func(t *testing.T) {
		var revoked atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/revoke") {
				revoked.Add(1)
				w.WriteHeader(http.StatusOK)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "tok", "expires_at": time.Now().Add(15 * time.Minute),
			})
		}))
		defer srv.Close()

		cache := newFakeCache()
		b := bridgeWithServer(t, srv, cache, time.Now)
		if _, _, err := b.TokenFor(ctx, "u1", "u1@example.com"); err != nil {
			t.Fatalf("TokenFor: %v", err)
		}
		if !cache.has(b.cacheKey("u1")) {
			t.Fatal("expected the token to be cached")
		}
		if err := b.Revoke(ctx, "u1", "u1@example.com"); err != nil {
			t.Fatalf("Revoke: %v", err)
		}
		// Both halves matter: ex must stop reusing it, and CliffHub must delete it
		// so the session can't outlive the ex login even within its TTL.
		if cache.has(b.cacheKey("u1")) {
			t.Error("the cached token survived revocation")
		}
		if revoked.Load() != 1 {
			t.Errorf("revoke calls = %d, want 1", revoked.Load())
		}
	})

	t.Run("nothing to call without a revoke URL, a user, or an email", func(t *testing.T) {
		var called atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			called.Add(1)
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		// No trailing /mint → no derived revoke URL.
		noRevoke, err := NewCliffyBridge(CliffyBridgeConfig{
			Secret: testBridgeSecret, MintURL: srv.URL + "/api/ai/bridge/exchange",
			HTTPClient: srv.Client(), Cache: newFakeCache(),
		})
		if err != nil {
			t.Fatalf("NewCliffyBridge: %v", err)
		}
		if err := noRevoke.Revoke(ctx, "u1", "u1@example.com"); err != nil {
			t.Errorf("Revoke = %v, want nil", err)
		}

		b := bridgeWithServer(t, srv, newFakeCache(), time.Now)
		if err := b.Revoke(ctx, "", "u1@example.com"); err != nil {
			t.Errorf("Revoke(no user) = %v, want nil", err)
		}
		if err := b.Revoke(ctx, "u1", "   "); err != nil {
			t.Errorf("Revoke(no email) = %v, want nil", err)
		}
		if called.Load() != 0 {
			t.Errorf("calls = %d, want 0", called.Load())
		}
	})

	t.Run("a failing revoke endpoint is reported", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		b := bridgeWithServer(t, srv, newFakeCache(), time.Now)
		if err := b.Revoke(ctx, "u1", "u1@example.com"); err == nil {
			t.Fatal("want the failure reported so logout can log it")
		}
	})

	t.Run("an unreachable revoke endpoint is reported", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		b := bridgeWithServer(t, srv, newFakeCache(), time.Now)
		srv.Close()
		if err := b.Revoke(ctx, "u1", "u1@example.com"); err == nil {
			t.Fatal("want a transport error")
		}
	})
}

// The request-construction guards in mint and Revoke are reachable through a nil
// context, which http.NewRequestWithContext rejects. Keeping them exercised means
// a future change that can genuinely fail here stays covered.
func TestCliffyBridge_NilContextIsRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "tok", "expires_at": time.Now().Add(15 * time.Minute),
		})
	}))
	defer srv.Close()
	b := bridgeWithServer(t, srv, nil, time.Now)

	// A nil context via a variable, not a literal, so the nil-context linter does
	// not flag what is deliberately under test here.
	var nilCtx context.Context
	if _, _, err := b.TokenFor(nilCtx, "u1", "u1@example.com"); err == nil {
		t.Error("mint should refuse a nil context")
	}
	if err := b.Revoke(nilCtx, "u1", "u1@example.com"); err == nil {
		t.Error("revoke should refuse a nil context")
	}
}
