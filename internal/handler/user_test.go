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
	"github.com/DigitalTolk/ex/internal/storage"
)

func setupUserHandler(t *testing.T) (*UserHandler, *mockUserStore, *auth.JWTManager) {
	t.Helper()
	userStore := newMockUserStore()
	userSvc := service.NewUserService(userStore, &mockCache{}, nil, nil)
	jwtMgr := auth.NewJWTManager("test-user-handler-secret", 15*time.Minute, 720*time.Hour)
	return NewUserHandler(userSvc, nil), userStore, jwtMgr
}

func makeTokenForUser(jwtMgr *auth.JWTManager, user *model.User) string {
	token, _ := jwtMgr.GenerateAccessToken(user)
	return token
}

func TestGetMe(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	user := &model.User{
		ID:          "me-1",
		Email:       "me@example.com",
		DisplayName: "Me User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetMe))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got model.User
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != user.ID {
		t.Errorf("ID = %q, want %q", got.ID, user.ID)
	}
}

func TestGetMe_Unauthenticated(t *testing.T) {
	h, _, _ := setupUserHandler(t)

	// Call directly without auth middleware -- no claims in context.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	rec := httptest.NewRecorder()

	h.GetMe(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestUpdateMe(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	user := &model.User{
		ID:          "upd-1",
		Email:       "upd@example.com",
		DisplayName: "Old Name",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateMe))

	body := `{"displayName":"New Name"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/me", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got model.User
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.DisplayName != "New Name" {
		t.Errorf("DisplayName = %q, want %q", got.DisplayName, "New Name")
	}
}

func TestUpdateMe_Unauthenticated(t *testing.T) {
	h, _, _ := setupUserHandler(t)

	body := `{"displayName":"X"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/me", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.UpdateMe(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestGetUser_MissingID(t *testing.T) {
	h, _, _ := setupUserHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/", nil)
	rec := httptest.NewRecorder()

	h.GetUser(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestGetUser_Found_NonAdmin(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID:          "target-1",
		Email:       "target@example.com",
		DisplayName: "Target User",
		AvatarURL:   "avatar.png",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[target.ID] = target
	userStore.emailIndex[target.Email] = target

	caller := &model.User{
		ID:          "caller-1",
		Email:       "caller@example.com",
		DisplayName: "Caller",
		SystemRole:  model.SystemRoleMember, // non-admin
	}
	token := makeTokenForUser(jwtMgr, caller)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetUser))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/target-1", nil)
	req.SetPathValue("id", "target-1")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	// Non-admin should get limited fields.
	var got map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["id"] != "target-1" {
		t.Errorf("id = %v, want target-1", got["id"])
	}
	// Should not have email field (limited view).
	if _, hasEmail := got["email"]; hasEmail {
		t.Error("non-admin should not see email field")
	}
}

func TestGetUser_Found_Admin(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID:          "target-2",
		Email:       "target2@example.com",
		DisplayName: "Target User 2",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[target.ID] = target
	userStore.emailIndex[target.Email] = target

	admin := &model.User{
		ID:          "admin-caller",
		Email:       "admin@example.com",
		DisplayName: "Admin",
		SystemRole:  model.SystemRoleAdmin,
	}
	token := makeTokenForUser(jwtMgr, admin)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetUser))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/target-2", nil)
	req.SetPathValue("id", "target-2")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	// Admin should get full user object.
	var got map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["email"] != "target2@example.com" {
		t.Errorf("email = %v, want target2@example.com", got["email"])
	}
}

func TestGetUser_NotFound(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)

	user := &model.User{
		ID:         "caller-nf",
		Email:      "nf@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetUser))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/nonexistent", nil)
	req.SetPathValue("id", "nonexistent")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	// store.ErrNotFound wraps to StatusNotFound.
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestBatchGetUsers(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	userStore.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice", Status: "active"}
	userStore.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob", Status: "active"}

	caller := &model.User{ID: "caller-batch", Email: "batch@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, caller)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.BatchGetUsers))

	body := `{"ids":["u1","u2","nonexistent"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/batch", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got []map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 users, got %d", len(got))
	}
	// Should return limited fields (no email).
	for _, u := range got {
		if _, hasEmail := u["email"]; hasEmail {
			t.Error("batch should return limited fields, got email")
		}
	}
}

func TestBatchGetUsers_EmptyIDs(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	caller := &model.User{ID: "caller-empty", Email: "empty@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, caller)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.BatchGetUsers))

	body := `{"ids":[]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/batch", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestBatchGetUsers_TooManyIDs(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	caller := &model.User{ID: "caller-many", Email: "many@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, caller)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.BatchGetUsers))

	ids := make([]string, 101)
	for i := range ids {
		ids[i] = "id-" + strings.Repeat("x", 3)
	}
	idsJSON, _ := json.Marshal(ids)
	body := `{"ids":` + string(idsJSON) + `}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/batch", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestListUsers(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)

	user := &model.User{
		ID:          "list-1",
		Email:       "list@example.com",
		DisplayName: "List User",
		SystemRole:  model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ListUsers))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users?limit=10", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestListUsers_Search(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	userStore.users["s1"] = &model.User{ID: "s1", Email: "alice@example.com", DisplayName: "Alice Smith", SystemRole: model.SystemRoleMember}
	userStore.emailIndex["alice@example.com"] = userStore.users["s1"]
	userStore.users["s2"] = &model.User{ID: "s2", Email: "bob@example.com", DisplayName: "Bob Jones", SystemRole: model.SystemRoleMember}
	userStore.emailIndex["bob@example.com"] = userStore.users["s2"]

	caller := &model.User{ID: "search-caller", Email: "caller@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, caller)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ListUsers))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users?q=alice", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got []map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 result, got %d", len(got))
	}
	if got[0]["displayName"] != "Alice Smith" {
		t.Errorf("displayName = %v, want Alice Smith", got[0]["displayName"])
	}
	// Search should return email.
	if got[0]["email"] != "alice@example.com" {
		t.Errorf("email = %v, want alice@example.com", got[0]["email"])
	}
}

func TestListUsers_Search_NoResults(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)

	caller := &model.User{ID: "search-caller2", Email: "caller2@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, caller)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.ListUsers))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users?q=zzz", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var got []interface{}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 results, got %d", len(got))
	}
}

func TestCreateAvatarUploadURL_Unauthenticated(t *testing.T) {
	h, _, _ := setupUserHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar/upload-url", strings.NewReader(`{"contentType":"image/png"}`))
	rec := httptest.NewRecorder()

	h.CreateAvatarUploadURL(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestCreateAvatarUploadURL_NoStorage(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	user := &model.User{
		ID:          "avatar-ns",
		Email:       "avatar-ns@example.com",
		DisplayName: "NS User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateAvatarUploadURL))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar/upload-url", strings.NewReader(`{"contentType":"image/png"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
	}
}

func TestCreateAvatarUploadURL_InvalidContentType(t *testing.T) {
	// Use a real S3 client (with unreachable endpoint) so we get past the no-storage check.
	h, userStore, jwtMgr := setupUserHandler(t)
	s3Client, err := storage.NewS3Client(context.Background(), storage.S3Config{
		Endpoint:  "http://127.0.0.1:1",
		Bucket:    "test",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("S3 client: %v", err)
	}
	h.s3 = s3Client

	user := &model.User{
		ID: "avatar-ct", Email: "ct@test.com", DisplayName: "CT", SystemRole: model.SystemRoleMember, Status: "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateAvatarUploadURL))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar/upload-url", strings.NewReader(`{"contentType":"image/gif"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestCreateAvatarUploadURL_Success(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)
	s3Client, err := storage.NewS3Client(context.Background(), storage.S3Config{
		Endpoint:  "http://127.0.0.1:1",
		Bucket:    "test",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("S3 client: %v", err)
	}
	h.s3 = s3Client

	user := &model.User{
		ID: "avatar-ok", Email: "ok@test.com", DisplayName: "OK", SystemRole: model.SystemRoleMember, Status: "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateAvatarUploadURL))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar/upload-url", strings.NewReader(`{"contentType":"image/png"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var got struct {
		UploadURL string `json:"uploadURL"`
		Key       string `json:"key"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.UploadURL == "" {
		t.Error("expected uploadURL")
	}
	if !strings.HasPrefix(got.Key, "avatars/avatar-ok/") {
		t.Errorf("key = %q, want avatars/avatar-ok/...", got.Key)
	}
}

// Non-admin callers cannot change another user's system role.
func TestUpdateUserRole_AdminOnly(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID: "role-target", Email: "target@example.com", DisplayName: "Target",
		SystemRole: model.SystemRoleMember, Status: "active",
	}
	userStore.users[target.ID] = target
	userStore.emailIndex[target.Email] = target

	caller := &model.User{
		ID: "role-caller", Email: "caller@example.com", DisplayName: "Caller",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, caller)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/role-target/role", strings.NewReader(`{"role":"admin"}`))
	req.SetPathValue("id", "role-target")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if userStore.users["role-target"].SystemRole != model.SystemRoleMember {
		t.Error("role should not have changed")
	}
}

// Admin can promote a member to admin.
func TestUpdateUserRole_AdminPromotesToAdmin(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID: "promo-target", Email: "ptarget@example.com", DisplayName: "Target",
		SystemRole: model.SystemRoleMember, Status: "active",
	}
	userStore.users[target.ID] = target
	userStore.emailIndex[target.Email] = target

	admin := &model.User{
		ID: "promo-admin", Email: "padmin@example.com", DisplayName: "Admin",
		SystemRole: model.SystemRoleAdmin,
	}
	token := makeTokenForUser(jwtMgr, admin)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/promo-target/role", strings.NewReader(`{"role":"admin"}`))
	req.SetPathValue("id", "promo-target")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if userStore.users["promo-target"].SystemRole != model.SystemRoleAdmin {
		t.Errorf("SystemRole = %q, want %q", userStore.users["promo-target"].SystemRole, model.SystemRoleAdmin)
	}
}

// Invalid role values are rejected with 400.
func TestUpdateUserRole_InvalidRole(t *testing.T) {
	h, userStore, jwtMgr := setupUserHandler(t)

	target := &model.User{
		ID: "bad-target", Email: "bt@example.com", DisplayName: "T", SystemRole: model.SystemRoleMember,
	}
	userStore.users[target.ID] = target

	admin := &model.User{ID: "bad-admin", Email: "ba@example.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/bad-target/role", strings.NewReader(`{"role":"superlord"}`))
	req.SetPathValue("id", "bad-target")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUpdateMe_InvalidJSON(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	user := &model.User{ID: "u-bad", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateMe))
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/me", strings.NewReader(`{`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUpdateMe_StoreError(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	// User does not exist in the store, so service.Update returns an error.
	user := &model.User{ID: "missing", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateMe))
	body := `{"displayName":"X"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/me", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d (got body: %s)", rec.Code, http.StatusInternalServerError, rec.Body.String())
	}
}

func TestGetMe_StoreError(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	user := &model.User{ID: "missing-get", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.GetMe))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestBatchGetUsers_InvalidJSON(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	user := &model.User{ID: "u", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.BatchGetUsers))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/batch", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUpdateUserRole_NotAdmin(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	user := &model.User{ID: "u-non-admin", Email: "n@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u/role", strings.NewReader(`{"role":"admin"}`))
	req.SetPathValue("id", "u")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestUpdateUserRole_MissingID(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	admin := &model.User{ID: "a", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users//role", strings.NewReader(`{"role":"admin"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUpdateUserRole_InvalidJSON(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	admin := &model.User{ID: "a", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/u/role", strings.NewReader(`{`))
	req.SetPathValue("id", "u")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUpdateUserRole_NotFound(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	admin := &model.User{ID: "a", Email: "a@x.com", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.UpdateUserRole))
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/missing/role", strings.NewReader(`{"role":"member"}`))
	req.SetPathValue("id", "missing")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestCreateAvatarUploadURL_InvalidJSON(t *testing.T) {
	h, _, jwtMgr := setupUserHandler(t)
	// Stub S3 — we just need it non-nil to reach the JSON parse.
	h2 := NewUserHandler(h.userSvc, &storage.S3Client{})
	user := &model.User{ID: "u", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h2.CreateAvatarUploadURL))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar/upload-url", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	_ = context.Background() // imports
}
