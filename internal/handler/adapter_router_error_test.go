package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/service"
)

// --- oidc_adapter.go: Exchange success mapping -----------------------------

// fakeAuthProvider returns a successful OIDCUserInfo so oidcAdapter.Exchange's
// field-mapping branch runs — a real *auth.OIDCProvider needs a live IdP and a
// verified signed id_token to reach this.
type fakeAuthProvider struct {
	info *auth.OIDCUserInfo
	err  error
}

func (f fakeAuthProvider) AuthURL(string, string) string { return "https://idp/auth" }
func (f fakeAuthProvider) Exchange(context.Context, string, string) (*auth.OIDCUserInfo, error) {
	return f.info, f.err
}

// TestOIDCAdapter_Exchange_Success covers the success branch that maps an
// auth.OIDCUserInfo onto a service.OIDCUserInfo.
func TestOIDCAdapter_Exchange_Success(t *testing.T) {
	a := &oidcAdapter{p: fakeAuthProvider{info: &auth.OIDCUserInfo{
		Email: "u@example.com", Name: "U Ser", Picture: "https://img/u.png", ObjectID: "oid-1",
	}}}
	got, err := a.Exchange(context.Background(), "code", "nonce")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if got.Email != "u@example.com" || got.Name != "U Ser" || got.Picture != "https://img/u.png" || got.ObjectID != "oid-1" {
		t.Fatalf("mapped info = %+v", got)
	}
}

// --- router.go: AuthWithUserStatus wiring ----------------------------------

// TestNewRouter_UsesAuthWithUserStatusWhenUserSvcWired covers the conditional
// in NewRouter that upgrades the auth middleware to AuthWithUserStatus when the
// UserHandler carries a non-nil user service.
func TestNewRouter_UsesAuthWithUserStatusWhenUserSvcWired(t *testing.T) {
	jwtMgr := auth.NewJWTManager("router-userstatus-secret", 15*time.Minute, 24*time.Hour)
	userStore := newMockUserStore()
	userH := NewUserHandler(service.NewUserService(userStore, &mockCache{}, nil, nil), nil)

	router := NewRouter(&Deps{
		Auth:         &AuthHandler{},
		User:         userH,
		Channel:      &ChannelHandler{},
		Conversation: &ConversationHandler{},
		WS:           &WSHandler{},
		JWT:          jwtMgr,
		AppVersion:   "test",
		AllowOrigins: []string{"*"},
	})
	if router == nil {
		t.Fatal("expected non-nil router")
	}

	// Hit a protected route without a token: AuthWithUserStatus must reject it
	// with 401, proving the upgraded middleware is wired in.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}
