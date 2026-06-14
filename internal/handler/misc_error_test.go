package handler

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// --- unfurl.go: success path -----------------------------------------------

// fakeUnfurlService returns a fixed preview so the handler's writeJSON success
// branch runs. A real UnfurlService can't reach this in a unit test because its
// SSRF guard rejects the loopback hosts httptest binds to.
type fakeUnfurlService struct {
	preview *service.UnfurlPreview
	err     error
}

func (f fakeUnfurlService) Unfurl(_ context.Context, _ string) (*service.UnfurlPreview, error) {
	return f.preview, f.err
}

// TestUnfurlHandler_Get_Success covers UnfurlHandler.Get's writeJSON branch:
// the service returns a preview, which the handler serializes with 200.
func TestUnfurlHandler_Get_Success(t *testing.T) {
	h := &UnfurlHandler{svc: fakeUnfurlService{preview: &service.UnfurlPreview{
		URL: "https://example.com", Title: "Example",
	}}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=https://example.com", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Example") {
		t.Fatalf("body missing preview title: %s", rec.Body.String())
	}
}

// --- upload.go: presign error branches -------------------------------------

// failingUploadSigner makes both presign calls fail so UploadHandler's
// presign-error branches execute. putErr fires on the PUT presign; getErr on
// the GET presign (only reached when the PUT succeeds).
type failingUploadSigner struct {
	putErr error
	getErr error
}

func (s failingUploadSigner) PresignedPutURL(_ context.Context, key, _ string, _ time.Duration) (string, error) {
	if s.putErr != nil {
		return "", s.putErr
	}
	return "https://upload/" + key, nil
}

func (s failingUploadSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	if s.getErr != nil {
		return "", s.getErr
	}
	return "https://get/" + key, nil
}

func uploadReq(t *testing.T, jwtMgr *auth.JWTManager) *http.Request {
	t.Helper()
	u := &model.User{ID: "up-err", Email: "e@x.com", SystemRole: model.SystemRoleMember}
	tok := makeTokenForUser(jwtMgr, u)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url",
		strings.NewReader(`{"filename":"a.png","contentType":"image/png","size":128}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	return req
}

// TestCreateUploadURL_PutPresignError covers the PresignedPutURL error branch.
func TestCreateUploadURL_PutPresignError(t *testing.T) {
	jwtMgr := auth.NewJWTManager("up-put-secret", 15*time.Minute, 720*time.Hour)
	h := &UploadHandler{s3: failingUploadSigner{putErr: errors.New("presign put failed")}}
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL)).ServeHTTP(rec, uploadReq(t, jwtMgr))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCreateUploadURL_GetPresignError covers the PresignedGetURL error branch
// (PUT presign succeeds, GET presign fails).
func TestCreateUploadURL_GetPresignError(t *testing.T) {
	jwtMgr := auth.NewJWTManager("up-get-secret", 15*time.Minute, 720*time.Hour)
	h := &UploadHandler{s3: failingUploadSigner{getErr: errors.New("presign get failed")}}
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL)).ServeHTTP(rec, uploadReq(t, jwtMgr))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// --- user.go: GetUser / UpdateRole error + avatar presign error ------------

// TestGetUser_InternalError covers GetUser's non-NotFound error arm: the store
// returns a transient error, surfaced as 500.
func TestGetUser_InternalError(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)
	userStore.getUserErr = errors.New("dynamo unavailable")
	admin := &model.User{ID: "admin-1", SystemRole: model.SystemRoleAdmin}
	tok := makeTokenForUser(jwtMgr, admin)

	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/users/{id}", middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetUser)))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/target-1", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// TestUpdateRole_InternalError covers UpdateRole's non-NotFound error arm.
func TestUpdateRole_InternalError(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)
	userStore.getUserErr = errors.New("dynamo unavailable")
	admin := &model.User{ID: "admin-2", SystemRole: model.SystemRoleAdmin}
	tok := makeTokenForUser(jwtMgr, admin)

	mux := http.NewServeMux()
	mux.Handle("PUT /api/v1/users/{id}/role", middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole)))
	req := httptest.NewRequest(http.MethodPut, "/api/v1/users/target-2/role", strings.NewReader(`{"role":"member"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCreateAvatarUploadURL_PresignError covers the avatar presign-error arm by
// injecting a signer whose PresignedPutURL fails.
func TestCreateAvatarUploadURL_PresignError(t *testing.T) {
	userStore := newMockUserStore()
	userSvc := service.NewUserService(userStore, &mockCache{}, nil, nil)
	jwtMgr := auth.NewJWTManager("avatar-presign-secret", 15*time.Minute, 720*time.Hour)
	h := &UserHandler{userSvc: userSvc, s3: failingUploadSigner{putErr: errors.New("presign put failed")}}

	u := &model.User{ID: "av-u", Email: "av@x.com", SystemRole: model.SystemRoleMember}
	tok := makeTokenForUser(jwtMgr, u)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar-upload-url",
		strings.NewReader(`{"contentType":"image/png","size":1024}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateAvatarUploadURL)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// --- user_state.go: MarkThreadSeen state-error arm -------------------------

// TestUserStateHandler_MarkThreadSeen_StateError covers the arm where
// CheckAccess passes (the user is a channel member) but the subsequent
// stateSvc.MarkThreadSeen fails — distinct from the access-denied arm.
func TestUserStateHandler_MarkThreadSeen_StateError(t *testing.T) {
	stateStore := newMockUserStateStoreForHandler()
	stateStore.setErr = errors.New("seen boom")
	stateSvc := service.NewUserStateService(stateStore, nil)
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	members := newDataMembershipStore()
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	msgSvc := service.NewMessageService(messages, members, convs, nil, broker)
	convSvc := service.NewConversationService(convs, users, nil, broker, nil)
	handler := NewUserStateHandler(stateSvc, msgSvc, convSvc)

	// Seed membership so CheckAccess passes and the handler reaches the
	// MarkThreadSeen state write, which then errors.
	members.memberships["ch-ok#u-1"] = &model.ChannelMembership{ChannelID: "ch-ok", UserID: "u-1"}

	req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch-ok/root/seen", nil, "u-1")
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-ok")
	req.SetPathValue("threadRootID", "root")
	rec := httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// --- version.go: AppVersion io.Copy error ----------------------------------

// errReadFile is an fs.File whose Read always fails, driving AppVersion's
// io.Copy error branch.
type errReadFile struct{ r io.Reader }

func (f *errReadFile) Stat() (fs.FileInfo, error) { return nil, errors.New("no stat") }
func (f *errReadFile) Read(p []byte) (int, error) { return f.r.Read(p) }
func (f *errReadFile) Close() error               { return nil }

// errFileFS opens index.html successfully but the returned file errors on read.
type errFileFS struct{}

func (errFileFS) Open(name string) (fs.File, error) {
	if name != "index.html" {
		return nil, errors.New("not found")
	}
	return &errReadFile{r: iotest.ErrReader(errors.New("read failed"))}, nil
}

// TestAppVersion_FallsBackToDevOnReadError covers AppVersion's io.Copy error
// branch: index.html opens but errors mid-read, so the function returns "dev".
func TestAppVersion_FallsBackToDevOnReadError(t *testing.T) {
	BuildVersion = ""
	t.Cleanup(func() { BuildVersion = "" })
	if got := AppVersion(errFileFS{}); got != "dev" {
		t.Fatalf("AppVersion on read error = %q, want dev", got)
	}
}
