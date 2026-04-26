package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
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
	router := NewRouter(authH, userH, channelH, convH, wsH, nil, nil, nil, nil, nil, jwtMgr, nil, "*")

	if router == nil {
		t.Fatal("expected non-nil router")
	}
}

// TestRouterHealthEndpoint verifies the health check endpoint works.
func TestRouterHealthEndpoint(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	router := NewRouter(&AuthHandler{}, &UserHandler{}, &ChannelHandler{}, &ConversationHandler{}, &WSHandler{}, nil, nil, nil, nil, nil, jwtMgr, nil, "*")

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
	router := NewRouter(&AuthHandler{}, &UserHandler{}, &ChannelHandler{}, &ConversationHandler{}, &WSHandler{}, nil, nil, nil, nil, nil, jwtMgr, nil, "*")

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
		{valid26, true},                          // standard ULID
		{valid26[:25], false},                     // 25 chars — too short
		{valid26 + "X", false},                    // 27 chars — too long
		{"01arz3ndektsv4rrffq69g5fav", true},      // lowercase OK
		{"general", false},
		{"my-cool-channel", false},
		{"01ARZ3NDEKTSV4RRFFQ69G5FA!", false},     // 26 chars but has special char
		{"", false},
	}
	for _, tt := range tests {
		if got := isULID(tt.input); got != tt.want {
			t.Errorf("isULID(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}
