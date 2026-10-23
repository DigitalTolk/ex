package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
	"golang.org/x/crypto/bcrypt"
)

// ---------------------------------------------------------------- login CSRF

// Regression: the browser callback carried the access JWT in the redirect URL
// (/oidc/callback?token=…), and the SPA signed in with whatever token a URL
// handed it — a crafted link could sign a victim into the attacker's account.
// The browser now gets a bare redirect and the session rides the refresh
// cookie only.
func TestOIDCCallbackRedirectsBrowsersWithoutAToken(t *testing.T) {
	h, _, _ := setupAuthHandlerWithOIDCSuccess(t)
	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=ok&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "ok"})
	rec := httptest.NewRecorder()
	h.OIDCCallback(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc != "/oidc/callback" {
		t.Fatalf("Location = %q, want the bare /oidc/callback", loc)
	}
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "refresh_token" && c.Value != "" {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/auth" {
		t.Fatalf("refresh cookie = %+v, want httpOnly SameSite=Strict on /auth", cookie)
	}
}

// Every allowlisted app target — tauri:// and ex://app included — gets a
// one-time desktop_code, never a token in its URL.
func TestOIDCCallbackGivesEveryAppTargetADesktopCode(t *testing.T) {
	for _, target := range []string{"tauri://localhost/cb", "ex://app/cb", "https://localhost:5173/cb", "http://localhost:1234/cb", "ex://mobile/auth/callback"} {
		h, _, _ := setupAuthHandlerWithOIDCSuccess(t)
		req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=ok&code=c", nil)
		req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "ok"})
		req.AddCookie(&http.Cookie{Name: "oauth_redirect", Value: target})
		rec := httptest.NewRecorder()
		h.OIDCCallback(rec, req)
		loc := rec.Header().Get("Location")
		if !strings.HasPrefix(loc, target+"?desktop_code=") || strings.Contains(loc, "token=") {
			t.Errorf("%s: Location = %q, want a desktop_code and no token", target, loc)
		}
		assertNoRefreshCookie(t, rec)
	}
}

// Regression: /auth/desktop/complete planted a session for any valid code,
// so a link to it (posted in a message — same-origin — or on another site)
// signed the clicker into the code minter's account. Only a navigation the
// app itself starts (Sec-Fetch-Site: none, or no fetch metadata at all) may
// redeem a code.
func TestDesktopCompleteRefusesLinkNavigations(t *testing.T) {
	for _, site := range []string{"same-origin", "same-site", "cross-site"} {
		h, _, _ := setupAuthHandlerWithOIDCSuccess(t)
		code, err := h.authSvc.CreateDesktopAuthSession(context.Background(), "refresh-1")
		if err != nil {
			t.Fatalf("code: %v", err)
		}
		req := httptest.NewRequest(http.MethodGet, "/auth/desktop/complete?code="+code, nil)
		req.Header.Set("Sec-Fetch-Site", site)
		rec := httptest.NewRecorder()
		h.DesktopComplete(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("Sec-Fetch-Site %s: status %d, want 403", site, rec.Code)
		}
		assertNoRefreshCookie(t, rec)
		// The refused attempt didn't burn the code for the real app.
		ok := httptest.NewRequest(http.MethodGet, "/auth/desktop/complete?code="+code, nil)
		ok.Header.Set("Sec-Fetch-Site", "none")
		rec = httptest.NewRecorder()
		h.DesktopComplete(rec, ok)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/oidc/callback" {
			t.Fatalf("app navigation after a refused link: %d %q", rec.Code, rec.Header().Get("Location"))
		}
	}
}

// ---------------------------------------------------------------- generic errors

// Regression: refresh, invite-accept and guest-login answered unauthenticated
// callers with the service's own error text, internals included.
func TestUnauthenticatedAuthErrorsAreGeneric(t *testing.T) {
	t.Run("refresh", func(t *testing.T) {
		h, _, _ := setupAuthHandler(t)
		req := httptest.NewRequest(http.MethodPost, "/auth/token/refresh", nil)
		req.AddCookie(&http.Cookie{Name: "refresh_token", Value: "unknown"})
		rec := httptest.NewRecorder()
		h.RefreshToken(rec, req)
		if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "auth:") {
			t.Fatalf("refresh: %d %s, want 401 with a fixed message", rec.Code, rec.Body.String())
		}
	})
	t.Run("guest login infrastructure failure", func(t *testing.T) {
		h, users, _ := setupAuthHandler(t)
		users.getEmailErr = errors.New("dynamodb: ProvisionedThroughputExceeded on table ex-prod")
		req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"g@example.com","password":"password-1"}`))
		rec := httptest.NewRecorder()
		h.GuestLogin(rec, req)
		if strings.Contains(rec.Body.String(), "dynamodb") || strings.Contains(rec.Body.String(), "ex-prod") {
			t.Fatalf("guest login leaked internals: %s", rec.Body.String())
		}
	})
	t.Run("invite accept infrastructure failure", func(t *testing.T) {
		h, users, _ := setupAuthHandler(t)
		h.authSvc = newAuthServiceWithInviteErr(users, errors.New("dynamodb: table ex-prod unreachable"))
		req := httptest.NewRequest(http.MethodPost, "/auth/invite/accept", strings.NewReader(`{"token":"t","displayName":"G","password":"password-1"}`))
		rec := httptest.NewRecorder()
		h.AcceptInvite(rec, req)
		if strings.Contains(rec.Body.String(), "dynamodb") || strings.Contains(rec.Body.String(), "ex-prod") {
			t.Fatalf("invite accept leaked internals: %s", rec.Body.String())
		}
	})
}

// ---------------------------------------------------------------- invites

// Regression: POST /auth/invite only required a session — a guest could
// invite an employee's not-yet-registered address and take the account.
func TestRouterInviteIsAdminOnly(t *testing.T) {
	jwtMgr := testJWT()
	users := newMockUserStore()
	users.users["u-1"] = &model.User{ID: "u-1", SystemRole: model.SystemRoleMember, Status: "active"}
	router := routerWithUsers(t, users, jwtMgr)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, authedReq(t, jwtMgr, http.MethodPost, "/auth/invite", `{"email":"new@example.com"}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member invite = %d, want 403", rec.Code)
	}
}

// ---------------------------------------------------------------- helpers

func testJWT() *auth.JWTManager {
	return auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
}

// routerWithUsers builds the real router over a stateful user store, with
// the stored-role auth middleware the production wiring uses.
func routerWithUsers(t *testing.T, users *mockUserStore, jwtMgr *auth.JWTManager) http.Handler {
	t.Helper()
	authSvc := service.NewAuthService(users, newMockTokenStore(), &mockInviteStore{}, &mockMembershipStore{}, &mockChannelStore{}, jwtMgr, nil, newMockCache())
	return NewRouter(&Deps{
		Auth: NewAuthHandler(authSvc, jwtMgr), User: NewUserHandler(service.NewUserService(users, nil, nil, nil), nil),
		Channel: &ChannelHandler{}, Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"},
	})
}

type errInviteStore struct{ err error }

func (e errInviteStore) CreateInvite(context.Context, *model.Invite) error { return e.err }
func (e errInviteStore) GetInvite(context.Context, string) (*model.Invite, error) {
	return nil, e.err
}
func (e errInviteStore) DeleteInvite(context.Context, string) error { return e.err }

func newAuthServiceWithInviteErr(users *mockUserStore, err error) *service.AuthService {
	return service.NewAuthService(users, newMockTokenStore(), errInviteStore{err}, &mockMembershipStore{}, &mockChannelStore{}, testJWT(), nil, newMockCache())
}

func reqAs(t *testing.T, jwtMgr *auth.JWTManager, u *model.User, method, target, body string) *http.Request {
	t.Helper()
	tok, err := jwtMgr.GenerateAccessToken(u)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

// ---------------------------------------------------------------- guest scoping

// Regression: the roster (?all=true, also the directory, search and batch
// reads) handed guests every member's email, phone and manager.
func TestUserReadsHideContactDetailsFromGuests(t *testing.T) {
	jwtMgr := testJWT()
	users := newMockUserStore()
	guest := &model.User{ID: "g-1", Email: "guest@example.com", SystemRole: model.SystemRoleGuest, Status: "active", AuthProvider: model.AuthProviderGuest}
	member := &model.User{ID: "m-1", Email: "member@corp.example", DisplayName: "Member", Phone: "+46 70 1", Manager: &model.UserManager{DisplayName: "Boss"}, SystemRole: model.SystemRoleMember, Status: "active"}
	users.users[guest.ID], users.users[member.ID] = guest, member
	users.emailIndex[guest.Email], users.emailIndex[member.Email] = guest, member
	router := routerWithUsers(t, users, jwtMgr)

	for _, target := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/users?all=true", ""},
		{http.MethodGet, "/api/v1/users", ""},
		{http.MethodGet, "/api/v1/users?q=member", ""},
		{http.MethodGet, "/api/v1/users/m-1", ""},
		{http.MethodPost, "/api/v1/users/batch", `{"ids":["m-1"]}`},
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, reqAs(t, jwtMgr, guest, target.method, target.path, target.body))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s = %d (%s)", target.method, target.path, rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		if strings.Contains(body, "member@corp.example") || strings.Contains(body, "+46 70 1") || strings.Contains(body, "Boss") {
			t.Fatalf("%s %s leaked contact details to a guest: %s", target.method, target.path, body)
		}
		if !strings.Contains(body, `"m-1"`) {
			t.Fatalf("%s %s dropped the user itself: %s", target.method, target.path, body)
		}
	}
	// A member still sees them.
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, reqAs(t, jwtMgr, member, http.MethodGet, "/api/v1/users?all=true", ""))
	if !strings.Contains(rec.Body.String(), "member@corp.example") {
		t.Fatalf("members lost the roster's contact details: %s", rec.Body.String())
	}
}

// Regression: channel search listed every public channel to guests.
func TestSearchChannelsShowsGuestsOnlyTheirChannels(t *testing.T) {
	h, sr, access, jwtMgr := setupSearchTest(t)
	access.parents = []string{"ch-mine"}
	sr.channelsHits = []search.SearchHit{{ID: "ch-public"}, {ID: "ch-mine"}}
	guest := &model.User{ID: "g-1", SystemRole: model.SystemRoleGuest}
	req := reqAs(t, jwtMgr, guest, http.MethodGet, "/api/v1/search/channels?q=ch&limit=5", "")
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchChannels)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "ch-public") || !strings.Contains(rec.Body.String(), "ch-mine") {
		t.Fatalf("guest channel search = %s, want only ch-mine", rec.Body.String())
	}
	if sr.channelOpts.Limit != 100 {
		t.Fatalf("guest search fetched %d hits, want the widest page before filtering", sr.channelOpts.Limit)
	}
	// A member keeps Slack-style public discovery.
	member := &model.User{ID: "m-1", SystemRole: model.SystemRoleMember}
	rec = httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchChannels)).ServeHTTP(rec, reqAs(t, jwtMgr, member, http.MethodGet, "/api/v1/search/channels?q=ch", ""))
	if !strings.Contains(rec.Body.String(), "ch-public") {
		t.Fatalf("member lost public channel discovery: %s", rec.Body.String())
	}
}

// Guest results are trimmed to the requested limit after filtering.
func TestSearchChannelsGuestResultsRespectTheLimit(t *testing.T) {
	h, sr, access, jwtMgr := setupSearchTest(t)
	access.parents = []string{"a", "b", "c"}
	sr.channelsHits = []search.SearchHit{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	guest := &model.User{ID: "g-1", SystemRole: model.SystemRoleGuest}
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchChannels)).ServeHTTP(rec, reqAs(t, jwtMgr, guest, http.MethodGet, "/api/v1/search/channels?q=x&limit=2", ""))
	var res search.SearchResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Hits) != 2 || res.Total != 2 {
		t.Fatalf("hits = %d total = %d, want 2/2", len(res.Hits), res.Total)
	}
}

// Regression: /coding-projects had no caller check while /projects refused
// guests.
func TestCodingProjectsRefusesGuests(t *testing.T) {
	fx := newHtaskCovFixture(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/coding-projects", nil)
	req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "g-1", SystemRole: model.SystemRoleGuest}))
	rec := httptest.NewRecorder()
	fx.h.ListProjects(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("guest coding-projects = %d, want 403", rec.Code)
	}
	rec = httptest.NewRecorder()
	fx.h.ListProjects(rec, httptest.NewRequest(http.MethodGet, "/api/v1/coding-projects", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("anonymous coding-projects = %d, want 403", rec.Code)
	}
}

// ---------------------------------------------------------------- ws timezone

type countingTZStore struct {
	*dataUserStoreForConv
	gets int
}

func (c *countingTZStore) GetUser(ctx context.Context, id string) (*model.User, error) {
	c.gets++
	return c.dataUserStoreForConv.GetUser(ctx, id)
}

// Regression: every timezone.update frame cost a user read + write, at the
// client's pace. One per connection per timeZoneMinInterval is honored.
func TestWSTimeZoneUpdatesAreThrottledPerConnection(t *testing.T) {
	users := &countingTZStore{dataUserStoreForConv: newDataUserStoreForConv()}
	users.users["u-1"] = &model.User{ID: "u-1", Email: "u1@example.com", Status: "active", TimeZone: "UTC"}
	h := &WSHandler{}
	h.SetUserService(service.NewUserService(users, nil, nil, nil))
	gate := newTypingGate()
	for _, tz := range []string{"Europe/Stockholm", "Asia/Tokyo", "America/New_York"} {
		raw, _ := json.Marshal(map[string]string{"type": "timezone.update", "timeZone": tz})
		h.handleInbound(context.Background(), "u-1", raw, gate)
	}
	if users.gets != 1 || users.users["u-1"].TimeZone != "Europe/Stockholm" {
		t.Fatalf("reads = %d tz = %q, want one honored frame", users.gets, users.users["u-1"].TimeZone)
	}
	// Once the interval has passed, the next frame is honored.
	gate.lastTimeZone = gate.lastTimeZone.Add(-timeZoneMinInterval)
	raw, _ := json.Marshal(map[string]string{"type": "timezone.update", "timeZone": "Asia/Tokyo"})
	h.handleInbound(context.Background(), "u-1", raw, gate)
	if users.users["u-1"].TimeZone != "Asia/Tokyo" {
		t.Fatalf("tz = %q after the interval, want Asia/Tokyo", users.users["u-1"].TimeZone)
	}
}

// ---------------------------------------------------------------- deactivation

// Admins can deactivate SSO accounts; nobody can deactivate themselves (an
// admin locking themselves out of the workspace).
func TestSetUserStatusRoutes(t *testing.T) {
	jwtMgr := testJWT()
	users := newMockUserStore()
	admin := &model.User{ID: "a-1", SystemRole: model.SystemRoleAdmin, Status: "active", AuthProvider: model.AuthProviderOIDC}
	sso := &model.User{ID: "s-1", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users[admin.ID], users.users[sso.ID] = admin, sso
	router := routerWithUsers(t, users, jwtMgr)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, reqAs(t, jwtMgr, admin, http.MethodPatch, "/api/v1/users/s-1/status", `{"deactivated":true}`))
	if rec.Code != http.StatusOK || sso.Status != "deactivated" {
		t.Fatalf("deactivate SSO = %d status %q (%s)", rec.Code, sso.Status, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, reqAs(t, jwtMgr, admin, http.MethodPatch, "/api/v1/users/a-1/status", `{"deactivated":true}`))
	if rec.Code != http.StatusBadRequest || admin.Status != "active" {
		t.Fatalf("self-deactivation = %d status %q, want 400 and still active", rec.Code, admin.Status)
	}
}

// ---------------------------------------------------------------- compression

func TestRouterCompressesTheSPA(t *testing.T) {
	jwtMgr := testJWT()
	fsys := fstest.MapFS{
		"index.html":      {Data: []byte("<html><head></head><body>" + strings.Repeat("x", 4096) + "</body></html>")},
		"assets/app-1.js": {Data: []byte(strings.Repeat("console.log('x');", 400))},
	}
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{}, Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"}, FrontendFS: fsys,
	})
	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	asset := get("/assets/app-1.js")
	if asset.Header().Get("Content-Encoding") != "gzip" || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset: encoding %q cache %q", asset.Header().Get("Content-Encoding"), asset.Header().Get("Cache-Control"))
	}
	index := get("/")
	if index.Header().Get("Content-Encoding") != "gzip" || index.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("index: encoding %q cache %q", index.Header().Get("Content-Encoding"), index.Header().Get("Cache-Control"))
	}
}

// ---------------------------------------------------------------- error arms

func TestOIDCCallbackPolicyRefusalIs403(t *testing.T) {
	h, users, _ := setupAuthHandlerWithOIDCSuccess(t)
	off := &model.User{ID: "u-off", Email: "callback@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC, Status: "deactivated"}
	users.users[off.ID], users.emailIndex[off.Email] = off, off
	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=ok&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "ok"})
	rec := httptest.NewRecorder()
	h.OIDCCallback(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "sign_in_refused") {
		t.Fatalf("deactivated SSO login = %d %s, want 403 sign_in_refused", rec.Code, rec.Body.String())
	}
	assertNoRefreshCookie(t, rec)
}

// A sign-in the identity policy refused answers with the refusal's own fixed
// text (no "auth:" prefix), never the wrapping chain; an internal failure is
// no refusal.
func TestOIDCRefusal(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{service.ErrAccountDeactivated, http.StatusForbidden, "sign_in_refused"},
		{service.ErrIdentityMismatch, http.StatusForbidden, "sign_in_refused"},
		{service.ErrEmailUnverified, http.StatusForbidden, "sign_in_refused"},
		{service.ErrEmailDomainNotAllowed, http.StatusForbidden, "sign_in_refused"},
	}
	for _, c := range cases {
		m, ok := lookupError(fmt.Errorf("wrapped: %w", c.err))
		want := strings.TrimPrefix(c.err.Error(), "auth: ")
		if !ok || m.status != c.status || m.code != c.code || m.text(c.err) != want {
			t.Errorf("lookupError(%v) = %d/%q %q, %v; want %d/%q %q", c.err, m.status, m.code, m.text(c.err), ok, c.status, c.code, want)
		}
	}
	if _, ok := lookupError(errors.New("dynamo down")); ok {
		t.Error("an internal failure is not a policy refusal")
	}
}

type failingTokenStore struct {
	*mockTokenStore
	getErr error
}

func (f *failingTokenStore) GetRefreshToken(ctx context.Context, hash string) (*model.RefreshToken, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.mockTokenStore.GetRefreshToken(ctx, hash)
}

// A store failure during refresh is the server's: 5xx, so the client retries
// instead of signing a probably-valid session out.
func TestRefreshTokenInfrastructureFailureIs500(t *testing.T) {
	jwtMgr := testJWT()
	tokens := &failingTokenStore{mockTokenStore: newMockTokenStore(), getErr: errors.New("dynamodb throttled")}
	authSvc := service.NewAuthService(newMockUserStore(), tokens, &mockInviteStore{}, &mockMembershipStore{}, &mockChannelStore{}, jwtMgr, nil, newMockCache())
	h := NewAuthHandler(authSvc, jwtMgr)
	req := httptest.NewRequest(http.MethodPost, "/auth/token/refresh", nil)
	req.AddCookie(&http.Cookie{Name: "refresh_token", Value: "whatever"})
	rec := httptest.NewRecorder()
	h.RefreshToken(rec, req)
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "dynamodb") {
		t.Fatalf("refresh on a store failure = %d %s, want a generic 500", rec.Code, rec.Body.String())
	}
}

func TestCreateInviteHandlerRefusesNonAdmins(t *testing.T) {
	h, users, _ := setupAuthHandler(t)
	jwtMgr := testJWT()
	member := &model.User{ID: "m-inv", Email: "m@example.com", SystemRole: model.SystemRoleMember}
	users.users[member.ID] = member
	req := reqAs(t, jwtMgr, member, http.MethodPost, "/auth/invite", `{"email":"new@example.com"}`)
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateInvite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member invite = %d, want 403", rec.Code)
	}
}

func TestGuestLoginHandlerErrorArms(t *testing.T) {
	t.Run("deactivated", func(t *testing.T) {
		h, users, _ := setupAuthHandler(t)
		hashed, _ := bcrypt.GenerateFromPassword([]byte("password-1"), bcrypt.MinCost)
		g := &model.User{ID: "g-off", Email: "g@example.com", SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, PasswordHash: string(hashed), Status: "deactivated"}
		users.users[g.ID], users.emailIndex[g.Email] = g, g
		rec := httptest.NewRecorder()
		h.GuestLogin(rec, httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"g@example.com","password":"password-1"}`)))
		// 403 sign_in_refused, like the SSO callback's refusal of the same
		// account: one sentinel, one status (it used to be 401 here).
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "deactivated") {
			t.Fatalf("deactivated guest = %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("store failure", func(t *testing.T) {
		h, users, _ := setupAuthHandler(t)
		users.getEmailErr = errors.New("dynamo down")
		rec := httptest.NewRecorder()
		h.GuestLogin(rec, httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"g@example.com","password":"password-1"}`)))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("store failure = %d, want 500", rec.Code)
		}
	})
}

func TestAcceptInviteHandlerKnownFailuresKeepTheirMessage(t *testing.T) {
	h, _, _ := setupAuthHandler(t)
	rec := httptest.NewRecorder()
	h.AcceptInvite(rec, httptest.NewRequest(http.MethodPost, "/auth/invite/accept", strings.NewReader(`{"token":"t","displayName":"G","password":"short"}`)))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "password must be at least") || strings.Contains(rec.Body.String(), "auth:") {
		t.Fatalf("short password = %d %s", rec.Code, rec.Body.String())
	}
}

func TestOnlyChannelsDefaultLimit(t *testing.T) {
	hits := make([]search.SearchHit, 0, 30)
	allowed := make([]string, 0, 30)
	for i := range 30 {
		id := fmt.Sprintf("c-%d", i)
		hits = append(hits, search.SearchHit{ID: id})
		allowed = append(allowed, id)
	}
	if got := onlyChannels(&search.SearchResult{Hits: hits}, allowed, 0); len(got.Hits) != 20 {
		t.Fatalf("default page = %d, want 20", len(got.Hits))
	}
}

func TestSetUserStatusServiceFailureIs500(t *testing.T) {
	jwtMgr := testJWT()
	users := newMockUserStore()
	admin := &model.User{ID: "a-1", SystemRole: model.SystemRoleAdmin, Status: "active"}
	users.users[admin.ID] = admin
	h := NewUserHandler(service.NewUserService(&getFailUserStore{mockUserStore: users}, nil, nil, nil), nil)
	req := reqAs(t, jwtMgr, admin, http.MethodPatch, "/api/v1/users/x-1/status", `{"deactivated":true}`)
	req.SetPathValue("id", "x-1")
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("store failure = %d, want 500", rec.Code)
	}
}

type getFailUserStore struct{ *mockUserStore }

func (g *getFailUserStore) GetUser(context.Context, string) (*model.User, error) {
	return nil, errors.New("dynamo down")
}
