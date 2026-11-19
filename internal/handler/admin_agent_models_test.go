package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

func putAgentModels(t *testing.T, h *AdminHandler, jwtMgr *auth.JWTManager, role model.SystemRole, body string) *httptest.ResponseRecorder {
	t.Helper()
	user := &model.User{ID: "u-" + string(role), Email: string(role) + "@x.com", SystemRole: role}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/agent-models", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+makeTokenForUser(jwtMgr, user))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetAgentModels)).ServeHTTP(rec, req)
	return rec
}

const twoAgentModels = `{"models":[{"harness":"claude","id":"claude-sonnet-5-5","label":"Sonnet"},{"harness":"bedrock","id":"eu.anthropic.claude-opus-5"}]}`

func TestAdminHandler_SetAgentModels(t *testing.T) {
	store := &fakeSettingsStore{current: &model.WorkspaceSettings{MaxUploadBytes: 99}}
	h := NewAdminHandler(service.NewSettingsService(store))
	jwtMgr := auth.NewJWTManager("agent-models-secret", 15*time.Minute, 720*time.Hour)

	rec := putAgentModels(t, h, jwtMgr, model.SystemRoleAdmin, twoAgentModels)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body %s", rec.Code, rec.Body.String())
	}
	var got settingsResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The whole settings come back, with the list as saved.
	if len(got.AgentModels) != 2 || got.AgentModels[0].Label != "Sonnet" || got.MaxUploadBytes != 99 {
		t.Fatalf("response = %+v", got)
	}
	if len(store.current.AgentModels) != 2 {
		t.Fatalf("stored = %+v", store.current)
	}
}

func TestAdminHandler_SetAgentModelsRefusals(t *testing.T) {
	jwtMgr := auth.NewJWTManager("agent-models-secret", 15*time.Minute, 720*time.Hour)
	for _, tc := range []struct {
		name  string
		store *fakeSettingsStore
		role  model.SystemRole
		body  string
		want  int
	}{
		{"a member", &fakeSettingsStore{}, model.SystemRoleMember, twoAgentModels, http.StatusForbidden},
		{"a body that is not JSON", &fakeSettingsStore{}, model.SystemRoleAdmin, `{`, http.StatusBadRequest},
		{"a model outside the EU for Bedrock", &fakeSettingsStore{}, model.SystemRoleAdmin,
			`{"models":[{"harness":"claude","id":"claude-opus-5"},{"harness":"bedrock","id":"us.anthropic.claude-opus-5"}]}`, http.StatusBadRequest},
		{"a store that fails", &fakeSettingsStore{putErr: errors.New("boom")}, model.SystemRoleAdmin, twoAgentModels, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewAdminHandler(service.NewSettingsService(tc.store))
			rec := putAgentModels(t, h, jwtMgr, tc.role, tc.body)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d; body %s", rec.Code, tc.want, rec.Body.String())
			}
			if tc.store.current != nil {
				t.Fatalf("a refused save stored %+v", tc.store.current)
			}
		})
	}
}

// Everyone signed in reads the list with the other settings: the agent forms
// build their dropdowns from it.
func TestAdminHandler_GetSettingsCarriesAgentModels(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	member := &model.User{ID: "u-member", Email: "m@x.com", SystemRole: model.SystemRoleMember}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	req.Header.Set("Authorization", "Bearer "+makeTokenForUser(jwtMgr, member))
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetSettings)).ServeHTTP(rec, req)
	var got settingsResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.AgentModels) != len(model.DefaultAgentModels) {
		t.Fatalf("agentModels = %+v, want the built-in list", got.AgentModels)
	}
}
