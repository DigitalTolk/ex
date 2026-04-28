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

// --- Settings store + handler tests ---

type fakeSettingsStore struct {
	current *model.WorkspaceSettings
	getErr  error
	putErr  error
}

func (f *fakeSettingsStore) GetSettings(_ context.Context) (*model.WorkspaceSettings, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.current, nil
}

func (f *fakeSettingsStore) PutSettings(_ context.Context, ws *model.WorkspaceSettings) error {
	if f.putErr != nil {
		return f.putErr
	}
	f.current = ws
	return nil
}

func setupAdminHandler(t *testing.T) (*AdminHandler, *auth.JWTManager) {
	t.Helper()
	settingsSvc := service.NewSettingsService(&fakeSettingsStore{})
	jwtMgr := auth.NewJWTManager("admin-handler-secret", 15*time.Minute, 720*time.Hour)
	return NewAdminHandler(settingsSvc), jwtMgr
}

func TestAdminHandler_GetSettings_OK(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	user := &model.User{ID: "u-admin-get", Email: "ag@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetSettings))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got model.WorkspaceSettings
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.MaxUploadBytes != model.DefaultMaxUploadBytes {
		t.Errorf("MaxUploadBytes = %d, want default %d", got.MaxUploadBytes, model.DefaultMaxUploadBytes)
	}
	if len(got.AllowedExtensions) == 0 {
		t.Error("expected default extensions")
	}
}

func TestAdminHandler_GetSettings_Unauthenticated(t *testing.T) {
	h, _ := setupAdminHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	rec := httptest.NewRecorder()
	h.GetSettings(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAdminHandler_UpdateSettings_NotAdmin(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	user := &model.User{ID: "u-non-admin", Email: "n@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateSettings))

	body := `{"maxUploadBytes":1024,"allowedExtensions":["png"]}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestAdminHandler_UpdateSettings_OK(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", Email: "adm@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateSettings))

	body := `{"maxUploadBytes":2048,"allowedExtensions":["png","jpg"]}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got model.WorkspaceSettings
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.MaxUploadBytes != 2048 {
		t.Errorf("MaxUploadBytes = %d, want 2048", got.MaxUploadBytes)
	}
}

func TestAdminHandler_UpdateSettings_InvalidJSON(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm2", Email: "adm2@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateSettings))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings", strings.NewReader("{bad"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestAdminHandler_UpdateSettings_StoreError(t *testing.T) {
	store := &fakeSettingsStore{putErr: errors.New("boom")}
	settingsSvc := service.NewSettingsService(store)
	jwtMgr := auth.NewJWTManager("admin-err-secret", 15*time.Minute, 720*time.Hour)
	h := NewAdminHandler(settingsSvc)

	admin := &model.User{ID: "u-adm3", Email: "adm3@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateSettings))

	body := `{"maxUploadBytes":2048}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// --- Attachment handler tests ---

type fakeAttachmentStore struct {
	byID   map[string]*model.Attachment
	byHash map[string]*model.Attachment
}

func newFakeAttachmentStore() *fakeAttachmentStore {
	return &fakeAttachmentStore{
		byID:   make(map[string]*model.Attachment),
		byHash: make(map[string]*model.Attachment),
	}
}

func (s *fakeAttachmentStore) Create(_ context.Context, a *model.Attachment) error {
	s.byID[a.ID] = a
	s.byHash[a.SHA256] = a
	return nil
}
func (s *fakeAttachmentStore) GetByID(_ context.Context, id string) (*model.Attachment, error) {
	a, ok := s.byID[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return a, nil
}
func (s *fakeAttachmentStore) GetByHash(_ context.Context, sha256 string) (*model.Attachment, error) {
	a, ok := s.byHash[sha256]
	if !ok {
		return nil, store.ErrNotFound
	}
	return a, nil
}
func (s *fakeAttachmentStore) AddRef(_ context.Context, attachmentID, messageID string) error {
	a, ok := s.byID[attachmentID]
	if !ok {
		return store.ErrNotFound
	}
	a.MessageIDs = append(a.MessageIDs, messageID)
	return nil
}
func (s *fakeAttachmentStore) RemoveRef(_ context.Context, attachmentID, messageID string) (*model.Attachment, error) {
	a, ok := s.byID[attachmentID]
	if !ok {
		return nil, store.ErrNotFound
	}
	out := a.MessageIDs[:0]
	for _, id := range a.MessageIDs {
		if id != messageID {
			out = append(out, id)
		}
	}
	a.MessageIDs = out
	return a, nil
}
func (s *fakeAttachmentStore) Delete(_ context.Context, id string) error {
	if a, ok := s.byID[id]; ok {
		delete(s.byHash, a.SHA256)
	}
	delete(s.byID, id)
	return nil
}

type fakeSigner struct{}

func (f *fakeSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://signed.test/get/" + key, nil
}
func (f *fakeSigner) PresignedDownloadURL(_ context.Context, key, filename string, _ time.Duration) (string, error) {
	return "https://signed.test/get/" + key + "?dl=" + filename, nil
}
func (f *fakeSigner) PresignedPutURL(_ context.Context, key, _ string, _ time.Duration) (string, error) {
	return "https://signed.test/put/" + key, nil
}
func (f *fakeSigner) DeleteObject(_ context.Context, _ string) error { return nil }

func setupAttachmentHandler(t *testing.T) (*AttachmentHandler, *fakeAttachmentStore, *auth.JWTManager) {
	t.Helper()
	st := newFakeAttachmentStore()
	signer := &fakeSigner{}
	svc := service.NewAttachmentService(st, signer, nil)
	jwtMgr := auth.NewJWTManager("att-handler-secret", 15*time.Minute, 720*time.Hour)
	return NewAttachmentHandler(svc), st, jwtMgr
}

func TestAttachmentHandler_CreateUploadURL_Unauthenticated(t *testing.T) {
	h, _, _ := setupAttachmentHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/url", strings.NewReader(`{"filename":"f.png","contentType":"image/png","size":10,"sha256":"abc"}`))
	rec := httptest.NewRecorder()
	h.CreateUploadURL(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAttachmentHandler_CreateUploadURL_OK(t *testing.T) {
	h, _, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att", Email: "att@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))

	body := `{"filename":"foo.png","contentType":"image/png","size":1024,"sha256":"hash-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/url", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["uploadURL"] == "" {
		t.Error("expected uploadURL")
	}
	if got["alreadyExists"].(bool) {
		t.Error("expected alreadyExists=false on new upload")
	}
}

func TestAttachmentHandler_CreateUploadURL_DedupExisting(t *testing.T) {
	h, st, jwtMgr := setupAttachmentHandler(t)
	st.byID["a-existing"] = &model.Attachment{
		ID: "a-existing", SHA256: "dup-hash", Filename: "old.png",
		ContentType: "image/png", Size: 200,
	}
	st.byHash["dup-hash"] = st.byID["a-existing"]

	user := &model.User{ID: "u-att-dup", Email: "dup@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))

	body := `{"filename":"new.png","contentType":"image/png","size":200,"sha256":"dup-hash"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/url", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if !got["alreadyExists"].(bool) {
		t.Error("expected alreadyExists=true on dedupe match")
	}
}

func TestAttachmentHandler_CreateUploadURL_InvalidJSON(t *testing.T) {
	h, _, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att-bj", Email: "bj@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/url", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestAttachmentHandler_CreateUploadURL_ServiceError(t *testing.T) {
	h, _, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att-err", Email: "err@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))

	// Missing required fields trigger a service error.
	body := `{"filename":"","contentType":"","size":0,"sha256":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/url", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestAttachmentHandler_Get_Unauthenticated(t *testing.T) {
	h, _, _ := setupAttachmentHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/abc", nil)
	req.SetPathValue("id", "abc")
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAttachmentHandler_Get_MissingID(t *testing.T) {
	h, _, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att-mi", Email: "mi@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Get))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestAttachmentHandler_Get_OK(t *testing.T) {
	h, st, jwtMgr := setupAttachmentHandler(t)
	st.byID["a-get"] = &model.Attachment{
		ID: "a-get", Filename: "g.png", ContentType: "image/png", S3Key: "attachments/a-get",
	}
	user := &model.User{ID: "u-att-g", Email: "g@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Get))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/a-get", nil)
	req.SetPathValue("id", "a-get")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got model.Attachment
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != "a-get" {
		t.Errorf("ID = %q, want a-get", got.ID)
	}
	if got.URL == "" {
		t.Error("expected freshly-signed URL")
	}
}

func TestAttachmentHandler_Get_NotFound(t *testing.T) {
	h, _, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att-nf", Email: "nf@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Get))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/missing", nil)
	req.SetPathValue("id", "missing")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestAttachmentHandler_Delete_Unauthenticated(t *testing.T) {
	h, _, _ := setupAttachmentHandler(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/attachments/abc", nil)
	req.SetPathValue("id", "abc")
	rec := httptest.NewRecorder()
	h.Delete(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAttachmentHandler_Delete_MissingID(t *testing.T) {
	h, _, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att-dm", Email: "dm@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/attachments/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestAttachmentHandler_Delete_OK(t *testing.T) {
	h, st, jwtMgr := setupAttachmentHandler(t)
	st.byID["a-del"] = &model.Attachment{
		ID: "a-del", Filename: "del.png", ContentType: "image/png",
		CreatedBy: "u-att-d", S3Key: "attachments/a-del",
	}
	user := &model.User{ID: "u-att-d", Email: "d@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/attachments/a-del", nil)
	req.SetPathValue("id", "a-del")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if _, ok := st.byID["a-del"]; ok {
		t.Error("attachment should be deleted")
	}
}

func TestAttachmentHandler_Delete_Forbidden_NotOwner(t *testing.T) {
	h, st, jwtMgr := setupAttachmentHandler(t)
	st.byID["a-other"] = &model.Attachment{
		ID: "a-other", Filename: "x.png", ContentType: "image/png", CreatedBy: "someone-else",
	}
	user := &model.User{ID: "u-not-owner", Email: "no@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Delete))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/attachments/a-other", nil)
	req.SetPathValue("id", "a-other")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// --- Channel SetMute / SetPinned / ListPinned tests ---

func TestChannelHandler_SetMute_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels//mute", strings.NewReader(`{"muted":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetMute(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetMute_InvalidJSON(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/c1/mute", strings.NewReader("{bad"))
	req.SetPathValue("id", "c1")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetMute(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetMute_OK(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-mute#u-mute"] = &model.ChannelMembership{
		ChannelID: "ch-mute", UserID: "u-mute", Role: model.ChannelRoleMember,
	}
	user := &model.User{ID: "u-mute", Email: "mute@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetMute))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/ch-mute/mute", strings.NewReader(`{"muted":true}`))
	req.SetPathValue("id", "ch-mute")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandler_SetMute_NotMember(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetMute))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/c-x/mute", strings.NewReader(`{"muted":true}`))
	req.SetPathValue("id", "c-x")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetPinned_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels//messages//pin", strings.NewReader(`{"pinned":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetPinned(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetPinned_InvalidJSON(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/c/messages/m/pin", strings.NewReader("{"))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetPinned(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetPinned_OK(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-pin#u-pin"] = &model.ChannelMembership{
		ChannelID: "ch-pin", UserID: "u-pin", Role: model.ChannelRoleMember,
	}
	env.messages.messages["ch-pin#m-pin"] = &model.Message{
		ID: "m-pin", ParentID: "ch-pin", AuthorID: "u-pin", Body: "pin me",
	}
	user := &model.User{ID: "u-pin", Email: "pin@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetPinned))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/ch-pin/messages/m-pin/pin", strings.NewReader(`{"pinned":true}`))
	req.SetPathValue("id", "ch-pin")
	req.SetPathValue("msgId", "m-pin")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !env.messages.messages["ch-pin#m-pin"].Pinned {
		t.Error("message should be pinned")
	}
}

func TestChannelHandler_SetPinned_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetPinned))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/c/messages/m/pin", strings.NewReader(`{"pinned":true}`))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_ListPinned_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels//pinned", nil)
	rec := httptest.NewRecorder()
	h.ListPinned(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_ListPinned_OK(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-lp#u-lp"] = &model.ChannelMembership{
		ChannelID: "ch-lp", UserID: "u-lp", Role: model.ChannelRoleMember,
	}
	env.messages.messages["ch-lp#m1"] = &model.Message{
		ID: "m1", ParentID: "ch-lp", AuthorID: "u-lp", Body: "p1", Pinned: true,
	}
	env.messages.messages["ch-lp#m2"] = &model.Message{
		ID: "m2", ParentID: "ch-lp", AuthorID: "u-lp", Body: "u",
	}
	user := &model.User{ID: "u-lp", Email: "lp@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListPinned))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch-lp/pinned", nil)
	req.SetPathValue("id", "ch-lp")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got []*model.Message
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].ID != "m1" {
		t.Errorf("expected single pinned m1, got %+v", got)
	}
}

func TestChannelHandler_ListPinned_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListPinned))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/c/pinned", nil)
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// --- Conversation SetPinned / ListPinned tests ---

func TestConversationHandler_SetPinned_MissingIDs(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations//messages//pin", strings.NewReader(`{"pinned":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetPinned(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_SetPinned_InvalidJSON(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/c/messages/m/pin", strings.NewReader("{"))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetPinned(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_SetPinned_OK(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["conv-pin"] = &model.Conversation{
		ID: "conv-pin", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-cp", "u-other"},
	}
	env.messages.messages["conv-pin#m-cp"] = &model.Message{
		ID: "m-cp", ParentID: "conv-pin", AuthorID: "u-cp", Body: "pin me",
	}
	user := &model.User{ID: "u-cp", Email: "cp@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetPinned))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/conv-pin/messages/m-cp/pin", strings.NewReader(`{"pinned":true}`))
	req.SetPathValue("id", "conv-pin")
	req.SetPathValue("msgId", "m-cp")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !env.messages.messages["conv-pin#m-cp"].Pinned {
		t.Error("message should be pinned")
	}
}

func TestConversationHandler_SetPinned_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetPinned))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/c/messages/m/pin", strings.NewReader(`{"pinned":true}`))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestConversationHandler_ListPinned_MissingID(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations//pinned", nil)
	rec := httptest.NewRecorder()
	h.ListPinned(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_ListPinned_OK(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["conv-lp"] = &model.Conversation{
		ID: "conv-lp", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-clp", "u-other"},
	}
	env.messages.messages["conv-lp#cm1"] = &model.Message{
		ID: "cm1", ParentID: "conv-lp", AuthorID: "u-clp", Body: "x", Pinned: true,
	}
	user := &model.User{ID: "u-clp", Email: "clp@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListPinned))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/conv-lp/pinned", nil)
	req.SetPathValue("id", "conv-lp")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestConversationHandler_ListPinned_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListPinned))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/c/pinned", nil)
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// --- Thread handler tests ---

func setupThreadHandler(t *testing.T) (*ThreadHandler, *channelHandlerEnv, *auth.JWTManager) {
	t.Helper()
	env := setupChannelHandlerFull(t)
	// Reuse the channel-test message service so threads have data to walk.
	cache := &mockCache{}
	broker := &mockBrokerForHandler{}
	convs := newDataConversationStore()
	messageSvc := service.NewMessageService(env.messages, env.memberships, convs, nil, broker)
	_ = cache
	return NewThreadHandler(messageSvc), env, env.jwtMgr
}

func TestThreadHandler_List_Unauthenticated(t *testing.T) {
	h, _, _ := setupThreadHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/threads", nil)
	rec := httptest.NewRecorder()
	h.List(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// dataMembershipStoreWithUserChans extends dataMembershipStore so ListUserChannels returns real data.
type dataMembershipStoreWithUserChans struct {
	*dataMembershipStore
	userChans map[string][]*model.UserChannel
}

func (s *dataMembershipStoreWithUserChans) ListUserChannels(_ context.Context, userID string) ([]*model.UserChannel, error) {
	return s.userChans[userID], nil
}

func TestThreadHandler_List_OK(t *testing.T) {
	memberships := newDataMembershipStore()
	wrapper := &dataMembershipStoreWithUserChans{
		dataMembershipStore: memberships,
		userChans: map[string][]*model.UserChannel{
			"u-thread": {{UserID: "u-thread", ChannelID: "ch-thread", ChannelName: "thread-chan"}},
		},
	}
	messages := newDataMessageStore()
	messages.messages["ch-thread#root"] = &model.Message{
		ID: "root", ParentID: "ch-thread", AuthorID: "u-thread", Body: "root msg",
		ReplyCount: 1, CreatedAt: time.Now(),
	}
	messages.messages["ch-thread#reply"] = &model.Message{
		ID: "reply", ParentID: "ch-thread", AuthorID: "u-thread", Body: "reply",
		ParentMessageID: "root", CreatedAt: time.Now(),
	}

	broker := &mockBrokerForHandler{}
	convs := newDataConversationStore()
	messageSvc := service.NewMessageService(messages, wrapper, convs, nil, broker)
	jwtMgr := auth.NewJWTManager("thread-secret", 15*time.Minute, 720*time.Hour)
	h := NewThreadHandler(messageSvc)

	user := &model.User{ID: "u-thread", Email: "th@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/threads", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got []*service.ThreadSummary
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) == 0 {
		t.Error("expected at least one thread summary")
	}
}

// erroringMembershipStore returns an error from ListUserChannels.
type erroringMembershipStore struct {
	*dataMembershipStore
}

func (s *erroringMembershipStore) ListUserChannels(_ context.Context, _ string) ([]*model.UserChannel, error) {
	return nil, errors.New("boom")
}

func TestThreadHandler_List_StoreError(t *testing.T) {
	memberships := &erroringMembershipStore{dataMembershipStore: newDataMembershipStore()}
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	convs := newDataConversationStore()
	messageSvc := service.NewMessageService(messages, memberships, convs, nil, broker)
	jwtMgr := auth.NewJWTManager("thread-err-secret", 15*time.Minute, 720*time.Hour)
	h := NewThreadHandler(messageSvc)

	user := &model.User{ID: "u-err", Email: "e@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/threads", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestThreadHandler_List_EmptyForUserWithoutChannels(t *testing.T) {
	// Empty membership store -> nothing returned.
	memberships := newDataMembershipStore()
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	convs := newDataConversationStore()
	messageSvc := service.NewMessageService(messages, memberships, convs, nil, broker)
	jwtMgr := auth.NewJWTManager("thread-empty-secret", 15*time.Minute, 720*time.Hour)
	h := NewThreadHandler(messageSvc)

	user := &model.User{ID: "u-empty", Email: "e@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/threads", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	// Should be an empty array, not null.
	var got []*service.ThreadSummary
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 threads, got %d", len(got))
	}
}

// --- Edit message AttachmentIDs path coverage ---

func TestChannelHandler_EditMessage_AttachmentIDs(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-edit-att#u-edit-att"] = &model.ChannelMembership{
		ChannelID: "ch-edit-att", UserID: "u-edit-att", Role: model.ChannelRoleMember,
	}
	env.messages.messages["ch-edit-att#m1"] = &model.Message{
		ID: "m1", ParentID: "ch-edit-att", AuthorID: "u-edit-att", Body: "old",
	}

	user := &model.User{ID: "u-edit-att", Email: "ea@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	body := `{"body":"new body","attachmentIDs":[]}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-edit-att/messages/m1", strings.NewReader(body))
	req.SetPathValue("id", "ch-edit-att")
	req.SetPathValue("msgId", "m1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestConversationHandler_EditMessage_AttachmentIDs(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["conv-eatt"] = &model.Conversation{
		ID: "conv-eatt", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-eatt", "u-other"},
	}
	env.messages.messages["conv-eatt#cm1"] = &model.Message{
		ID: "cm1", ParentID: "conv-eatt", AuthorID: "u-eatt", Body: "old",
	}

	user := &model.User{ID: "u-eatt", Email: "ea@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	body := `{"body":"new body","attachmentIDs":[]}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/conv-eatt/messages/cm1", strings.NewReader(body))
	req.SetPathValue("id", "conv-eatt")
	req.SetPathValue("msgId", "cm1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
}

// --- Conversation Create coverage paths ---

func TestConvHandlerFull_CreateDM_SelfOnly(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-self"] = &model.User{ID: "u-self", Email: "self@x.com", DisplayName: "Self"}

	user := &model.User{ID: "u-self", Email: "self@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"dm","participantIDs":["u-self"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateGroup_SingleOther(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-g-self"] = &model.User{ID: "u-g-self", Email: "gself@x.com", DisplayName: "Self"}
	env.users.users["u-g-other"] = &model.User{ID: "u-g-other", Email: "gother@x.com", DisplayName: "Other"}

	user := &model.User{ID: "u-g-self", Email: "gself@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"group","participantIDs":["u-g-other"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateGroup_SelfOnly(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-gso"] = &model.User{ID: "u-gso", Email: "gso@x.com", DisplayName: "Self"}

	user := &model.User{ID: "u-gso", Email: "gso@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"group","participantIDs":["u-gso"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d (body: %s)", rec.Code, rec.Body.String())
	}
}

// --- Forbidden / error path coverage for conv handlers ---

func TestConversationHandler_ListMessages_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListMessages))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/c/messages", nil)
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestConversationHandler_SendMessage_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))
	body := `{"body":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/c/messages", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestConversationHandler_EditMessage_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))
	body := `{"body":"new"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/c/messages/m", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestConversationHandler_ToggleReaction_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ToggleReaction))
	body := `{"emoji":"👍"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/c/messages/m/reactions", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_SendMessage_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))
	body := `{"body":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/c/messages", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_EditMessage_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))
	body := `{"body":"new"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/c/messages/m", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_ToggleReaction_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ToggleReaction))
	body := `{"emoji":"👍"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/c/messages/m/reactions", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_AddMember_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.AddMember))
	body := `{"userID":"u-other","role":"member"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/c/members", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_UpdateMemberRole_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.UpdateMemberRole))
	body := `{"role":"admin"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/c/members/u", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.SetPathValue("uid", "u")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_Update_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Update))
	body := `{"name":"new"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/c", strings.NewReader(body))
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// --- User SetUserStatus tests ---

func TestUserHandler_SetUserStatus_NotAdmin(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	user := &model.User{ID: "u-non-adm", Email: "n@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u-target/status", strings.NewReader(`{"deactivated":true}`))
	req.SetPathValue("id", "u-target")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestUserHandler_SetUserStatus_MissingID(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	admin := &model.User{ID: "u-adm-mi", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users//status", strings.NewReader(`{"deactivated":true}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUserHandler_SetUserStatus_InvalidJSON(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	admin := &model.User{ID: "u-adm-bj", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u-t/status", strings.NewReader("{"))
	req.SetPathValue("id", "u-t")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUserHandler_SetUserStatus_NotFound(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	admin := &model.User{ID: "u-adm-nf", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/missing/status", strings.NewReader(`{"deactivated":true}`))
	req.SetPathValue("id", "missing")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestUserHandler_SetUserStatus_OK(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID: "u-guest", Email: "guest@x.com", DisplayName: "Guest",
		SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, Status: "active",
	}
	userStore.users[target.ID] = target
	userStore.emailIndex[target.Email] = target

	admin := &model.User{ID: "u-adm-ok", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u-guest/status", strings.NewReader(`{"deactivated":true}`))
	req.SetPathValue("id", "u-guest")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if userStore.users["u-guest"].Status != "deactivated" {
		t.Errorf("Status = %q, want deactivated", userStore.users["u-guest"].Status)
	}
}

func TestUserHandler_SetUserStatus_NonGuest(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID: "u-member", Email: "m@x.com", DisplayName: "M",
		SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC, Status: "active",
	}
	userStore.users[target.ID] = target
	userStore.emailIndex[target.Email] = target

	admin := &model.User{ID: "u-adm-ng", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SetUserStatus))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u-member/status", strings.NewReader(`{"deactivated":true}`))
	req.SetPathValue("id", "u-member")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}
