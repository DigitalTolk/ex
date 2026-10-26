package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// Regression: requireAdmin trusted the access token's role claim, so an admin
// demoted a minute ago kept every admin power for the rest of the token's
// 15-minute life. The stored role decides.
func TestRouterAdminRoutesUseTheStoredRole(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	users := newMockUserStore()
	users.users["u-1"] = &model.User{ID: "u-1", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users["u-2"] = &model.User{ID: "u-2", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: NewUserHandler(service.NewUserService(users, nil, nil, nil), nil),
		Channel: &ChannelHandler{}, Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"},
	})
	// The token still claims admin — minted before the demotion.
	tok, err := jwtMgr.GenerateAccessToken(&model.User{ID: "u-1", SystemRole: model.SystemRoleAdmin})
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u-2/role", strings.NewReader(`{"role":"admin"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("demoted admin's PATCH role = %d, want 403", rec.Code)
	}
	if users.users["u-2"].SystemRole != model.SystemRoleMember {
		t.Fatalf("target was promoted to %q by a demoted admin", users.users["u-2"].SystemRole)
	}

	// And the other direction: a member promoted since the token was minted
	// gets admin rights now.
	users.users["u-1"].SystemRole = model.SystemRoleAdmin
	memberTok, _ := jwtMgr.GenerateAccessToken(&model.User{ID: "u-1", SystemRole: model.SystemRoleMember})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/users/u-2/role", strings.NewReader(`{"role":"guest"}`))
	req.Header.Set("Authorization", "Bearer "+memberTok)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("promoted member's PATCH role = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
}
