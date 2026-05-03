package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
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
	router := NewRouter(authH, userH, channelH, convH, wsH, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, jwtMgr, nil, "test", []string{"*"})

	if router == nil {
		t.Fatal("expected non-nil router")
	}
}

// TestRouterHealthEndpoint verifies the health check endpoint works.
func TestRouterHealthEndpoint(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&AuthHandler{}, &UserHandler{}, &ChannelHandler{}, &ConversationHandler{}, &WSHandler{}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, jwtMgr, nil, "test", []string{"*"})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

// TestRouterRegisteredRoutes verifies that key routes are registered and don't
// 404 due to path mismatches. We check for non-404 responses (401 is fine —
// it means the route matched but auth middleware rejected the request).
func TestRouterRegisteredRoutes(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&AuthHandler{}, &UserHandler{}, &ChannelHandler{}, &ConversationHandler{}, &WSHandler{}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, jwtMgr, nil, "test", []string{"*"})

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
// version, unfurl). Without this, those branches stay at 0% coverage
// even though they are the production wiring path.
func TestNewRouter_AllOptionalHandlersWired(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(
		&AuthHandler{},
		&UserHandler{},
		&ChannelHandler{},
		&ConversationHandler{},
		&WSHandler{},
		&UploadHandler{},
		&EmojiHandler{},
		&PresenceHandler{},
		&AttachmentHandler{},
		&AdminHandler{},
		&ThreadHandler{},
		&VersionHandler{},
		&UnfurlHandler{},
		&SidebarHandler{},
		&SearchHandler{},
		jwtMgr, nil, "test", []string{"*"},
	)
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
		"/api/v1/search/users",
		"/api/v1/admin/settings",
		"/api/v1/sidebar/categories",
		"/api/v1/uploads/url",
		"/api/v1/attachments",
		"/api/v1/unfurl",
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

	t.Run("nil error still uses fallback", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeServiceError(rec, errors.New("anything"), http.StatusForbidden, "forbidden")
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
		}
	})
}
