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

// stubSidebarCategoryStore is an in-memory CategoryStore used by the
// sidebar handler tests. It mirrors the service-package stub but lives
// here so the handler tests don't depend on test-only types from another
// package.
type stubSidebarCategoryStore struct {
	rows      map[string]*model.UserChannelCategory // key = userID + "#" + id
	createErr error
	listErr   error
	updateErr error
	deleteErr error
}

func newStubSidebarCategoryStore() *stubSidebarCategoryStore {
	return &stubSidebarCategoryStore{rows: map[string]*model.UserChannelCategory{}}
}

func (s *stubSidebarCategoryStore) key(uid, id string) string { return uid + "#" + id }

func (s *stubSidebarCategoryStore) Create(_ context.Context, c *model.UserChannelCategory) error {
	if s.createErr != nil {
		return s.createErr
	}
	s.rows[s.key(c.UserID, c.ID)] = c
	return nil
}

func (s *stubSidebarCategoryStore) Get(_ context.Context, userID, id string) (*model.UserChannelCategory, error) {
	c, ok := s.rows[s.key(userID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	return c, nil
}

func (s *stubSidebarCategoryStore) List(_ context.Context, userID string) ([]*model.UserChannelCategory, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	out := make([]*model.UserChannelCategory, 0)
	for _, c := range s.rows {
		if c.UserID == userID {
			out = append(out, c)
		}
	}
	return out, nil
}

func (s *stubSidebarCategoryStore) Update(_ context.Context, c *model.UserChannelCategory) error {
	if s.updateErr != nil {
		return s.updateErr
	}
	if _, ok := s.rows[s.key(c.UserID, c.ID)]; !ok {
		return store.ErrNotFound
	}
	s.rows[s.key(c.UserID, c.ID)] = c
	return nil
}

func (s *stubSidebarCategoryStore) Delete(_ context.Context, userID, id string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.rows, s.key(userID, id))
	return nil
}

// stubSidebarOrderStore records server-computed order writes.
type stubSidebarOrderStore struct {
	applied [][]store.SidebarRowUpdate
	err     error
}

func (s *stubSidebarOrderStore) ApplyOrder(_ context.Context, _ string, updates []store.SidebarRowUpdate) error {
	if s.err != nil {
		return s.err
	}
	s.applied = append(s.applied, updates)
	return nil
}

// sidebarEnv bundles together the wired-up handler plus the underlying
// stores so individual tests can pre-load fixtures.
type sidebarEnv struct {
	handler       *SidebarHandler
	jwtMgr        *auth.JWTManager
	memberships   *dataMembershipStore
	channels      *dataChannelStore
	conversations *dataConversationStore
	categories    *stubSidebarCategoryStore
	order         *stubSidebarOrderStore
}

func setupSidebarHandler(t *testing.T) *sidebarEnv {
	t.Helper()
	channels := newDataChannelStore()
	memberships := newDataMembershipStore()
	conversations := newDataConversationStore()
	cache := &mockCache{}
	broker := &mockBrokerForHandler{}
	chanSvc := service.NewChannelService(channels, memberships, nil, nil, cache, broker, nil)
	convSvc := service.NewConversationService(conversations, nil, nil, nil, nil)

	cats := newStubSidebarCategoryStore()
	catSvc := service.NewCategoryService(cats, nil)

	h := NewSidebarHandler(chanSvc, convSvc, catSvc)
	order := &stubSidebarOrderStore{}
	h.SetSidebarService(service.NewSidebarService(memberships, conversations, cats, order, nil))
	jwtMgr := auth.NewJWTManager("test-sidebar-handler-secret", 15*time.Minute, 720*time.Hour)
	return &sidebarEnv{
		handler:       h,
		jwtMgr:        jwtMgr,
		memberships:   memberships,
		channels:      channels,
		conversations: conversations,
		categories:    cats,
		order:         order,
	}
}

// authedRequest builds a request, attaches a path parameter (so handlers
// using r.PathValue work without going through the mux), and returns the
// auth middleware so handlers can pull the user ID from context.
func authedRequest(t *testing.T, env *sidebarEnv, user *model.User, method, target, body, pathKey, pathValue string) (*httptest.ResponseRecorder, *http.Request, func(http.Handler) http.Handler) {
	t.Helper()
	token := makeTokenForUser(env.jwtMgr, user)
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if pathKey != "" {
		req.SetPathValue(pathKey, pathValue)
	}
	rec := httptest.NewRecorder()
	return rec, req, middleware.Auth(env.jwtMgr)
}

// addMember registers a user as a channel member so SetFavorite /
// SetCategory pass the per-user membership precondition.
func (env *sidebarEnv) addMember(channelID, userID string) {
	env.memberships.memberships[channelID+"#"+userID] = &model.ChannelMembership{
		ChannelID: channelID, UserID: userID, Role: model.ChannelRoleMember,
	}
}

// ----- SetFavorite -----

func TestSidebarHandler_SetFavorite_OK(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-fav", Email: "fav@x.com", SystemRole: model.SystemRoleMember}
	env.addMember("ch-1", user.ID)

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-1/favorite", `{"favorite":true}`, "id", "ch-1")
	mw(http.HandlerFunc(env.handler.SetFavorite)).ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestSidebarHandler_SetFavorite_MissingID(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-mi", Email: "mi@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels//favorite", `{"favorite":true}`, "id", "")
	mw(http.HandlerFunc(env.handler.SetFavorite)).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetFavorite_InvalidJSON(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-ij", Email: "ij@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-1/favorite", `{not-json`, "id", "ch-1")
	mw(http.HandlerFunc(env.handler.SetFavorite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetFavorite_NotMember(t *testing.T) {
	// User is not a member of the channel; service rejects with 403.
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-nm", Email: "nm@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-z/favorite", `{"favorite":false}`, "id", "ch-z")
	mw(http.HandlerFunc(env.handler.SetFavorite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
}

// ----- SetCategory -----

func TestSidebarHandler_SetCategory_OK(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-sc", Email: "sc@x.com", SystemRole: model.SystemRoleMember}
	env.addMember("ch-2", user.ID)

	// Pre-create a category that belongs to the user so the handler's
	// ownership check passes.
	cat := &model.UserChannelCategory{UserID: user.ID, ID: "cat-1", Name: "Eng", Position: 1}
	env.categories.rows[env.categories.key(user.ID, cat.ID)] = cat

	body := `{"categoryID":"cat-1"}`
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-2/category", body, "id", "ch-2")
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestSidebarHandler_SetCategory_ClearAssignment(t *testing.T) {
	// Empty categoryID skips the ownership check and clears assignment.
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-clear", Email: "cl@x.com", SystemRole: model.SystemRoleMember}
	env.addMember("ch-3", user.ID)

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-3/category", `{"categoryID":""}`, "id", "ch-3")
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestSidebarHandler_SetCategory_MissingID(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cmi", Email: "cmi@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels//category", `{"categoryID":""}`, "id", "")
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetCategory_InvalidJSON(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cij", Email: "cij@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-1/category", `{bad`, "id", "ch-1")
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetCategory_StrangerCategoryRejected(t *testing.T) {
	// The supplied categoryID belongs to a different user — handler
	// must reject with 400 invalid_category before touching the membership.
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-stranger", Email: "stranger@x.com", SystemRole: model.SystemRoleMember}
	env.addMember("ch-x", user.ID)
	other := &model.UserChannelCategory{UserID: "someone-else", ID: "cat-other", Name: "Other"}
	env.categories.rows[env.categories.key(other.UserID, other.ID)] = other

	body := `{"categoryID":"cat-other"}`
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-x/category", body, "id", "ch-x")
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_category") {
		t.Errorf("expected invalid_category error, got: %s", rec.Body.String())
	}
}

func TestSidebarHandler_SetCategory_NotMember(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cnm", Email: "cnm@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-stranger/category", `{"categoryID":""}`, "id", "ch-stranger")
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// ----- ListCategories -----

func TestSidebarHandler_ListCategories_Empty(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-le", Email: "le@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodGet, "/api/v1/sidebar/categories", "", "", "")
	mw(http.HandlerFunc(env.handler.ListCategories)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got []model.UserChannelCategory
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len = %d, want 0", len(got))
	}
}

func TestSidebarHandler_ListCategories_Multiple(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-lm", Email: "lm@x.com", SystemRole: model.SystemRoleMember}
	env.categories.rows[env.categories.key(user.ID, "c1")] = &model.UserChannelCategory{UserID: user.ID, ID: "c1", Name: "A", Position: 1}
	env.categories.rows[env.categories.key(user.ID, "c2")] = &model.UserChannelCategory{UserID: user.ID, ID: "c2", Name: "B", Position: 2}

	rec, req, mw := authedRequest(t, env, user, http.MethodGet, "/api/v1/sidebar/categories", "", "", "")
	mw(http.HandlerFunc(env.handler.ListCategories)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got []model.UserChannelCategory
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("len = %d, want 2", len(got))
	}
}

func TestSidebarHandler_ListCategories_StoreError(t *testing.T) {
	env := setupSidebarHandler(t)
	env.categories.listErr = errors.New("boom")
	user := &model.User{ID: "u-lerr", Email: "lerr@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodGet, "/api/v1/sidebar/categories", "", "", "")
	mw(http.HandlerFunc(env.handler.ListCategories)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

// ----- CreateCategory -----

func TestSidebarHandler_CreateCategory_OK(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cc", Email: "cc@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPost, "/api/v1/sidebar/categories", `{"name":"Engineering"}`, "", "")
	mw(http.HandlerFunc(env.handler.CreateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var got model.UserChannelCategory
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Name != "Engineering" {
		t.Errorf("Name = %q, want Engineering", got.Name)
	}
	if got.UserID != user.ID {
		t.Errorf("UserID = %q, want %q", got.UserID, user.ID)
	}
}

func TestSidebarHandler_CreateCategory_BlankName(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cbn", Email: "cbn@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPost, "/api/v1/sidebar/categories", `{"name":"   "}`, "", "")
	mw(http.HandlerFunc(env.handler.CreateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_CreateCategory_DuplicateName(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cdup", Email: "cdup@x.com", SystemRole: model.SystemRoleMember}
	env.categories.rows[env.categories.key(user.ID, "c1")] = &model.UserChannelCategory{UserID: user.ID, ID: "c1", Name: "Engineering", Position: 1}

	rec, req, mw := authedRequest(t, env, user, http.MethodPost, "/api/v1/sidebar/categories", `{"name":" engineering "}`, "", "")
	mw(http.HandlerFunc(env.handler.CreateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "category name already exists") {
		t.Errorf("body = %s, want friendly duplicate message", rec.Body.String())
	}
}

func TestSidebarHandler_CreateCategory_InvalidJSON(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cij2", Email: "cij2@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPost, "/api/v1/sidebar/categories", `{bad`, "", "")
	mw(http.HandlerFunc(env.handler.CreateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// ----- UpdateCategory -----

func TestSidebarHandler_UpdateCategory_OK(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-uc", Email: "uc@x.com", SystemRole: model.SystemRoleMember}
	env.categories.rows[env.categories.key(user.ID, "c1")] = &model.UserChannelCategory{UserID: user.ID, ID: "c1", Name: "Old", Position: 1}

	body := `{"name":"New","position":7}`
	rec, req, mw := authedRequest(t, env, user, http.MethodPatch, "/api/v1/sidebar/categories/c1", body, "id", "c1")
	mw(http.HandlerFunc(env.handler.UpdateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got model.UserChannelCategory
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Name != "New" || got.Position != 7 {
		t.Errorf("update not reflected: %+v", got)
	}
}

func TestSidebarHandler_UpdateCategory_MissingID(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-umi", Email: "umi@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPatch, "/api/v1/sidebar/categories/", `{"name":"x"}`, "id", "")
	mw(http.HandlerFunc(env.handler.UpdateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_UpdateCategory_InvalidJSON(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-uij", Email: "uij@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPatch, "/api/v1/sidebar/categories/c1", `{bad`, "id", "c1")
	mw(http.HandlerFunc(env.handler.UpdateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_UpdateCategory_NotFound(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-unf", Email: "unf@x.com", SystemRole: model.SystemRoleMember}
	body := `{"name":"x"}`
	rec, req, mw := authedRequest(t, env, user, http.MethodPatch, "/api/v1/sidebar/categories/missing", body, "id", "missing")
	mw(http.HandlerFunc(env.handler.UpdateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
}

func TestSidebarHandler_UpdateCategory_BlankNameRejected(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-ubn", Email: "ubn@x.com", SystemRole: model.SystemRoleMember}
	env.categories.rows[env.categories.key(user.ID, "c1")] = &model.UserChannelCategory{UserID: user.ID, ID: "c1", Name: "Old", Position: 1}
	body := `{"name":"   "}`
	rec, req, mw := authedRequest(t, env, user, http.MethodPatch, "/api/v1/sidebar/categories/c1", body, "id", "c1")
	mw(http.HandlerFunc(env.handler.UpdateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_UpdateCategory_DuplicateName(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-udup", Email: "udup@x.com", SystemRole: model.SystemRoleMember}
	env.categories.rows[env.categories.key(user.ID, "c1")] = &model.UserChannelCategory{UserID: user.ID, ID: "c1", Name: "Engineering", Position: 1}
	env.categories.rows[env.categories.key(user.ID, "c2")] = &model.UserChannelCategory{UserID: user.ID, ID: "c2", Name: "Support", Position: 2}

	body := `{"name":" engineering "}`
	rec, req, mw := authedRequest(t, env, user, http.MethodPatch, "/api/v1/sidebar/categories/c2", body, "id", "c2")
	mw(http.HandlerFunc(env.handler.UpdateCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "category name already exists") {
		t.Errorf("body = %s, want friendly duplicate message", rec.Body.String())
	}
}

// ----- DeleteCategory -----

func TestSidebarHandler_DeleteCategory_OK(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-dc", Email: "dc@x.com", SystemRole: model.SystemRoleMember}
	env.categories.rows[env.categories.key(user.ID, "c-del")] = &model.UserChannelCategory{UserID: user.ID, ID: "c-del", Name: "X"}
	rec, req, mw := authedRequest(t, env, user, http.MethodDelete, "/api/v1/sidebar/categories/c-del", "", "id", "c-del")
	mw(http.HandlerFunc(env.handler.DeleteCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if _, ok := env.categories.rows[env.categories.key(user.ID, "c-del")]; ok {
		t.Error("expected row to be removed")
	}
}

func TestSidebarHandler_DeleteCategory_MissingID(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-dmi", Email: "dmi@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodDelete, "/api/v1/sidebar/categories/", "", "id", "")
	mw(http.HandlerFunc(env.handler.DeleteCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_DeleteCategory_StoreError(t *testing.T) {
	env := setupSidebarHandler(t)
	env.categories.deleteErr = errors.New("boom")
	user := &model.User{ID: "u-derr", Email: "derr@x.com", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodDelete, "/api/v1/sidebar/categories/c1", "", "id", "c1")
	mw(http.HandlerFunc(env.handler.DeleteCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

// ----- Conversation favorite / category -----

func (env *sidebarEnv) addParticipant(convID, userID string) {
	if env.conversations.conversations == nil {
		env.conversations.conversations = map[string]*model.Conversation{}
	}
	conv, ok := env.conversations.conversations[convID]
	if !ok {
		conv = &model.Conversation{
			ID:             convID,
			Type:           model.ConversationTypeDM,
			ParticipantIDs: []string{},
		}
		env.conversations.conversations[convID] = conv
	}
	for _, id := range conv.ParticipantIDs {
		if id == userID {
			return
		}
	}
	conv.ParticipantIDs = append(conv.ParticipantIDs, userID)
	env.conversations.userConvs[userID] = append(env.conversations.userConvs[userID], &model.UserConversation{
		UserID:         userID,
		ConversationID: convID,
		Type:           conv.Type,
	})
}

func TestSidebarHandler_SetConversationFavorite_OK(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cv", Email: "cv@x.com", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", user.ID)

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/favorite", `{"favorite":true}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationFavorite)).ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestSidebarHandler_SetConversationFavorite_MissingID(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-mi", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations//favorite", `{"favorite":true}`, "id", "")
	mw(http.HandlerFunc(env.handler.SetConversationFavorite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetConversationFavorite_InvalidJSON(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-mi", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/favorite", `{not json`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationFavorite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetConversationFavorite_NonParticipantRejected(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-stranger", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", "u-other")

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/favorite", `{"favorite":true}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationFavorite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestSidebarHandler_SetConversationFavorite_NoServiceWired(t *testing.T) {
	// When convSvc is nil the endpoint must not crash; it returns 503.
	env := setupSidebarHandler(t)
	env.handler.convSvc = nil
	user := &model.User{ID: "u-1", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/favorite", `{"favorite":true}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationFavorite)).ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestSidebarHandler_SetConversationCategory_UserCategoryRejected(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cv", Email: "cv@x.com", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", user.ID)
	env.categories.rows[env.categories.key(user.ID, "cat-1")] = &model.UserChannelCategory{UserID: user.ID, ID: "cat-1", Name: "Eng"}

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{"categoryID":"cat-1"}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestSidebarHandler_SetConversationCategory_ClearAssignment(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cv", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", user.ID)

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{"categoryID":""}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestSidebarHandler_SetConversationCategory_StrangerCategoryRejected(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-cv", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", user.ID)
	env.categories.rows[env.categories.key("someone-else", "cat-other")] = &model.UserChannelCategory{UserID: "someone-else", ID: "cat-other"}

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{"categoryID":"cat-other"}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetChannelCategory_StoreErrorOnCategoryList(t *testing.T) {
	env := setupSidebarHandler(t)
	env.categories.listErr = errors.New("boom")
	user := &model.User{ID: "u-cv", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/channels/ch-1/category", `{"categoryID":"cat-1"}`, "id", "ch-1")
	_ = env.memberships.AddMember(context.Background(), &model.ChannelMembership{ChannelID: "ch-1", UserID: user.ID, Role: model.ChannelRoleMember}, nil)
	mw(http.HandlerFunc(env.handler.SetCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestSidebarHandler_SetConversationCategory_DoesNotConsultCategoryStoreWhenClearing(t *testing.T) {
	env := setupSidebarHandler(t)
	env.categories.listErr = errors.New("boom")
	user := &model.User{ID: "u-cv", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", user.ID)
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{"categoryID":""}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestSidebarHandler_SetConversationCategory_MissingID(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-mi", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations//category", `{"categoryID":""}`, "id", "")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetConversationCategory_InvalidJSON(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-mi", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{not json`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSidebarHandler_SetConversationCategory_NonParticipantRejected(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-stranger", SystemRole: model.SystemRoleMember}
	env.addParticipant("c-1", "u-other")
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{"categoryID":""}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestSidebarHandler_SetConversationCategory_NoServiceWired(t *testing.T) {
	env := setupSidebarHandler(t)
	env.handler.convSvc = nil
	user := &model.User{ID: "u-1", SystemRole: model.SystemRoleMember}
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/conversations/c-1/category", `{"categoryID":""}`, "id", "c-1")
	mw(http.HandlerFunc(env.handler.SetConversationCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func (s *stubSidebarCategoryStore) SetPositions(_ context.Context, userID string, positions map[string]int) error {
	for id, pos := range positions {
		if row, ok := s.rows[userID+"#"+id]; ok {
			row.Position = pos
		}
	}
	return nil
}

func TestSidebarHandler_Move(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-1", Email: "u1@test.com", SystemRole: model.SystemRoleMember}
	env.memberships.userChannels = []*model.UserChannel{
		{UserID: "u-1", ChannelID: "ch-a", ChannelName: "alpha", SidebarPosition: 1024},
		{UserID: "u-1", ChannelID: "ch-b", ChannelName: "beta", SidebarPosition: 2048},
	}

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/move",
		`{"itemType":"channel","itemID":"ch-b","section":"channels","afterType":"","afterID":""}`, "", "")
	mw(http.HandlerFunc(env.handler.Move)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Updates []store.SidebarRowUpdate `json:"updates"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Server-computed: ch-b lands at the top slot, midpoint below 1024.
	if len(res.Updates) != 1 || res.Updates[0].ItemID != "ch-b" || res.Updates[0].Position != 512 {
		t.Fatalf("updates = %+v", res.Updates)
	}
	if len(env.order.applied) != 1 {
		t.Fatalf("order writes = %d, want 1", len(env.order.applied))
	}
}

func TestSidebarHandler_MoveErrors(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-1", Email: "u1@test.com", SystemRole: model.SystemRoleMember}
	env.memberships.userChannels = []*model.UserChannel{
		{UserID: "u-1", ChannelID: "ch-a", ChannelName: "alpha", SidebarPosition: 1024},
	}

	// Unauthenticated.
	rec := httptest.NewRecorder()
	env.handler.Move(rec, httptest.NewRequest(http.MethodPut, "/api/v1/sidebar/move", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d", rec.Code)
	}

	// Malformed JSON.
	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/move", `{bad`, "", "")
	mw(http.HandlerFunc(env.handler.Move)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json status = %d", rec.Code)
	}

	// Validation failure → 400 invalid_move.
	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/move",
		`{"itemType":"bogus","itemID":"x","section":"channels"}`, "", "")
	mw(http.HandlerFunc(env.handler.Move)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_move") {
		t.Fatalf("invalid move status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Unknown item → 404.
	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/move",
		`{"itemType":"channel","itemID":"ch-missing","section":"channels"}`, "", "")
	mw(http.HandlerFunc(env.handler.Move)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing item status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Stale anchor → 409 sidebar_conflict (client refetches and retries).
	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/move",
		`{"itemType":"channel","itemID":"ch-a","section":"channels","afterType":"channel","afterID":"ch-gone"}`, "", "")
	mw(http.HandlerFunc(env.handler.Move)).ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "sidebar_conflict") {
		t.Fatalf("conflict status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Store failure → generic 500.
	env.memberships.userChannels = append(env.memberships.userChannels,
		&model.UserChannel{UserID: "u-1", ChannelID: "ch-b", ChannelName: "beta", SidebarPosition: 2048})
	env.order.err = errors.New("transact down")
	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/move",
		`{"itemType":"channel","itemID":"ch-b","section":"channels"}`, "", "")
	mw(http.HandlerFunc(env.handler.Move)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("store failure status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSidebarHandler_MoveCategory(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-1", Email: "u1@test.com", SystemRole: model.SystemRoleMember}
	env.categories.rows["u-1#cat-a"] = &model.UserChannelCategory{UserID: "u-1", ID: "cat-a", Name: "A", Position: 1}
	env.categories.rows["u-1#cat-b"] = &model.UserChannelCategory{UserID: "u-1", ID: "cat-b", Name: "B", Position: 2}

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/categories/cat-b/move",
		`{"afterID":""}`, "id", "cat-b")
	mw(http.HandlerFunc(env.handler.MoveCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Categories []model.UserChannelCategory `json:"categories"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Categories) != 2 || res.Categories[0].ID != "cat-b" || res.Categories[0].Position != 1024 {
		t.Fatalf("categories = %+v", res.Categories)
	}
}

func TestSidebarHandler_MoveCategoryErrors(t *testing.T) {
	env := setupSidebarHandler(t)
	user := &model.User{ID: "u-1", Email: "u1@test.com", SystemRole: model.SystemRoleMember}
	env.categories.rows["u-1#cat-a"] = &model.UserChannelCategory{UserID: "u-1", ID: "cat-a", Name: "A", Position: 1}

	rec := httptest.NewRecorder()
	env.handler.MoveCategory(rec, httptest.NewRequest(http.MethodPut, "/api/v1/sidebar/categories/cat-a/move", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d", rec.Code)
	}

	rec, req, mw := authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/categories//move", `{"afterID":""}`, "id", "")
	mw(http.HandlerFunc(env.handler.MoveCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing id status = %d", rec.Code)
	}

	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/categories/cat-a/move", `{bad`, "id", "cat-a")
	mw(http.HandlerFunc(env.handler.MoveCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json status = %d", rec.Code)
	}

	// Stale anchor → 409.
	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/categories/cat-a/move", `{"afterID":"cat-gone"}`, "id", "cat-a")
	mw(http.HandlerFunc(env.handler.MoveCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Unknown category → 404.
	rec, req, mw = authedRequest(t, env, user, http.MethodPut, "/api/v1/sidebar/categories/cat-x/move", `{"afterID":""}`, "id", "cat-x")
	mw(http.HandlerFunc(env.handler.MoveCategory)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing category status = %d body=%s", rec.Code, rec.Body.String())
	}
}
