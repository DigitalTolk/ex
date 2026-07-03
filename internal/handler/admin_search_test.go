package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
)

// stubReporter satisfies SearchStatusReporter without a live cluster.
type stubReporter struct {
	health    map[string]any
	healthErr error
	stats     []search.IndexStat
	statsErr  error
}

func (s *stubReporter) ClusterHealth(_ context.Context) (map[string]any, error) {
	return s.health, s.healthErr
}
func (s *stubReporter) IndexStats(_ context.Context) ([]search.IndexStat, error) {
	return s.stats, s.statsErr
}

// stubReindexSources is the minimal slice search.Reindexer needs from
// its source. Used so the admin tests can drive a real Reindexer
// without standing up DDB-backed adapters.
type stubReindexSources struct {
	users    []*model.User
	channels []*model.Channel
	convs    []*model.Conversation
	msgs     map[string][]*model.Message
}

func (s *stubReindexSources) ListUsers(context.Context) ([]*model.User, error) {
	return s.users, nil
}
func (s *stubReindexSources) ListChannels(context.Context) ([]*model.Channel, error) {
	return s.channels, nil
}
func (s *stubReindexSources) ListConversations(context.Context) ([]*model.Conversation, error) {
	return s.convs, nil
}
func (s *stubReindexSources) ListMessages(_ context.Context, parent string) ([]*model.Message, error) {
	return s.msgs[parent], nil
}

// makeAdminWithSearch builds an AdminHandler wired to a sniffable
// reporter + a real Reindexer pointed at an httptest cluster so we
// can exercise the admin search routes end-to-end.
func makeAdminWithSearch(t *testing.T, reporter SearchStatusReporter) (*AdminHandler, *httptest.Server) {
	t.Helper()
	h, _ := setupAdminHandler(t)
	bulkHits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_bulk" {
			bulkHits++
			_, _ = w.Write([]byte(`{"errors":false,"items":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	client := search.NewClient(srv.URL)
	rx := search.NewReindexer(client, &stubReindexSources{
		users: []*model.User{{ID: "u-1"}},
	})
	h.SetSearch(reporter, rx)
	return h, srv
}

func TestAdminHandler_SearchStatus_NotConfigured(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchStatus))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/search/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["configured"] != false {
		t.Errorf("configured = %v, want false", got["configured"])
	}
}

func TestAdminHandler_SearchStatus_NotAdmin(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	user := &model.User{ID: "u", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchStatus))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/search/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestAdminHandler_SearchStatus_OK(t *testing.T) {
	reporter := &stubReporter{
		health: map[string]any{"status": "yellow"},
		stats:  []search.IndexStat{{Name: "ex_users", Health: "green", Docs: 5}},
	}
	h, srv := makeAdminWithSearch(t, reporter)
	defer srv.Close()
	_, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchStatus))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/search/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if got["configured"] != true {
		t.Errorf("configured = %v, want true", got["configured"])
	}
	cluster := got["cluster"].(map[string]any)
	if cluster["status"] != "yellow" {
		t.Errorf("cluster status = %v", cluster["status"])
	}
	indices := got["indices"].([]any)
	if len(indices) != 1 {
		t.Errorf("indices len = %d", len(indices))
	}
	if _, ok := got["reindex"]; !ok {
		t.Error("reindex progress missing")
	}
}

func TestAdminHandler_SearchStatus_SurfacesErrors(t *testing.T) {
	reporter := &stubReporter{
		healthErr: errors.New("cluster down"),
		statsErr:  errors.New("indices unreachable"),
	}
	h, srv := makeAdminWithSearch(t, reporter)
	defer srv.Close()
	_, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchStatus))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/search/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if got["clusterError"] == nil || got["indicesError"] == nil {
		t.Errorf("expected error fields, got %+v", got)
	}
}

func TestAdminHandler_StartSearchReindex_NotConfigured(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.StartSearchReindex))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/search/reindex", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestAdminHandler_StartSearchReindex_NotAdmin(t *testing.T) {
	reporter := &stubReporter{}
	h, srv := makeAdminWithSearch(t, reporter)
	defer srv.Close()
	_, jwtMgr := setupAdminHandler(t)
	user := &model.User{ID: "u", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.StartSearchReindex))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/search/reindex", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestAdminHandler_StartSearchReindex_AcceptedThenConflict(t *testing.T) {
	reporter := &stubReporter{}
	h, srv := makeAdminWithSearch(t, reporter)
	defer srv.Close()
	_, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.StartSearchReindex))

	// First call kicks off a run.
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/admin/search/reindex", nil)
	req1.Header.Set("Authorization", "Bearer "+token)
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusAccepted {
		t.Errorf("first status = %d, want 202", rec1.Code)
	}

	// Force the reindexer into the running state for the next call
	// — without this, the goroutine from the first call may finish
	// before the second request hits the handler, in which case the
	// second start would also be 202.
	h.reindexer.Start(context.Background(), nowUnix)
}

// TestAdminHandler_StartSearchReindex_ConflictWhenRunning deterministically
// drives the 409 "already running" arm: a real reindex is started against a
// cluster whose /_bulk blocks, so it stays running while the handler's own
// Start call observes running==true and returns false → 409.
func TestAdminHandler_StartSearchReindex_ConflictWhenRunning(t *testing.T) {
	h, _ := setupAdminHandler(t)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_bulk" {
			<-release // hold the reindex open so it stays "running"
		}
		_, _ = w.Write([]byte(`{"errors":false,"items":[]}`))
	}))
	defer srv.Close()
	defer close(release)

	client := search.NewClient(srv.URL)
	rx := search.NewReindexer(client, &stubReindexSources{users: []*model.User{{ID: "u-1"}}})
	h.SetSearch(&stubReporter{}, rx)

	// Begin a run; it will block in /_bulk and stay running.
	if !rx.Start(context.Background(), nowUnix) {
		t.Fatal("initial Start should succeed")
	}

	_, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.StartSearchReindex))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/search/reindex", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (already running); body=%s", rec.Code, rec.Body.String())
	}
}

func TestNowUnix(t *testing.T) {
	if nowUnix() <= 0 {
		t.Error("nowUnix should return positive seconds")
	}
}

// stubMappingReb is a MappingRebuildController fake so the admin routes can be
// exercised without Redis or a live cluster.
type stubMappingReb struct {
	started   bool
	startErr  error
	status    search.MappingRebuildStatus
	statusErr error
}

func (s *stubMappingReb) Start(context.Context, func() int64) (bool, error) {
	return s.started, s.startErr
}
func (s *stubMappingReb) Status(context.Context) (search.MappingRebuildStatus, error) {
	return s.status, s.statusErr
}

func mappingRebuildRequest(t *testing.T, h *AdminHandler, jwtMgr *auth.JWTManager, user *model.User) *httptest.ResponseRecorder {
	t.Helper()
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.StartSearchMappingRebuild))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/search/rebuild-mapping", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestAdminHandler_StartMappingRebuild_NotAdmin(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	h.SetMappingRebuilder(&stubMappingReb{started: true})
	rec := mappingRebuildRequest(t, h, jwtMgr, &model.User{ID: "u", SystemRole: model.SystemRoleMember})
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestAdminHandler_StartMappingRebuild_NotConfigured(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t) // no rebuilder wired
	rec := mappingRebuildRequest(t, h, jwtMgr, &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin})
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestAdminHandler_StartMappingRebuild_Accepted(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	h.SetMappingRebuilder(&stubMappingReb{started: true, status: search.MappingRebuildStatus{Running: true, StartedAt: 42}})
	rec := mappingRebuildRequest(t, h, jwtMgr, &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	var got search.MappingRebuildStatus
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Running || got.StartedAt != 42 {
		t.Errorf("body = %+v, want running with startedAt 42", got)
	}
}

func TestAdminHandler_StartMappingRebuild_Conflict(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	h.SetMappingRebuilder(&stubMappingReb{started: false}) // another instance holds the lock
	rec := mappingRebuildRequest(t, h, jwtMgr, &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin})
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

func TestAdminHandler_StartMappingRebuild_CoordinationError(t *testing.T) {
	h, jwtMgr := setupAdminHandler(t)
	h.SetMappingRebuilder(&stubMappingReb{startErr: errors.New("redis down")})
	rec := mappingRebuildRequest(t, h, jwtMgr, &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin})
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	// The raw Redis error must not leak to the client.
	if body := rec.Body.String(); strings.Contains(body, "redis down") {
		t.Errorf("500 body leaked the internal error: %s", body)
	}
}

func TestAdminHandler_SearchStatus_IncludesMappingRebuild(t *testing.T) {
	reporter := &stubReporter{health: map[string]any{"status": "green"}}
	h, srv := makeAdminWithSearch(t, reporter)
	defer srv.Close()
	h.SetMappingRebuilder(&stubMappingReb{status: search.MappingRebuildStatus{Users: 9, Channels: 4}})
	_, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchStatus))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/search/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	mr, ok := got["mappingRebuild"].(map[string]any)
	if !ok {
		t.Fatalf("mappingRebuild missing from status: %v", got)
	}
	if mr["users"].(float64) != 9 {
		t.Errorf("mappingRebuild.users = %v, want 9", mr["users"])
	}
}

func TestAdminHandler_SearchStatus_MappingRebuildError(t *testing.T) {
	reporter := &stubReporter{health: map[string]any{"status": "green"}}
	h, srv := makeAdminWithSearch(t, reporter)
	defer srv.Close()
	h.SetMappingRebuilder(&stubMappingReb{statusErr: errors.New("redis get failed")})
	_, jwtMgr := setupAdminHandler(t)
	admin := &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin}
	token := makeTokenForUser(jwtMgr, admin)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchStatus))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/search/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var got map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if _, ok := got["mappingRebuildError"]; !ok {
		t.Errorf("expected mappingRebuildError in status, got %v", got)
	}
}
