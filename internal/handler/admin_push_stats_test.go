package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

func TestAdminHandler_PushStats_NotAdmin(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	user := &model.User{ID: "u", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.PushStats))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/push-stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestAdminHandler_PushStats_OK(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.PushStats))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/push-stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Push map[string]int64 `json:"push"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	// The wire contract: every pipeline counter is present (SPEC G-P4.1).
	for _, key := range []string{"scheduledImmediate", "scheduledDeferred", "delivered", "ackSuppressed", "undeliverable", "transientFailures"} {
		if _, ok := got.Push[key]; !ok {
			t.Errorf("push stats missing %q: %+v", key, got.Push)
		}
	}
}
