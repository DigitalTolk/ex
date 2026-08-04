package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/service"
)

// TestNewRouterDoesNotPanic verifies that all route patterns are compatible
// and don't cause the stdlib mux to panic on registration.
func TestNewRouterDoesNotPanic(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)

	// All handlers can be nil-safe for registration — the mux only panics on
	// conflicting patterns, which happens during Handle/HandleFunc calls.
	// We need real handler structs but they won't be invoked.
	authH := &AuthHandler{}
	userH := &UserHandler{}
	channelH := &ChannelHandler{}
	convH := &ConversationHandler{}
	wsH := &WSHandler{}

	// This is the call that panics if routes conflict.
	router := NewRouter(&Deps{Auth: authH, User: userH, Channel: channelH, Conversation: convH, WS: wsH, Activity: NewActivityHandler(nil, nil), JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"}})

	if router == nil {
		t.Fatal("expected non-nil router")
	}
}

// TestRouterHealthEndpoint verifies the health check endpoint works.
func TestRouterHealthEndpoint(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"},
	})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestRouterAddsAppVersionHeaderToAPIResponses(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		Version: NewVersionHandler("server-build-2"),
		JWT:     jwtMgr, AppVersion: "server-build-2", AllowOrigins: []string{"*"},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/missing", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get(AppVersionHeaderName); got != "server-build-2" {
		t.Fatalf("%s = %q, want server-build-2", AppVersionHeaderName, got)
	}
}

// TestRouterRegisteredRoutes verifies that key routes are registered and don't
// 404 due to path mismatches. We check for non-404 responses (401 is fine —
// it means the route matched but auth middleware rejected the request).
func TestRouterRegisteredRoutes(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"},
	})

	routes := []struct {
		method string
		path   string
	}{
		{"GET", "/healthz"},
		{"POST", "/auth/token/refresh"},
		{"POST", "/auth/logout"},
		{"POST", "/auth/invite/accept"},
		{"POST", "/auth/login"},
		{"POST", "/auth/invite"},
		{"GET", "/api/v1/users/me"},
		{"POST", "/api/v1/users/me/avatar/upload-url"},
		{"POST", "/api/v1/users/batch"},
		{"GET", "/api/v1/channels"},
		{"GET", "/api/v1/channels/browse"},
		{"GET", "/api/v1/channels/some-slug"},
		{"POST", "/api/v1/channels/some-id/join"},
		{"POST", "/api/v1/channels/some-id/leave"},
		{"GET", "/api/v1/channels/some-id/members"},
		{"POST", "/api/v1/channels/some-id/members"},
		{"POST", "/api/v1/channels/some-id/messages"},
		{"GET", "/api/v1/channels/some-id/messages"},
		{"GET", "/api/v1/conversations"},
		{"POST", "/api/v1/conversations"},
		{"GET", "/api/v1/ws"},
	}

	for _, rt := range routes {
		req := httptest.NewRequest(rt.method, rt.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code == http.StatusNotFound {
			t.Errorf("%s %s returned 404 — route not registered", rt.method, rt.path)
		}
	}
}

// TestIsULID verifies the ULID detection helper.
func TestIsULID(t *testing.T) {
	valid26 := "01ARZ3NDEKTSV4RRFFQ69G5FAV" // exactly 26 chars
	tests := []struct {
		input string
		want  bool
	}{
		{valid26, true},                      // standard ULID
		{valid26[:25], false},                // 25 chars — too short
		{valid26 + "X", false},               // 27 chars — too long
		{"01arz3ndektsv4rrffq69g5fav", true}, // lowercase OK
		{"general", false},
		{"my-cool-channel", false},
		{"01ARZ3NDEKTSV4RRFFQ69G5FA!", false}, // 26 chars but has special char
		{"", false},
	}
	for _, tt := range tests {
		if got := isULID(tt.input); got != tt.want {
			t.Errorf("isULID(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

// TestIsValidationError covers the error-classification helper that
// decides whether a service-layer failure becomes a 400 (user fixable)
// or a 500 (server problem). The set of recognized validation errors
// is mirrored from internal/service/limits.go.
func TestIsValidationError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil is not validation", nil, false},
		{"random error is not validation", errors.New("boom"), false},
		{"message too long is", service.ErrMessageTooLong, true},
		{"too many attachments is", service.ErrTooManyAttachments, true},
		{"too many reactions is", service.ErrTooManyReactions, true},
		{"channel name invalid is", service.ErrChannelNameInvalid, true},
		{"channel name too long is", service.ErrChannelNameTooLong, true},
		{"channel description too long is", service.ErrChannelDescriptionTooLong, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isValidationError(tc.err); got != tc.want {
				t.Errorf("isValidationError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestNewRouter_AllOptionalHandlersWired exercises the conditional
// branches in NewRouter that mount the optional sub-routers (sidebar,
// uploads, attachments, emojis, presence, search, admin, threads,
// drafts, version, unfurl). Without this, those branches stay at 0% coverage
// even though they are the production wiring path.
func TestNewRouter_AllOptionalHandlersWired(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&Deps{
		Auth:         &AuthHandler{},
		User:         &UserHandler{},
		UserState:    &UserStateHandler{},
		Channel:      &ChannelHandler{},
		Conversation: &ConversationHandler{},
		WS:           &WSHandler{},
		Upload:       &UploadHandler{},
		Emoji:        &EmojiHandler{},
		Presence:     &PresenceHandler{},
		Attachment:   &AttachmentHandler{},
		Admin:        &AdminHandler{},
		Thread:       &ThreadHandler{},
		Draft:        &DraftHandler{},
		Version:      &VersionHandler{},
		Unfurl:       &UnfurlHandler{},
		Sidebar:      &SidebarHandler{},
		Search:       &SearchHandler{},
		Webhook:      &WebhookHandler{},
		Command:      &CommandHandler{},
		JWT:          jwtMgr,
		AppVersion:   "test",
		AllowOrigins: []string{"*"},
	})
	if router == nil {
		t.Fatal("expected non-nil router with all handlers wired")
	}

	// Each optional handler exposes a route — hit at least one to prove
	// the branch ran. We accept any non-404 (including 401 from auth
	// middleware) since 404 would mean the route was never registered.
	paths := []string{
		"/api/v1/version",
		"/api/v1/emojis",
		"/api/v1/presence",
		"/api/v1/threads",
		"/api/v1/drafts",
		"/api/v1/search/users",
		"/api/v1/admin/settings",
		"/api/v1/sidebar/categories",
		"/api/v1/uploads/url",
		"/api/v1/attachments",
		"/api/v1/unfurl",
		"/api/v1/admin/webhooks",
		"/api/v1/commands",
	}
	for _, p := range paths {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code == http.StatusNotFound {
			t.Errorf("path %q got 404 — optional handler likely not wired", p)
		}
	}
}

// TestWriteServiceError covers the validation-vs-fallback branching of
// the centralized error writer.
func TestWriteServiceError(t *testing.T) {
	t.Run("validation error becomes 400", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeServiceError(rec, service.ErrChannelNameInvalid, http.StatusInternalServerError, "ignored_code")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("non-validation error uses fallback", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeServiceError(rec, errors.New("db unavailable"), http.StatusInternalServerError, "db_error")
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
		}
	})

	t.Run("deleted-thread reply becomes 409", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeServiceError(rec, service.ErrThreadDeleted, http.StatusForbidden, "send_error")
		if rec.Code != http.StatusConflict {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusConflict)
		}
	})

	t.Run("nil error still uses fallback", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeServiceError(rec, errors.New("anything"), http.StatusForbidden, "forbidden")
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
		}
	})
}

// NewRouter must reject a nil Deps explicitly so a missing wire-up
// in main.go fails loudly instead of bypassing every nil-handler
// guard inside the router with a confusing later panic.
func TestNewRouter_PanicsOnNilDeps(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil Deps")
		}
	}()
	_ = NewRouter(nil)
}

// Adding a new endpoint must only require setting one Deps field —
// this assertion locks the contract: a freshly-constructed Deps with
// just the required core compiles and produces a working router.
// Future additions to Deps must keep this surface backwards-
// compatible (zero-value optional handlers are skipped silently).
func TestNewRouter_MinimalDepsBuilds(t *testing.T) {
	jwtMgr := auth.NewJWTManager("min-deps-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&Deps{
		Auth:         &AuthHandler{},
		User:         &UserHandler{},
		Channel:      &ChannelHandler{},
		Conversation: &ConversationHandler{},
		WS:           &WSHandler{},
		JWT:          jwtMgr,
		AllowOrigins: []string{"*"},
	})
	if router == nil {
		t.Fatal("minimal Deps should produce a non-nil router")
	}
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/healthz = %d, want 200", rec.Code)
	}
}

// The optional-handler blocks in NewRouter only execute when their Deps field is
// set, so a Deps carrying only the required core leaves those routes unregistered.
// This wires every optional handler this package owns and asserts each route
// matched — a 401/403/404-from-the-handler is fine, an unmatched route falls
// through to the SPA and returns HTML.
func TestRouterRegistersOptionalIntegrationRoutes(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"},

		// The integration surface: bots, MCP, MM-shaped commands, interactive
		// actions, and the Cliffy bridge.
		Bot:             &BotHandler{},
		ExternalCommand: &ExternalCommandHandler{},
		MessageAction:   &MessageActionHandler{},
		Cliffy:          &CliffyHandler{},
	})

	routes := []struct {
		method string
		path   string
	}{
		// Bot admin + tokens.
		{"GET", "/api/v1/admin/bots"},
		{"POST", "/api/v1/admin/bots"},
		{"GET", "/api/v1/admin/bots/bot_x"},
		{"DELETE", "/api/v1/admin/bots/bot_x"},
		{"PUT", "/api/v1/admin/bots/bot_x/webhook"},
		{"GET", "/api/v1/admin/bots/bot_x/tokens"},
		{"POST", "/api/v1/admin/bots/bot_x/tokens"},
		{"DELETE", "/api/v1/admin/bots/bot_x/tokens/tid"},
		// MCP shares one path for POST (requests) and GET (event stream).
		{"POST", "/api/v1/mcp"},
		{"GET", "/api/v1/mcp"},
		// Mattermost-shaped slash commands.
		{"GET", "/api/v1/admin/commands"},
		{"POST", "/api/v1/admin/commands"},
		{"GET", "/api/v1/admin/commands/c1"},
		{"PATCH", "/api/v1/admin/commands/c1"},
		{"DELETE", "/api/v1/admin/commands/c1"},
		// Interactive attachment actions, per parent type.
		{"POST", "/api/v1/channels/ch1/messages/m1/actions/act1"},
		{"POST", "/api/v1/conversations/conv1/messages/m1/actions/act1"},
		// Cliffy bridge.
		{"POST", "/api/v1/cliffy/session"},
		{"POST", "/api/v1/cliffy/chat"},
		{"POST", "/api/v1/cliffy/api"},
		{"POST", "/api/v1/cliffy/share"},
		{"POST", "/api/v1/cliffy/revoke"},
	}
	for _, r := range routes {
		req := httptest.NewRequest(r.method, r.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		// An unregistered API path falls through to the SPA handler, which answers
		// with HTML rather than the JSON/401 a matched route produces.
		if ct := rec.Header().Get("Content-Type"); strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s %s fell through to the SPA (status %d) — route not registered", r.method, r.path, rec.Code)
		}
	}
}

// The command response_url is deliberately public: the path token is the whole
// credential, so it must match without authentication.
func TestRouterRegistersPublicCommandResponseHook(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", 15*time.Minute, 24*time.Hour)
	svc := service.NewExternalCommandService(service.ExternalCommandDeps{Store: newMemExtCommandStore()})
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"},
		ExternalCommand: NewExternalCommandHandler(svc),
	})

	req := httptest.NewRequest(http.MethodPost, "/hooks/commands/some-token", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	// Reached the handler (unknown token → 404 JSON), not a 401 and not the SPA.
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 from the handler (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not_found") {
		t.Errorf("body = %s, want the handler's JSON error", rec.Body.String())
	}
}
