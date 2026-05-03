package handler

import (
	"context"
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
	"github.com/DigitalTolk/ex/internal/store"
)

type handlerDraftStore struct {
	rows      map[string]*model.MessageDraft
	deleteErr error
}

func newHandlerDraftStore() *handlerDraftStore {
	return &handlerDraftStore{rows: map[string]*model.MessageDraft{}}
}

func (s *handlerDraftStore) key(userID, id string) string { return userID + "#" + id }
func (s *handlerDraftStore) Upsert(_ context.Context, d *model.MessageDraft) error {
	cp := *d
	s.rows[s.key(d.UserID, d.ID)] = &cp
	return nil
}
func (s *handlerDraftStore) Get(_ context.Context, userID, id string) (*model.MessageDraft, error) {
	d, ok := s.rows[s.key(userID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *d
	return &cp, nil
}
func (s *handlerDraftStore) List(_ context.Context, userID string) ([]*model.MessageDraft, error) {
	out := []*model.MessageDraft{}
	for _, d := range s.rows {
		if d.UserID == userID {
			cp := *d
			out = append(out, &cp)
		}
	}
	return out, nil
}
func (s *handlerDraftStore) Delete(_ context.Context, userID, id string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.rows, s.key(userID, id))
	return nil
}

type handlerMembershipStore struct{}

func (handlerMembershipStore) AddMember(context.Context, *model.ChannelMembership, *model.UserChannel) error {
	return nil
}
func (handlerMembershipStore) RemoveMember(context.Context, string, string) error { return nil }
func (handlerMembershipStore) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if channelID == "ch-1" && userID == "u-1" {
		return &model.ChannelMembership{ChannelID: channelID, UserID: userID}, nil
	}
	return nil, store.ErrNotFound
}
func (handlerMembershipStore) UpdateMemberRole(context.Context, string, string, model.ChannelRole) error {
	return nil
}
func (handlerMembershipStore) ListMembers(context.Context, string) ([]*model.ChannelMembership, error) {
	return nil, nil
}
func (handlerMembershipStore) ListUserChannels(context.Context, string) ([]*model.UserChannel, error) {
	return nil, nil
}
func (handlerMembershipStore) SetMute(context.Context, string, string, bool) error     { return nil }
func (handlerMembershipStore) SetFavorite(context.Context, string, string, bool) error { return nil }
func (handlerMembershipStore) SetCategory(context.Context, string, string, string, *int) error {
	return nil
}

type handlerConversationStore struct{}

func (handlerConversationStore) CreateConversation(context.Context, *model.Conversation, []*model.UserConversation) error {
	return nil
}
func (handlerConversationStore) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if id == "dm-1" {
		return &model.Conversation{ID: id, ParticipantIDs: []string{"u-1", "u-2"}}, nil
	}
	return nil, store.ErrNotFound
}
func (handlerConversationStore) ListUserConversations(context.Context, string) ([]*model.UserConversation, error) {
	return nil, nil
}
func (handlerConversationStore) ActivateConversation(context.Context, string, []string) error {
	return nil
}
func (handlerConversationStore) TouchConversation(context.Context, string, []string, time.Time) error {
	return nil
}
func (handlerConversationStore) SetFavorite(context.Context, string, string, bool) error { return nil }
func (handlerConversationStore) SetCategory(context.Context, string, string, string, *int) error {
	return nil
}

type handlerMessageStore struct{}

func (handlerMessageStore) CreateMessage(context.Context, *model.Message) error { return nil }
func (handlerMessageStore) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	if parentID == "ch-1" && msgID == "root-1" {
		return &model.Message{ID: msgID, ParentID: parentID, Body: "root"}, nil
	}
	return nil, store.ErrNotFound
}
func (handlerMessageStore) UpdateMessage(context.Context, *model.Message) error { return nil }
func (handlerMessageStore) DeleteMessage(context.Context, string, string) error { return nil }
func (handlerMessageStore) ListMessages(context.Context, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}
func (handlerMessageStore) ListMessagesAfter(context.Context, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}
func (handlerMessageStore) ListMessagesAround(context.Context, string, string, int, int) ([]*model.Message, bool, bool, error) {
	return nil, false, false, nil
}
func (handlerMessageStore) IncrementReplyMetadata(context.Context, string, string, time.Time, string) (*model.Message, error) {
	return nil, nil
}

func setupDraftHandler(t *testing.T) (*DraftHandler, *handlerDraftStore, *auth.JWTManager) {
	t.Helper()
	drafts := newHandlerDraftStore()
	svc := service.NewDraftService(drafts, handlerMessageStore{}, handlerMembershipStore{}, handlerConversationStore{}, nil)
	return NewDraftHandler(svc), drafts, auth.NewJWTManager("draft-secret", 15*time.Minute, 24*time.Hour)
}

func TestDraftHandler_UpsertListDelete(t *testing.T) {
	h, _, jwtMgr := setupDraftHandler(t)
	token := makeTokenForUser(jwtMgr, &model.User{ID: "u-1", Email: "u1@example.com"})
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/drafts", middleware.Auth(jwtMgr)(http.HandlerFunc(h.List)))
	mux.Handle("PUT /api/v1/drafts", middleware.Auth(jwtMgr)(http.HandlerFunc(h.Upsert)))
	mux.Handle("DELETE /api/v1/drafts/{id}", middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete)))

	body := `{"parentID":"ch-1","parentType":"channel","parentMessageID":"root-1","body":"draft body"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/drafts", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upsert status = %d body=%s", rec.Code, rec.Body.String())
	}
	var draft model.MessageDraft
	if err := json.NewDecoder(rec.Body).Decode(&draft); err != nil {
		t.Fatalf("decode draft: %v", err)
	}
	if draft.Body != "draft body" || draft.ParentMessageID != "root-1" {
		t.Fatalf("draft = %+v", draft)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/drafts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "draft body") {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/drafts/"+draft.ID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDraftHandler_RejectsUnauthorizedParent(t *testing.T) {
	h, _, jwtMgr := setupDraftHandler(t)
	token := makeTokenForUser(jwtMgr, &model.User{ID: "u-3", Email: "u3@example.com"})

	req := httptest.NewRequest(http.MethodPut, "/api/v1/drafts", strings.NewReader(`{"parentID":"ch-1","parentType":"channel","body":"no"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.Upsert)).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}
}

func TestDraftHandler_ErrorBranches(t *testing.T) {
	h, drafts, jwtMgr := setupDraftHandler(t)
	token := makeTokenForUser(jwtMgr, &model.User{ID: "u-1", Email: "u1@example.com"})

	rec := httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/v1/drafts", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth list status = %d, want 401", rec.Code)
	}

	req := httptest.NewRequest(http.MethodPut, "/api/v1/drafts", strings.NewReader(`{bad`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.Upsert)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d, want 400", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/drafts", strings.NewReader(`{"parentID":"ch-1","parentType":"channel","parentMessageID":"missing","body":"x"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.Upsert)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing thread status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.Delete(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/drafts/draft-1", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth delete status = %d, want 401", rec.Code)
	}

	drafts.deleteErr = store.ErrNotFound
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/drafts/draft-missing", nil)
	req.SetPathValue("id", "draft-missing")
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing delete status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}

	drafts.deleteErr = errors.New("delete failed")
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/drafts/draft-error", nil)
	req.SetPathValue("id", "draft-error")
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("failed delete status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}
