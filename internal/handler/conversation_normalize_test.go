package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

// TestCreateConversation_GroupWithOneOtherCollapsesToDM verifies T16: the
// server normalizes "create a group with one other person" into a DM so the
// frontend doesn't need to special-case the count.
func TestCreateConversation_GroupWithOneOtherCollapsesToDM(t *testing.T) {
	env := setupConversationHandlerFull(t)
	caller := &model.User{ID: "u1", Email: "a@x", DisplayName: "A", SystemRole: model.SystemRoleMember}
	other := &model.User{ID: "u2", Email: "b@x", DisplayName: "B", SystemRole: model.SystemRoleMember}
	env.users.users[caller.ID] = caller
	env.users.users[other.ID] = other

	body := `{"type":"group","participantIDs":["u2"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: caller.ID}))
	rec := httptest.NewRecorder()
	env.handler.Create(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got model.Conversation
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Type != model.ConversationTypeDM {
		t.Errorf("expected DM, got %q", got.Type)
	}
}

// TestCreateConversation_GroupWithSelfStripsSelf verifies that adding self to
// a group is silently stripped — the creator is implicitly a participant.
func TestCreateConversation_GroupWithSelfStripsSelf(t *testing.T) {
	env := setupConversationHandlerFull(t)
	caller := &model.User{ID: "u1", DisplayName: "A", SystemRole: model.SystemRoleMember}
	a := &model.User{ID: "u2", DisplayName: "B", SystemRole: model.SystemRoleMember}
	b := &model.User{ID: "u3", DisplayName: "C", SystemRole: model.SystemRoleMember}
	env.users.users[caller.ID] = caller
	env.users.users[a.ID] = a
	env.users.users[b.ID] = b

	// Caller passes themselves + 2 others.
	body := `{"type":"group","participantIDs":["u1","u2","u3"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: caller.ID}))
	rec := httptest.NewRecorder()
	env.handler.Create(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got model.Conversation
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if got.Type != model.ConversationTypeGroup {
		t.Errorf("expected group, got %q", got.Type)
	}
	// Should have exactly 3 participants (creator + 2 others), no duplicates.
	if len(got.ParticipantIDs) != 3 {
		t.Errorf("expected 3 participants, got %d (%v)", len(got.ParticipantIDs), got.ParticipantIDs)
	}
}

// TestCreateConversation_DMWithSelfOnlyAllowed verifies that creating a DM
// with only self produces a self-DM (personal notepad).
func TestCreateConversation_DMWithSelfOnlyAllowed(t *testing.T) {
	env := setupConversationHandlerFull(t)
	caller := &model.User{ID: "u1", DisplayName: "A", SystemRole: model.SystemRoleMember}
	env.users.users[caller.ID] = caller

	body := `{"type":"dm","participantIDs":["u1"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: caller.ID}))
	rec := httptest.NewRecorder()
	env.handler.Create(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got model.Conversation
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if got.Type != model.ConversationTypeDM {
		t.Errorf("expected DM, got %q", got.Type)
	}
	if len(got.ParticipantIDs) != 1 || got.ParticipantIDs[0] != "u1" {
		t.Errorf("expected self-DM with [u1], got %v", got.ParticipantIDs)
	}
}
