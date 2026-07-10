package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
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

func TestAdminHandler_GetSettings_GiphyKeyVisibleForMember(t *testing.T) {
	settingsSvc := service.NewSettingsService(&fakeSettingsStore{
		current: &model.WorkspaceSettings{GiphyAPIKey: "secret-giphy-key"},
	})
	h := NewAdminHandler(settingsSvc)
	jwtMgr := auth.NewJWTManager("redact-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-mem-redact", Email: "m@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetSettings))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["giphyAPIKey"] != "secret-giphy-key" {
		t.Errorf("member should receive browser Giphy key, got %v", got["giphyAPIKey"])
	}
	if got["giphyEnabled"] != true {
		t.Errorf("giphyEnabled = %v, want true", got["giphyEnabled"])
	}
}

func TestAdminHandler_GetSettings_GiphyKeyVisibleForAdmin(t *testing.T) {
	settingsSvc := service.NewSettingsService(&fakeSettingsStore{
		current: &model.WorkspaceSettings{GiphyAPIKey: "secret-giphy-key"},
	})
	h := NewAdminHandler(settingsSvc)
	jwtMgr := auth.NewJWTManager("admin-vis-secret", 15*time.Minute, 720*time.Hour)
	admin := &model.User{ID: "u-adm-vis", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetSettings))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["giphyAPIKey"] != "secret-giphy-key" {
		t.Errorf("admin should see giphyAPIKey, got %v", got["giphyAPIKey"])
	}
	if got["giphyEnabled"] != true {
		t.Errorf("giphyEnabled = %v, want true", got["giphyEnabled"])
	}
}

func TestAdminHandler_UpdateSettings_GiphyRoundtrip(t *testing.T) {
	store := &fakeSettingsStore{}
	settingsSvc := service.NewSettingsService(store)
	h := NewAdminHandler(settingsSvc)
	jwtMgr := auth.NewJWTManager("giphy-round-secret", 15*time.Minute, 720*time.Hour)
	admin := &model.User{ID: "u-adm-rt", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateSettings))
	body := `{"maxUploadBytes":2048,"allowedExtensions":["png"],"giphyAPIKey":"  brand-new-key  "}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if store.current == nil || store.current.GiphyAPIKey != "brand-new-key" {
		t.Errorf("stored key = %q, want trimmed 'brand-new-key'", store.current.GiphyAPIKey)
	}

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["giphyAPIKey"] != "brand-new-key" {
		t.Errorf("response key = %v, want 'brand-new-key'", got["giphyAPIKey"])
	}
	if got["giphyEnabled"] != true {
		t.Errorf("giphyEnabled = %v, want true", got["giphyEnabled"])
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
func (s *fakeAttachmentStore) SetDimensions(_ context.Context, id string, width, height int) error {
	if a, ok := s.byID[id]; ok {
		a.Width = width
		a.Height = height
	}
	return nil
}
func (s *fakeAttachmentStore) SetThumbnailKeys(_ context.Context, id, thumbnailKey, squareThumbnailKey string) error {
	if a, ok := s.byID[id]; ok {
		a.ThumbnailS3Key = thumbnailKey
		a.SquareThumbnailS3Key = squareThumbnailKey
	}
	return nil
}

type fakeSigner struct {
	objects         map[string][]byte
	objectTypes     map[string]string
	putContentTypes map[string]string
}

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
func (f *fakeSigner) PutObject(_ context.Context, key, contentType string, body []byte) error {
	if f.objects == nil {
		f.objects = map[string][]byte{}
	}
	f.objects[key] = append([]byte(nil), body...)
	if f.putContentTypes != nil {
		f.putContentTypes[key] = contentType
	}
	return nil
}
func (f *fakeSigner) GetObjectRange(_ context.Context, _ string, _ int64) ([]byte, error) {
	return nil, nil
}
func (f *fakeSigner) GetObject(_ context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	if f.objects != nil {
		if body, ok := f.objects[key]; ok {
			contentType := "image/png"
			if f.objectTypes != nil && f.objectTypes[key] != "" {
				contentType = f.objectTypes[key]
			}
			return io.NopCloser(bytes.NewReader(body)), contentType, int64(len(body)), time.Date(2026, 5, 2, 12, 0, 0, 0, time.UTC), nil
		}
	}
	return io.NopCloser(strings.NewReader("body")), "text/plain", 4, time.Date(2026, 5, 2, 12, 0, 0, 0, time.UTC), nil
}

type fakeMediaCacheH struct {
	items  map[string]any
	getErr error
}

func newFakeMediaCacheH() *fakeMediaCacheH {
	return &fakeMediaCacheH{items: map[string]any{}}
}

func (c *fakeMediaCacheH) Get(_ context.Context, key string, dest interface{}) error {
	if c.getErr != nil {
		return c.getErr
	}
	v, ok := c.items[key]
	if !ok {
		return cache.ErrCacheMiss
	}
	data, _ := json.Marshal(v)
	return json.Unmarshal(data, dest)
}

func (c *fakeMediaCacheH) Set(_ context.Context, key string, val interface{}, _ time.Duration) error {
	c.items[key] = val
	return nil
}

func setupAttachmentHandler(t *testing.T) (*AttachmentHandler, *fakeAttachmentStore, *auth.JWTManager) {
	t.Helper()
	st := newFakeAttachmentStore()
	signer := &fakeSigner{}
	svc := service.NewAttachmentService(st, signer, nil)
	jwtMgr := auth.NewJWTManager("att-handler-secret", 15*time.Minute, 720*time.Hour)
	return NewAttachmentHandler(svc), st, jwtMgr
}

func handlerPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 20), G: uint8(y * 20), B: 180, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func handlerSHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
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

	body := `{"filename":"foo.png","contentType":"image/png","size":1024,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
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
	hash := strings.Repeat("d", 64)
	st.byID["a-existing"] = &model.Attachment{
		ID: "a-existing", SHA256: hash, Filename: "old.png",
		ContentType: "image/png", Size: 200, CreatedBy: "u-att-dup",
	}
	st.byHash[hash] = st.byID["a-existing"]

	user := &model.User{ID: "u-att-dup", Email: "dup@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))

	body := `{"filename":"new.png","contentType":"image/png","size":200,"sha256":"` + hash + `"}`
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

func TestAttachmentHandler_ProcessUpload_GeneratesServerThumbnails(t *testing.T) {
	st := newFakeAttachmentStore()
	signer := &fakeSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}}
	svc := service.NewAttachmentService(st, signer, nil)
	h := NewAttachmentHandler(svc)
	jwtMgr := auth.NewJWTManager("att-handler-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-att-process", Email: "process@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	object := handlerPNG(t, 10, 8)
	a := &model.Attachment{
		ID:          "a-process",
		SHA256:      handlerSHA256Hex(object),
		Size:        int64(len(object)),
		ContentType: "image/png",
		Filename:    "photo.png",
		S3Key:       "attachments/a-process",
		CreatedBy:   user.ID,
		CreatedAt:   time.Now(),
	}
	st.byID[a.ID] = a
	st.byHash[a.SHA256] = a
	signer.objects[a.S3Key] = object

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ProcessUpload))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/a-process/process", nil)
	req.SetPathValue("id", "a-process")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if st.byID[a.ID].ThumbnailS3Key == "" || st.byID[a.ID].SquareThumbnailS3Key == "" {
		t.Fatal("expected process to persist thumbnail keys")
	}
	if got := signer.putContentTypes[st.byID[a.ID].ThumbnailS3Key]; got != "image/webp" {
		t.Fatalf("message thumbnail content type = %q, want image/webp", got)
	}
	if got := signer.putContentTypes[st.byID[a.ID].SquareThumbnailS3Key]; got != "image/webp" {
		t.Fatalf("square thumbnail content type = %q, want image/webp", got)
	}
}

func TestAttachmentHandler_ProcessUpload_ErrorResponses(t *testing.T) {
	h, st, jwtMgr := setupAttachmentHandler(t)
	user := &model.User{ID: "u-att-errors", Email: "errors@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	t.Run("unauthenticated", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/a/process", nil)
		req.SetPathValue("id", "a")
		rec := httptest.NewRecorder()
		h.ProcessUpload(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("missing id", func(t *testing.T) {
		handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ProcessUpload))
		req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments//process", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("forbidden", func(t *testing.T) {
		st.byID["a-other"] = &model.Attachment{
			ID: "a-other", CreatedBy: "someone-else", S3Key: "attachments/a-other", Size: 1,
		}
		handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ProcessUpload))
		req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/a-other/process", nil)
		req.SetPathValue("id", "a-other")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusForbidden, rec.Body.String())
		}
	})

	t.Run("not found", func(t *testing.T) {
		handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ProcessUpload))
		req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/missing/process", nil)
		req.SetPathValue("id", "missing")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNotFound, rec.Body.String())
		}
	})
}

// fakeTransientAccessChecker simulates the attachment access check itself
// failing (store blip) vs. definitively denying, so handler mapping of the
// two outcomes can be asserted.
type fakeTransientAccessChecker struct{ err error }

func (c fakeTransientAccessChecker) CanAccessMessageAttachment(context.Context, string, string, string, string, string) error {
	return c.err
}

func TestAttachmentHandler_List_TransientAccessFailureIsAnErrorNotASubset(t *testing.T) {
	// Regression for "attachments disappeared until hard refresh": a
	// transient access-check failure used to be silently filtered out of a
	// 200 response, which clients cached as fresh truth for minutes.
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	jwtMgr := auth.NewJWTManager("att-handler-secret", 15*time.Minute, 720*time.Hour)
	h := NewAttachmentHandler(svc)
	user := &model.User{ID: "u-viewer", Email: "v@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	st.byID["a-1"] = &model.Attachment{
		ID: "a-1", CreatedBy: "u-author", S3Key: "attachments/a-1", Size: 1,
		MessageIDs: []string{"m-1"},
	}
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))
	doList := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments?ids=a-1&parentID=ch-1&parentType=channel&messageID=m-1", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	svc.SetAccessChecker(fakeTransientAccessChecker{err: errors.New("dynamo timeout")})
	if rec := doList(); rec.Code != http.StatusInternalServerError {
		t.Fatalf("transient failure: status = %d, want 500; body: %s", rec.Code, rec.Body.String())
	}

	// Definitive denial still filters within a 200 — a verdict, not an outage.
	svc.SetAccessChecker(fakeTransientAccessChecker{err: fmt.Errorf("no: %w", service.ErrForbidden)})
	rec := doList()
	if rec.Code != http.StatusOK {
		t.Fatalf("denial: status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "[]" {
		t.Fatalf("denial: body = %s, want []", body)
	}
}

func TestAttachmentHandler_Get_TransientAccessFailureIs500NotFoundIs404(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	jwtMgr := auth.NewJWTManager("att-handler-secret", 15*time.Minute, 720*time.Hour)
	h := NewAttachmentHandler(svc)
	user := &model.User{ID: "u-viewer", Email: "v@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	st.byID["a-1"] = &model.Attachment{
		ID: "a-1", CreatedBy: "u-author", S3Key: "attachments/a-1", Size: 1,
		MessageIDs: []string{"m-1"},
	}
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Get))
	doGet := func(id string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/"+id+"?parentID=ch-1&parentType=channel&messageID=m-1", nil)
		req.SetPathValue("id", id)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// The access check could not run — must NOT masquerade as "gone".
	svc.SetAccessChecker(fakeTransientAccessChecker{err: errors.New("dynamo timeout")})
	if rec := doGet("a-1"); rec.Code != http.StatusInternalServerError {
		t.Fatalf("transient failure: status = %d, want 500; body: %s", rec.Code, rec.Body.String())
	}

	// Denied or missing reads 404.
	svc.SetAccessChecker(fakeTransientAccessChecker{err: fmt.Errorf("no: %w", service.ErrForbidden)})
	if rec := doGet("a-1"); rec.Code != http.StatusNotFound {
		t.Fatalf("denial: status = %d, want 404; body: %s", rec.Code, rec.Body.String())
	}
	if rec := doGet("missing"); rec.Code != http.StatusNotFound {
		t.Fatalf("missing: status = %d, want 404; body: %s", rec.Code, rec.Body.String())
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
		ID: "a-get", Filename: "g.png", ContentType: "image/png", S3Key: "attachments/a-get", CreatedBy: "u-att-g",
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

func TestAttachmentHandler_Media_OK(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	svc.SetMediaURLCache(newFakeMediaCacheH())
	h := NewAttachmentHandler(svc)
	att := &model.Attachment{
		ID:          "a-media",
		SHA256:      "sha-media",
		S3Key:       "attachments/a-media",
		Filename:    "pic.png",
		ContentType: "image/png",
		Size:        4,
		CreatedBy:   "u1",
	}
	if err := st.Create(context.Background(), att); err != nil {
		t.Fatalf("Create: %v", err)
	}
	resolved, err := svc.Get(context.Background(), att.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	parts := strings.Split(resolved.URL, "/")
	token := parts[len(parts)-2]

	req := httptest.NewRequest(http.MethodGet, "/api/v1/media/"+token+"/pic.png", nil)
	req.SetPathValue("token", token)
	rec := httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if rec.Body.String() != "body" {
		t.Fatalf("body = %q, want body", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != storage.BrowserObjectCacheControl {
		t.Fatalf("Cache-Control = %q, want %q", got, storage.BrowserObjectCacheControl)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain" {
		t.Fatalf("Content-Type = %q, want text/plain", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "sandbox" {
		t.Fatalf("Content-Security-Policy = %q, want sandbox", got)
	}
	// text/plain is not script-bearing, so it serves inline (no disposition).
	if got := rec.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("Content-Disposition = %q, want empty for inline text/plain", got)
	}
	lastModified := rec.Header().Get("Last-Modified")
	if lastModified != "Sat, 02 May 2026 12:00:00 GMT" {
		t.Fatalf("Last-Modified = %q, want object timestamp", lastModified)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/media/"+token+"/pic.png", nil)
	req.SetPathValue("token", token)
	req.Header.Set("If-Modified-Since", lastModified)
	rec = httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d, want %d; body: %s", rec.Code, http.StatusNotModified, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("conditional body length = %d, want 0", rec.Body.Len())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/media/"+token+"/pic.png?download=1", nil)
	req.SetPathValue("token", token)
	rec = httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("download status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="pic.png"` {
		t.Fatalf("Content-Disposition = %q, want attachment filename", got)
	}
}

func TestIsInlineUnsafeContentType(t *testing.T) {
	cases := map[string]bool{
		"text/html":                true,
		"text/html; charset=utf-8": true, // parameters stripped
		"application/xhtml+xml":    true,
		"image/svg+xml":            true,
		"application/xml":          true,
		"text/xml":                 true,
		"application/foo+xml":      true, // any +xml is scriptable
		"image/png":                false,
		"image/jpeg":               false,
		"video/mp4":                false,
		"application/pdf":          false,
		"text/plain":               false,
		"":                         false,
	}
	for ct, want := range cases {
		if got := isInlineUnsafeContentType(ct); got != want {
			t.Errorf("isInlineUnsafeContentType(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestAttachmentHandler_Media_MissingToken(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	h := NewAttachmentHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/media//x.png", nil)
	rec := httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestAttachmentHandler_Media_NotFound(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	svc.SetMediaURLCache(newFakeMediaCacheH())
	h := NewAttachmentHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/media/unknown-token/x.png", nil)
	req.SetPathValue("token", "unknown-token")
	rec := httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
}

func TestAttachmentHandler_Media_BadGateway(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	mc := newFakeMediaCacheH()
	mc.getErr = errors.New("redis exploded")
	svc.SetMediaURLCache(mc)
	h := NewAttachmentHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/media/some-token/x.png", nil)
	req.SetPathValue("token", "some-token")
	rec := httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusBadGateway, rec.Body.String())
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

// --- Channel SetNotificationPrefs tests ---

func TestChannelHandler_SetNotificationPrefs_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels//notification-preferences", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetNotificationPrefs(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetNotificationPrefs_InvalidJSON(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/c1/notification-preferences", strings.NewReader("{bad"))
	req.SetPathValue("id", "c1")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.SetNotificationPrefs(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SetNotificationPrefs_OK(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-np#u-np"] = &model.ChannelMembership{
		ChannelID: "ch-np", UserID: "u-np", Role: model.ChannelRoleMember,
	}
	user := &model.User{ID: "u-np", Email: "np@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetNotificationPrefs))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/ch-np/notification-preferences", strings.NewReader(`{"desktopLevel":"all","threadReplies":false}`))
	req.SetPathValue("id", "ch-np")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandler_SetNotificationPrefs_InvalidLevel(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-np#u-np"] = &model.ChannelMembership{
		ChannelID: "ch-np", UserID: "u-np", Role: model.ChannelRoleMember,
	}
	user := &model.User{ID: "u-np", Email: "np@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetNotificationPrefs))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/channels/ch-np/notification-preferences", strings.NewReader(`{"desktopLevel":"bogus"}`))
	req.SetPathValue("id", "ch-np")
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
	now := time.Now()
	env.messages.messages["ch-lp#m1"] = &model.Message{
		ID: "m1", ParentID: "ch-lp", AuthorID: "u-lp", Body: "p1", Pinned: true,
	}
	env.messages.messages["ch-lp#m2"] = &model.Message{
		ID: "m2", ParentID: "ch-lp", AuthorID: "u-lp", Body: "u",
	}
	// Mirror the production write: SetPinned populates the PIN# index.
	// ListPinned reads exclusively from there.
	_ = env.parentIndex.SetPinIndex(context.Background(), "ch-lp", "m1", "u-lp", now)
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

type dataThreadFollowStore struct {
	rows map[string]*model.ThreadFollow
}

func newDataThreadFollowStore() *dataThreadFollowStore {
	return &dataThreadFollowStore{rows: make(map[string]*model.ThreadFollow)}
}

func dataThreadFollowKey(userID, parentID, threadRootID string) string {
	return userID + "#" + parentID + "#" + threadRootID
}

func (s *dataThreadFollowStore) SetThreadFollow(_ context.Context, follow *model.ThreadFollow) error {
	cp := *follow
	s.rows[dataThreadFollowKey(follow.UserID, follow.ParentID, follow.ThreadRootID)] = &cp
	return nil
}

func (s *dataThreadFollowStore) SetThreadFollowMany(ctx context.Context, follows []*model.ThreadFollow) error {
	for _, f := range follows {
		if err := s.SetThreadFollow(ctx, f); err != nil {
			return err
		}
	}
	return nil
}

func (s *dataThreadFollowStore) GetThreadFollow(_ context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error) {
	f, ok := s.rows[dataThreadFollowKey(userID, parentID, threadRootID)]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *f
	return &cp, nil
}

func (s *dataThreadFollowStore) ListUserThreadFollows(_ context.Context, userID string) ([]*model.ThreadFollow, error) {
	out := make([]*model.ThreadFollow, 0)
	for _, f := range s.rows {
		if f.UserID == userID {
			cp := *f
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *dataThreadFollowStore) ListThreadFollows(_ context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error) {
	out := make([]*model.ThreadFollow, 0)
	for _, f := range s.rows {
		if f.ParentID == parentID && f.ThreadRootID == threadRootID {
			cp := *f
			out = append(out, &cp)
		}
	}
	return out, nil
}

func TestThreadHandler_FollowAndUnfollow(t *testing.T) {
	memberships := newDataMembershipStore()
	memberships.memberships["ch-thread#u-thread"] = &model.ChannelMembership{ChannelID: "ch-thread", UserID: "u-thread"}
	wrapper := &dataMembershipStoreWithUserChans{
		dataMembershipStore: memberships,
		userChans: map[string][]*model.UserChannel{
			"u-thread": {{UserID: "u-thread", ChannelID: "ch-thread", ChannelName: "thread-chan"}},
		},
	}
	messages := newDataMessageStore()
	messages.messages["ch-thread#root"] = &model.Message{
		ID: "root", ParentID: "ch-thread", AuthorID: "u-other", Body: "root msg", CreatedAt: time.Now(),
	}
	follows := newDataThreadFollowStore()
	messageSvc := service.NewMessageService(messages, wrapper, newDataConversationStore(), nil, &mockBrokerForHandler{})
	messageSvc.SetThreadFollowStore(follows)
	jwtMgr := auth.NewJWTManager("thread-follow-secret", 15*time.Minute, 720*time.Hour)
	h := NewThreadHandler(messageSvc)
	user := &model.User{ID: "u-thread", Email: "th@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Follow))
	req := httptest.NewRequest(http.MethodPut, "/api/v1/threads/channels/ch-thread/root/follow", nil)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-thread")
	req.SetPathValue("threadRootID", "root")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("follow status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if got := follows.rows[dataThreadFollowKey("u-thread", "ch-thread", "root")]; got == nil || !got.Following {
		t.Fatalf("follow row = %+v, want Following=true", got)
	}

	handler = middleware.Auth(jwtMgr)(http.HandlerFunc(h.Unfollow))
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/threads/channels/ch-thread/root/follow", nil)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-thread")
	req.SetPathValue("threadRootID", "root")
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unfollow status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if got := follows.rows[dataThreadFollowKey("u-thread", "ch-thread", "root")]; got == nil || got.Following {
		t.Fatalf("follow row = %+v, want Following=false", got)
	}
}

func TestThreadHandler_Follow_UnauthenticatedAndBadTarget(t *testing.T) {
	messageSvc := service.NewMessageService(newDataMessageStore(), newDataMembershipStore(), newDataConversationStore(), nil, &mockBrokerForHandler{})
	messageSvc.SetThreadFollowStore(newDataThreadFollowStore())
	h := NewThreadHandler(messageSvc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/threads/channels/ch/root/follow", nil)
	h.Follow(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	jwtMgr := auth.NewJWTManager("thread-follow-bad-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-thread", Email: "th@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Follow))
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/threads/bogus/ch/root/follow", nil)
	req.SetPathValue("parentType", "bogus")
	req.SetPathValue("parentID", "ch")
	req.SetPathValue("threadRootID", "root")
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad target status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/threads/channels//root/follow", nil)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "")
	req.SetPathValue("threadRootID", "root")
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty parent status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestThreadHandler_Follow_ServiceError(t *testing.T) {
	// No membership for the caller → SetThreadFollow's access check fails,
	// surfacing as a 400 follow_error.
	messageSvc := service.NewMessageService(newDataMessageStore(), newDataMembershipStore(), newDataConversationStore(), nil, &mockBrokerForHandler{})
	messageSvc.SetThreadFollowStore(newDataThreadFollowStore())
	h := NewThreadHandler(messageSvc)
	jwtMgr := auth.NewJWTManager("thread-follow-svcerr-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-noaccess", Email: "na@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Follow))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/threads/channels/ch-x/root-x/follow", nil)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-x")
	req.SetPathValue("threadRootID", "root-x")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("follow service-error status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestNormalizeThreadParentType(t *testing.T) {
	tests := []struct {
		raw  string
		want string
		ok   bool
	}{
		{raw: "channel", want: service.ParentChannel, ok: true},
		{raw: "channels", want: service.ParentChannel, ok: true},
		{raw: "conversation", want: service.ParentConversation, ok: true},
		{raw: "conversations", want: service.ParentConversation, ok: true},
		{raw: "bogus", ok: false},
	}
	for _, tt := range tests {
		got, ok := normalizeThreadParentType(tt.raw)
		if ok != tt.ok || got != tt.want {
			t.Fatalf("normalizeThreadParentType(%q) = %q, %v; want %q, %v", tt.raw, got, ok, tt.want, tt.ok)
		}
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

// dataParentIndexStore is an in-memory ParentIndexStoreImpl-compatible
// fake. It satisfies the small subset of methods ParentIndexAdapter
// reaches for, exercising the adapter's translation between
// store.PinIndexRow / FileIndexRow and service.PinIndexEntry /
// FileIndexEntry without spinning up DynamoDB.
type dataParentIndexStore struct {
	pins        map[string]map[string]*store.PinIndexRow
	files       map[string]map[string]*store.FileIndexRow
	listPinErr  error
	listFileErr error
}

func newDataParentIndexStore() *dataParentIndexStore {
	return &dataParentIndexStore{
		pins:  make(map[string]map[string]*store.PinIndexRow),
		files: make(map[string]map[string]*store.FileIndexRow),
	}
}

func (d *dataParentIndexStore) SetPinIndex(_ context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error {
	if d.pins[parentID] == nil {
		d.pins[parentID] = make(map[string]*store.PinIndexRow)
	}
	d.pins[parentID][msgID] = &store.PinIndexRow{ParentID: parentID, MessageID: msgID, PinnedBy: pinnedBy, PinnedAt: pinnedAt}
	return nil
}
func (d *dataParentIndexStore) DeletePinIndex(_ context.Context, parentID, msgID string) error {
	if d.pins[parentID] != nil {
		delete(d.pins[parentID], msgID)
	}
	return nil
}
func (d *dataParentIndexStore) ListPinIndex(_ context.Context, parentID string) ([]*store.PinIndexRow, error) {
	if d.listPinErr != nil {
		return nil, d.listPinErr
	}
	rows := d.pins[parentID]
	out := make([]*store.PinIndexRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, r)
	}
	return out, nil
}
func (d *dataParentIndexStore) SetFileIndex(_ context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error {
	if d.files[parentID] == nil {
		d.files[parentID] = make(map[string]*store.FileIndexRow)
	}
	d.files[parentID][attachmentID] = &store.FileIndexRow{
		ParentID: parentID, AttachmentID: attachmentID, MessageID: msgID, AuthorID: authorID, CreatedAt: createdAt,
	}
	return nil
}
func (d *dataParentIndexStore) DeleteFileIndex(_ context.Context, parentID, attachmentID string) error {
	if d.files[parentID] != nil {
		delete(d.files[parentID], attachmentID)
	}
	return nil
}
func (d *dataParentIndexStore) ListFileIndex(_ context.Context, parentID string) ([]*store.FileIndexRow, error) {
	if d.listFileErr != nil {
		return nil, d.listFileErr
	}
	rows := d.files[parentID]
	out := make([]*store.FileIndexRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, r)
	}
	return out, nil
}

func TestParentIndexAdapter_ListErrorsPropagate(t *testing.T) {
	ctx := context.Background()

	backing := newDataParentIndexStore()
	backing.listPinErr = errors.New("pin list boom")
	adapter := newParentIndexAdapterFromBacking(backing)
	if _, err := adapter.ListPinIndex(ctx, "ch"); err == nil {
		t.Error("expected ListPinIndex error to propagate")
	}

	backing2 := newDataParentIndexStore()
	backing2.listFileErr = errors.New("file list boom")
	adapter2 := newParentIndexAdapterFromBacking(backing2)
	if _, err := adapter2.ListFileIndex(ctx, "ch"); err == nil {
		t.Error("expected ListFileIndex error to propagate")
	}
}

func TestParentIndexAdapter_Delegates(t *testing.T) {
	if NewParentIndexAdapter(nil) == nil {
		t.Fatal("NewParentIndexAdapter returned nil constructor")
	}
	backing := newDataParentIndexStore()
	// Re-package as the unexported pointer the real adapter wraps. The
	// adapter only reaches for the typed methods on store.ParentIndexStoreImpl,
	adapter := newParentIndexAdapterFromBacking(backing)

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := adapter.SetPinIndex(ctx, "ch-A", "m-1", "u-bob", now); err != nil {
		t.Fatalf("SetPinIndex: %v", err)
	}
	if err := adapter.SetFileIndex(ctx, "ch-A", "att-1", "m-1", "u-bob", now); err != nil {
		t.Fatalf("SetFileIndex: %v", err)
	}
	pins, err := adapter.ListPinIndex(ctx, "ch-A")
	if err != nil {
		t.Fatalf("ListPinIndex: %v", err)
	}
	if len(pins) != 1 || pins[0].MessageID != "m-1" {
		t.Errorf("ListPinIndex = %+v", pins)
	}
	files, err := adapter.ListFileIndex(ctx, "ch-A")
	if err != nil {
		t.Fatalf("ListFileIndex: %v", err)
	}
	if len(files) != 1 || files[0].AttachmentID != "att-1" {
		t.Errorf("ListFileIndex = %+v", files)
	}
	if err := adapter.DeletePinIndex(ctx, "ch-A", "m-1"); err != nil {
		t.Fatalf("DeletePinIndex: %v", err)
	}
	if err := adapter.DeleteFileIndex(ctx, "ch-A", "att-1"); err != nil {
		t.Fatalf("DeleteFileIndex: %v", err)
	}
	pins, _ = adapter.ListPinIndex(ctx, "ch-A")
	files, _ = adapter.ListFileIndex(ctx, "ch-A")
	if len(pins) != 0 || len(files) != 0 {
		t.Errorf("after deletes, expected empty; pins=%v files=%v", pins, files)
	}
}

// typelessSigner serves objects with no Content-Type, like a legacy S3 object
// PUT without one.
type typelessSigner struct{ fakeSigner }

func (s *typelessSigner) GetObject(_ context.Context, _ string) (io.ReadCloser, string, int64, time.Time, error) {
	return io.NopCloser(strings.NewReader("body")), "", 4, time.Date(2026, 5, 2, 12, 0, 0, 0, time.UTC), nil
}

func TestAttachmentHandler_Media_EmptyContentTypeServesOctetStream(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &typelessSigner{}, nil)
	svc.SetMediaURLCache(newFakeMediaCacheH())
	h := NewAttachmentHandler(svc)
	att := &model.Attachment{
		ID:        "a-notype",
		SHA256:    "sha-notype",
		S3Key:     "attachments/a-notype",
		Filename:  "blob.bin",
		Size:      4,
		CreatedBy: "u1",
		// No ContentType anywhere: neither the row nor the object store
		// knows one, so the handler must default to octet-stream.
	}
	if err := st.Create(context.Background(), att); err != nil {
		t.Fatalf("Create: %v", err)
	}
	resolved, err := svc.Get(context.Background(), att.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	parts := strings.Split(resolved.URL, "/")
	token := parts[len(parts)-2]

	req := httptest.NewRequest(http.MethodGet, "/api/v1/media/"+token+"/blob.bin", nil)
	req.SetPathValue("token", token)
	rec := httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("Content-Type = %q, want application/octet-stream", got)
	}
}
