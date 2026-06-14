package handler

import (
	"context"
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

// --- draft.go: Upsert unauthorized -----------------------------------------

// TestDraftHandler_Upsert_Unauthenticated covers the userID == "" guard in
// DraftHandler.Upsert (no auth context → 401).
func TestDraftHandler_Upsert_Unauthenticated(t *testing.T) {
	h, _, _ := setupDraftHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/drafts", strings.NewReader(`{}`))
	h.Upsert(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}

// --- emoji.go: Delete unauthorized -----------------------------------------

// TestEmojiHandler_Delete_Unauthenticated covers the userID == "" guard in
// EmojiHandler.Delete.
func TestEmojiHandler_Delete_Unauthenticated(t *testing.T) {
	h := NewEmojiHandler(nil)
	rec := httptest.NewRecorder()
	h.Delete(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/emojis/fire", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}

// --- presence.go: List nil coercion ----------------------------------------

// nilPresenceStore returns a nil slice with no error from
// OnlinePresenceUserIDs so PresenceService.OnlineUserIDs returns nil and the
// handler's nil → [] coercion runs.
type nilPresenceStore struct{}

func (nilPresenceStore) IncrementPresence(context.Context, string) (bool, error) { return false, nil }
func (nilPresenceStore) DecrementPresence(context.Context, string) (bool, error) { return false, nil }
func (nilPresenceStore) RefreshPresence(context.Context, string) error           { return nil }
func (nilPresenceStore) IsPresenceOnline(context.Context, string) (bool, error)  { return false, nil }
func (nilPresenceStore) OnlinePresenceUserIDs(context.Context) ([]string, error) { return nil, nil }

// TestPresenceHandler_List_NilCoercedToEmpty covers the `if ids == nil`
// coercion in PresenceHandler.List.
func TestPresenceHandler_List_NilCoercedToEmpty(t *testing.T) {
	svc := service.NewPresenceService(nilPresenceStore{}, nil)
	h := NewPresenceHandler(svc)
	jwtMgr := auth.NewJWTManager("presence-nil-secret", 15*time.Minute, 720*time.Hour)
	u := &model.User{ID: "u-pr", SystemRole: model.SystemRoleMember}
	tok := makeTokenForUser(jwtMgr, u)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/presence", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"online":[]`) {
		t.Fatalf("nil online list should serialize as [], got %q", rec.Body.String())
	}
}
