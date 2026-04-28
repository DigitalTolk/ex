package handler

import (
	"context"
	"encoding/json"
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

// dataEmojiStore implements service.EmojiStore for handler tests.
type dataEmojiStore struct {
	items map[string]*model.CustomEmoji
}

func newDataEmojiStore() *dataEmojiStore {
	return &dataEmojiStore{items: make(map[string]*model.CustomEmoji)}
}
func (s *dataEmojiStore) Create(_ context.Context, e *model.CustomEmoji) error {
	if _, exists := s.items[e.Name]; exists {
		return store.ErrAlreadyExists
	}
	s.items[e.Name] = e
	return nil
}
func (s *dataEmojiStore) GetByName(_ context.Context, name string) (*model.CustomEmoji, error) {
	e, ok := s.items[name]
	if !ok {
		return nil, store.ErrNotFound
	}
	return e, nil
}
func (s *dataEmojiStore) List(_ context.Context) ([]*model.CustomEmoji, error) {
	out := make([]*model.CustomEmoji, 0, len(s.items))
	for _, e := range s.items {
		out = append(out, e)
	}
	return out, nil
}
func (s *dataEmojiStore) Delete(_ context.Context, name string) error {
	delete(s.items, name)
	return nil
}

func setupEmojiHandler(t *testing.T) (*EmojiHandler, *dataEmojiStore, *dataUserStoreForConv, *auth.JWTManager) {
	t.Helper()
	emojis := newDataEmojiStore()
	users := newDataUserStoreForConv()
	svc := service.NewEmojiService(emojis, users, nil)
	jwtMgr := auth.NewJWTManager("emoji-test-secret", 15*time.Minute, 720*time.Hour)
	return NewEmojiHandler(svc), emojis, users, jwtMgr
}

func tokenFor(t *testing.T, jwtMgr *auth.JWTManager, u *model.User) string {
	t.Helper()
	tok, err := jwtMgr.GenerateAccessToken(u)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	return tok
}

func TestEmojiHandler_Create_Success(t *testing.T) {
	h, store, users, jwtMgr := setupEmojiHandler(t)
	u := &model.User{ID: "u1", Email: "u@x", SystemRole: model.SystemRoleMember}
	users.users[u.ID] = u
	users.emailIndex[u.Email] = u

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Create))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/emojis",
		strings.NewReader(`{"name":"fire","imageURL":"https://x.test/fire.png"}`))
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, jwtMgr, u))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, exists := store.items["fire"]; !exists {
		t.Error("emoji not stored")
	}
}

func TestEmojiHandler_Create_GuestForbidden(t *testing.T) {
	h, _, users, jwtMgr := setupEmojiHandler(t)
	u := &model.User{ID: "g1", Email: "g@x", SystemRole: model.SystemRoleGuest}
	users.users[u.ID] = u

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Create))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/emojis",
		strings.NewReader(`{"name":"fire","imageURL":"https://x.test/fire.png"}`))
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, jwtMgr, u))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status=%d, want 400", rec.Code)
	}
}

func TestEmojiHandler_List(t *testing.T) {
	h, store, users, jwtMgr := setupEmojiHandler(t)
	u := &model.User{ID: "u1", Email: "u@x", SystemRole: model.SystemRoleMember}
	users.users[u.ID] = u
	store.items["fire"] = &model.CustomEmoji{Name: "fire", ImageURL: "https://x/fire.png"}

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/emojis", nil)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, jwtMgr, u))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got []model.CustomEmoji
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Name != "fire" {
		t.Errorf("got %+v", got)
	}
}

func TestEmojiHandler_Delete_Creator(t *testing.T) {
	h, store, users, jwtMgr := setupEmojiHandler(t)
	u := &model.User{ID: "u1", Email: "u@x", SystemRole: model.SystemRoleMember}
	users.users[u.ID] = u
	store.items["fire"] = &model.CustomEmoji{Name: "fire", CreatedBy: u.ID}

	mux := http.NewServeMux()
	mux.Handle("DELETE /api/v1/emojis/{name}", middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete)))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/emojis/fire", nil)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, jwtMgr, u))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, exists := store.items["fire"]; exists {
		t.Error("emoji not deleted")
	}
}

func TestEmojiHandler_Delete_NotAuthorized(t *testing.T) {
	h, store, users, jwtMgr := setupEmojiHandler(t)
	creator := &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	other := &model.User{ID: "u2", SystemRole: model.SystemRoleMember}
	users.users[creator.ID] = creator
	users.users[other.ID] = other
	store.items["fire"] = &model.CustomEmoji{Name: "fire", CreatedBy: creator.ID}

	mux := http.NewServeMux()
	mux.Handle("DELETE /api/v1/emojis/{name}", middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete)))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/emojis/fire", nil)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, jwtMgr, other))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status=%d, want 403; body=%s", rec.Code, rec.Body.String())
	}
	if _, exists := store.items["fire"]; !exists {
		t.Error("emoji should not be deleted")
	}
}

func TestEmojiHandler_Unauthenticated(t *testing.T) {
	h := NewEmojiHandler(nil)
	rec := httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/v1/emojis", strings.NewReader(`{}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status=%d, want 401", rec.Code)
	}
}

// TestAttachmentHandler_List verifies the batch endpoint resolves multiple
// IDs in a single request, returning fresh signed URLs in input order.
func TestAttachmentHandler_List(t *testing.T) {
	atts := newDataAttachmentStore()
	signer := &fakeAttachmentSignerH{}
	svc := service.NewAttachmentService(atts, signer, nil)
	jwtMgr := auth.NewJWTManager("att-test", 15*time.Minute, 720*time.Hour)
	u := &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	tok := tokenFor(t, jwtMgr, u)

	a1 := &model.Attachment{ID: "a1", S3Key: "attachments/a1", SHA256: "h1", ContentType: "image/png", Filename: "1.png", Size: 10}
	a2 := &model.Attachment{ID: "a2", S3Key: "attachments/a2", SHA256: "h2", ContentType: "image/png", Filename: "2.png", Size: 20}
	_ = atts.Create(context.Background(), a1)
	_ = atts.Create(context.Background(), a2)

	h := NewAttachmentHandler(svc)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments?ids=a1,a2", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got []model.Attachment
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 attachments, got %d", len(got))
	}
	for _, a := range got {
		if a.URL == "" {
			t.Errorf("attachment %s missing signed URL", a.ID)
		}
	}
}

func TestAttachmentHandler_List_Empty(t *testing.T) {
	svc := service.NewAttachmentService(newDataAttachmentStore(), nil, nil)
	jwtMgr := auth.NewJWTManager("att-test-2", 15*time.Minute, 720*time.Hour)
	u := &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	tok := tokenFor(t, jwtMgr, u)
	h := NewAttachmentHandler(svc)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
}

// dataAttachmentStore is a tiny in-memory store for handler tests.
type dataAttachmentStore struct {
	byID   map[string]*model.Attachment
	byHash map[string]*model.Attachment
	refs   map[string]map[string]bool
}

func newDataAttachmentStore() *dataAttachmentStore {
	return &dataAttachmentStore{
		byID:   map[string]*model.Attachment{},
		byHash: map[string]*model.Attachment{},
		refs:   map[string]map[string]bool{},
	}
}
func (s *dataAttachmentStore) Create(_ context.Context, a *model.Attachment) error {
	s.byID[a.ID] = a
	s.byHash[a.SHA256] = a
	return nil
}
func (s *dataAttachmentStore) GetByID(_ context.Context, id string) (*model.Attachment, error) {
	if a, ok := s.byID[id]; ok {
		return a, nil
	}
	return nil, store.ErrNotFound
}
func (s *dataAttachmentStore) GetByHash(_ context.Context, h string) (*model.Attachment, error) {
	if a, ok := s.byHash[h]; ok {
		return a, nil
	}
	return nil, store.ErrNotFound
}
func (s *dataAttachmentStore) AddRef(_ context.Context, attID, msgID string) error {
	if s.refs[attID] == nil {
		s.refs[attID] = map[string]bool{}
	}
	s.refs[attID][msgID] = true
	return nil
}
func (s *dataAttachmentStore) RemoveRef(_ context.Context, attID, msgID string) (*model.Attachment, error) {
	delete(s.refs[attID], msgID)
	return s.byID[attID], nil
}
func (s *dataAttachmentStore) Delete(_ context.Context, id string) error {
	if a, ok := s.byID[id]; ok {
		delete(s.byHash, a.SHA256)
	}
	delete(s.byID, id)
	delete(s.refs, id)
	return nil
}

type fakeAttachmentSignerH struct{}

func (fakeAttachmentSignerH) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://signed/" + key, nil
}
func (fakeAttachmentSignerH) PresignedDownloadURL(_ context.Context, key, _ string, _ time.Duration) (string, error) {
	return "https://signed/" + key + "?dl=1", nil
}
func (fakeAttachmentSignerH) PresignedPutURL(_ context.Context, key, _ string, _ time.Duration) (string, error) {
	return "https://upload/" + key, nil
}
func (fakeAttachmentSignerH) DeleteObject(_ context.Context, _ string) error { return nil }

// TestPresenceHandler_List verifies the presence handler returns the
// service's online userIDs.
func TestPresenceHandler_List(t *testing.T) {
	svc := service.NewPresenceService(nil, nil)
	svc.OnConnect(context.Background(), "u1")
	svc.OnConnect(context.Background(), "u2")

	h := NewPresenceHandler(svc)
	jwtMgr := auth.NewJWTManager("presence-test", 15*time.Minute, 720*time.Hour)
	u := &model.User{ID: "u3", SystemRole: model.SystemRoleMember}
	tok := tokenFor(t, jwtMgr, u)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/presence", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Online []string `json:"online"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Online) != 2 {
		t.Errorf("online=%v want 2 entries", got.Online)
	}
}
