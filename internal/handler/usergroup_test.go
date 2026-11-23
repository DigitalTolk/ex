package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// handlerUserGroupStore is service.UserGroupStore in memory.
type handlerUserGroupStore struct {
	groups  map[string]*model.UserGroupDetail
	handles map[string]string
	members map[string][]string
}

func (s *handlerUserGroupStore) ApplyUserGroupMembers(_ context.Context, groupID string, add, remove []string) error {
	cur := append(slices.Clone(s.members[groupID]), add...)
	s.members[groupID] = slices.DeleteFunc(cur, func(id string) bool { return slices.Contains(remove, id) })
	return nil
}

func (s *handlerUserGroupStore) UserGroupMemberIDs(_ context.Context, groupID string) ([]string, error) {
	return slices.Clone(s.members[groupID]), nil
}

func (s *handlerUserGroupStore) UserGroupIDsForUser(_ context.Context, userID string) ([]string, error) {
	var out []string
	for gid, members := range s.members {
		if slices.Contains(members, userID) {
			out = append(out, gid)
		}
	}
	return out, nil
}

func (s *handlerUserGroupStore) CreateUserGroup(_ context.Context, g *model.UserGroupDetail) error {
	if _, taken := s.handles[g.Handle]; taken {
		return store.ErrAlreadyExists
	}
	c := *g
	s.groups[g.ID], s.handles[g.Handle] = &c, g.ID
	return nil
}

func (s *handlerUserGroupStore) UpdateUserGroup(_ context.Context, g, previous *model.UserGroupDetail) error {
	delete(s.handles, previous.Handle)
	c := *g
	s.groups[g.ID], s.handles[g.Handle] = &c, g.ID
	return nil
}

func (s *handlerUserGroupStore) GetUserGroup(_ context.Context, id string) (*model.UserGroupDetail, error) {
	if g, ok := s.groups[id]; ok {
		c := *g
		c.MemberIDs = slices.Clone(g.MemberIDs)
		return &c, nil
	}
	return nil, store.ErrNotFound
}

func (s *handlerUserGroupStore) GetUserGroups(ctx context.Context, ids []string) ([]*model.UserGroupDetail, error) {
	var out []*model.UserGroupDetail
	for _, id := range ids {
		if g, err := s.GetUserGroup(ctx, id); err == nil {
			out = append(out, g)
		}
	}
	return out, nil
}

func (s *handlerUserGroupStore) ListUserGroups(ctx context.Context) ([]*model.UserGroupDetail, error) {
	var out []*model.UserGroupDetail
	for id := range s.groups {
		g, _ := s.GetUserGroup(ctx, id)
		out = append(out, g)
	}
	slices.SortFunc(out, func(a, b *model.UserGroupDetail) int { return strings.Compare(a.Handle, b.Handle) })
	return out, nil
}

func (s *handlerUserGroupStore) UserGroupHandleOwner(_ context.Context, handle string) (string, error) {
	if id, ok := s.handles[handle]; ok {
		return id, nil
	}
	return "", store.ErrNotFound
}

// handlerGroupSource is the Entra parent group, in memory.
type handlerGroupSource struct {
	mu     sync.Mutex
	groups []service.SourceGroup
}

func (s *handlerGroupSource) Fetch(context.Context) (service.SourceSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return service.SourceSnapshot{Groups: slices.Clone(s.groups)}, nil
}

func (s *handlerGroupSource) set(groups ...service.SourceGroup) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.groups = groups
}

// handlerRunLock is the sync's run guard, in memory. released is closed when
// the first run lets go of it, after everything that run wrote.
type handlerRunLock struct {
	mu       sync.Mutex
	holder   string
	released chan struct{}
	once     sync.Once
}

func (l *handlerRunLock) AcquireLock(_ context.Context, _, token string, _ time.Duration) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder != "" {
		return false, nil
	}
	l.holder = token
	return true, nil
}

func (l *handlerRunLock) ReleaseLock(_ context.Context, _, token string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder == token {
		l.holder = ""
	}
	l.once.Do(func() { close(l.released) })
	return nil
}

func handlerEntraGroup(id, name string, members ...string) service.SourceGroup {
	return service.SourceGroup{Key: "entra-group:" + id, ID: id, Name: name, MemberRefs: members}
}

type userGroupAPIFixture struct {
	router    http.Handler
	handler   *UserGroupHandler
	svc       *service.UserGroupService
	groups    *handlerUserGroupStore
	source    *handlerGroupSource
	cache     *mockCache
	adminJWT  string
	memberJWT string
	guestJWT  string
}

// newUserGroupAPIFixture syncs three Entra groups into ex, as the scheduled
// sync does at boot: @eng (the member and Bob), @eng-dope (the member) and
// @eng-platform (Bob).
func newUserGroupAPIFixture(t *testing.T) *userGroupAPIFixture {
	t.Helper()
	jwt := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	users := newMockUserStore()
	users.users["u-admin"] = &model.User{ID: "u-admin", SystemRole: model.SystemRoleAdmin, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users["u-member"] = &model.User{ID: "u-member", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC, MSObjectID: "oid-member"}
	users.users["u-bob"] = &model.User{ID: "u-bob", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC, MSObjectID: "oid-bob"}
	users.users["u-guest"] = &model.User{ID: "u-guest", SystemRole: model.SystemRoleGuest, Status: "active", AuthProvider: model.AuthProviderGuest}
	userSvc := service.NewUserService(users, newMockCache(), nil, nil)
	groups := &handlerUserGroupStore{groups: map[string]*model.UserGroupDetail{}, handles: map[string]string{}, members: map[string][]string{}}
	svc := service.NewUserGroupService(groups, userSvc, newHandlerBotStore(users), nil)
	cache := newMockCache()
	svc.SetSyncStatusCache(cache)
	source := &handlerGroupSource{}
	source.set(
		handlerEntraGroup("g-eng", "eng", "oid-member", "oid-bob"),
		handlerEntraGroup("g-dope", "eng-dope", "oid-member"),
		handlerEntraGroup("g-platform", "eng-platform", "oid-bob"),
	)
	n := 0
	lock := &handlerRunLock{released: make(chan struct{})}
	svc.SetSync(source, users, lock, time.Hour, func() string { n++; return string(rune('a' + n)) })

	// The boot sync runs on the background context (then waits an hour);
	// Sync now runs inline.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.RunSync(ctx, func(fn func()) { fn() })
		close(done)
	}()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case <-lock.released:
	case <-time.After(5 * time.Second):
		t.Fatal("the boot sync didn't finish")
	}

	h := NewUserGroupHandler(svc)
	f := &userGroupAPIFixture{handler: h, svc: svc, groups: groups, source: source, cache: cache}
	f.router = NewRouter(&Deps{
		Auth: &AuthHandler{}, User: NewUserHandler(userSvc, nil),
		Channel: &ChannelHandler{}, Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwt, AppVersion: "test", AllowOrigins: []string{"*"},
		UserGroup: h,
	})
	f.adminJWT, _ = jwt.GenerateAccessToken(users.users["u-admin"])
	f.memberJWT, _ = jwt.GenerateAccessToken(users.users["u-member"])
	f.guestJWT, _ = jwt.GenerateAccessToken(users.users["u-guest"])
	return f
}

func (f *userGroupAPIFixture) id(handle string) string { return f.groups.handles[handle] }

func (f *userGroupAPIFixture) do(method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func TestUserGroupHandler_Lifecycle(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	dope := f.id("eng-dope")

	rec := f.do(http.MethodGet, "/api/v1/usergroups", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); rec.Code != http.StatusOK || len(listed) != 3 {
		t.Fatalf("list = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroups/"+dope, f.memberJWT, "")
	got := decodeBody[model.UserGroupDetail](t, rec)
	if rec.Code != http.StatusOK || !slices.Equal(got.MemberIDs, []string{"u-member"}) || got.Source.ID != "g-dope" || got.Source.Kind != model.UserGroupSourceEntraGroup {
		t.Fatalf("get = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/users/u-member/usergroups", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); rec.Code != http.StatusOK || len(listed) != 2 {
		t.Fatalf("groups for the member = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+dope+"/disable", f.adminJWT, "")
	if rec.Code != http.StatusOK || !decodeBody[model.UserGroupDetail](t, rec).Disabled {
		t.Fatalf("disable = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroups?includeDisabled=true", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); len(listed) != 3 {
		t.Fatalf("list with disabled = %s", rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+dope+"/enable", f.adminJWT, "")
	if rec.Code != http.StatusOK || decodeBody[model.UserGroupDetail](t, rec).Disabled {
		t.Fatalf("enable = %d %s", rec.Code, rec.Body.String())
	}
}

func TestUserGroupHandler_SyncStatusAndSyncNow(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	rec := f.do(http.MethodGet, "/api/v1/usergroup-sync", f.adminJWT, "")
	st := decodeBody[model.UserGroupSyncStatus](t, rec)
	if rec.Code != http.StatusOK || !st.Configured || st.IntervalMinutes != 60 || st.LastSyncedAt == nil {
		t.Fatalf("sync status = %d %s", rec.Code, rec.Body.String())
	}

	// Right after the boot sync: the cooldown answers 429 with the status.
	rec = f.do(http.MethodPost, "/api/v1/usergroup-sync", f.adminJWT, "")
	if rec.Code != http.StatusTooManyRequests || decodeBody[model.UserGroupSyncStatus](t, rec).FinishedAt == nil {
		t.Fatalf("sync now in the cooldown = %d %s", rec.Code, rec.Body.String())
	}

	// Later, DOPE leaves the parent and Sync now applies it at once.
	past := time.Now().Add(-time.Hour)
	f.cache.values["usergroups:sync"] = &model.UserGroupSyncStatus{FinishedAt: &past}
	f.source.set(
		handlerEntraGroup("g-eng", "eng", "oid-member", "oid-bob"),
		handlerEntraGroup("g-platform", "eng-platform", "oid-bob"),
	)
	rec = f.do(http.MethodPost, "/api/v1/usergroup-sync", f.adminJWT, "")
	if rec.Code != http.StatusAccepted || !decodeBody[model.UserGroupSyncStatus](t, rec).Running {
		t.Fatalf("sync now = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroups/"+f.id("eng-dope"), f.adminJWT, "")
	if g := decodeBody[model.UserGroupDetail](t, rec); rec.Code != http.StatusOK || len(g.MemberIDs) != 0 || g.SyncState != model.UserGroupSyncSourceMissing {
		t.Fatalf("gone group = %d %s", rec.Code, rec.Body.String())
	}
}

func TestUserGroupHandler_SyncNowWithoutASource(t *testing.T) {
	jwt := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	users := newMockUserStore()
	admin := &model.User{ID: "u-admin", SystemRole: model.SystemRoleAdmin, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users[admin.ID] = admin
	groups := &handlerUserGroupStore{groups: map[string]*model.UserGroupDetail{}, handles: map[string]string{}, members: map[string][]string{}}
	svc := service.NewUserGroupService(groups, service.NewUserService(users, newMockCache(), nil, nil), newHandlerBotStore(users), nil)
	svc.SetSyncStatusCache(newMockCache())
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{}, Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwt, AppVersion: "test", AllowOrigins: []string{"*"}, UserGroup: NewUserGroupHandler(svc),
	})
	token, _ := jwt.GenerateAccessToken(admin)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/usergroup-sync", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("sync now without a source = %d %s, want 409", rec.Code, rec.Body.String())
	}
}

func TestUserGroupHandler_Refusals(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	id := f.id("eng-dope")

	cases := []struct {
		name, method, path, token, body string
		want                            int
	}{
		{"guest lists", http.MethodGet, "/api/v1/usergroups", f.guestJWT, "", http.StatusForbidden},
		{"guest gets", http.MethodGet, "/api/v1/usergroups/" + id, f.guestJWT, "", http.StatusForbidden},
		{"guest lists a user's groups", http.MethodGet, "/api/v1/users/u-bob/usergroups", f.guestJWT, "", http.StatusForbidden},
		{"member disables", http.MethodPost, "/api/v1/usergroups/" + id + "/disable", f.memberJWT, "", http.StatusForbidden},
		{"member reads the sync status", http.MethodGet, "/api/v1/usergroup-sync", f.memberJWT, "", http.StatusForbidden},
		{"member syncs", http.MethodPost, "/api/v1/usergroup-sync", f.memberJWT, "", http.StatusForbidden},
		{"missing group", http.MethodGet, "/api/v1/usergroups/group-nope", f.memberJWT, "", http.StatusNotFound},
		// Groups come from Microsoft 365 only: no way to create one, edit it,
		// edit its members or link it by hand.
		{"creating", http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"x","name":"X"}`, http.StatusMethodNotAllowed},
		{"editing", http.MethodPatch, "/api/v1/usergroups/" + id, f.adminJWT, `{"name":"x"}`, http.StatusMethodNotAllowed},
		{"checking a handle", http.MethodGet, "/api/v1/usergroup-handles/x", f.adminJWT, "", http.StatusNotFound},
		{"adding members", http.MethodPost, "/api/v1/usergroups/" + id + "/members", f.adminJWT, `{"userIds":["u-bob"]}`, http.StatusNotFound},
		{"linking", http.MethodPost, "/api/v1/usergroups/" + id + "/link", f.adminJWT, `{}`, http.StatusNotFound},
		{"approving a removal", http.MethodPost, "/api/v1/usergroups/" + id + "/approve-removal", f.adminJWT, "", http.StatusNotFound},
	}
	for _, tc := range cases {
		if rec := f.do(tc.method, tc.path, tc.token, tc.body); rec.Code != tc.want {
			t.Errorf("%s: %d %s, want %d", tc.name, rec.Code, rec.Body.String(), tc.want)
		}
	}
}

func TestUserGroupHandler_NoClaimsIsForbidden(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	rec := httptest.NewRecorder()
	f.handler.List(rec, httptest.NewRequest(http.MethodGet, "/api/v1/usergroups", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("List without claims = %d, want 403", rec.Code)
	}
}

func TestUserGroupHandler_Permissions(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	for token, want := range map[string]bool{f.adminJWT: true, f.memberJWT: false, f.guestJWT: false} {
		rec := f.do(http.MethodGet, "/api/v1/usergroup-permissions", token, "")
		if rec.Code != http.StatusOK || decodeBody[map[string]bool](t, rec)["canManage"] != want {
			t.Errorf("permissions = %d %s, want canManage %v", rec.Code, rec.Body.String(), want)
		}
	}
}
