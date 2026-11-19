package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
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

type userGroupAPIFixture struct {
	router    http.Handler
	handler   *UserGroupHandler
	svc       *service.UserGroupService
	groups    *handlerUserGroupStore
	adminJWT  string
	memberJWT string
	guestJWT  string
}

// newUserGroupAPIFixture syncs three people's departments into groups, as the
// directory sweep does: @engineering (the member and Bob), @dope (the
// member) and @platform (Bob).
func newUserGroupAPIFixture(t *testing.T) *userGroupAPIFixture {
	t.Helper()
	jwt := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	users := newMockUserStore()
	users.users["u-admin"] = &model.User{ID: "u-admin", SystemRole: model.SystemRoleAdmin, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users["u-member"] = &model.User{ID: "u-member", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users["u-bob"] = &model.User{ID: "u-bob", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	users.users["u-guest"] = &model.User{ID: "u-guest", SystemRole: model.SystemRoleGuest, Status: "active", AuthProvider: model.AuthProviderGuest}
	userSvc := service.NewUserService(users, newMockCache(), nil, nil)
	groups := &handlerUserGroupStore{groups: map[string]*model.UserGroupDetail{}, handles: map[string]string{}, members: map[string][]string{}}
	svc := service.NewUserGroupService(groups, userSvc, newHandlerBotStore(users), nil)
	svc.SetSyncStatusCache(newMockCache())
	svc.SyncDirectoryGroups(context.Background(), []service.DirectoryPerson{
		{UserID: "u-member", Department: "Engineering - DOPE"},
		{UserID: "u-bob", Department: "Engineering - Platform"},
	})
	h := NewUserGroupHandler(svc)
	f := &userGroupAPIFixture{handler: h, svc: svc, groups: groups}
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
	dope := f.id("dope")

	rec := f.do(http.MethodGet, "/api/v1/usergroups", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); rec.Code != http.StatusOK || len(listed) != 3 {
		t.Fatalf("list = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroups/"+dope, f.memberJWT, "")
	got := decodeBody[model.UserGroupDetail](t, rec)
	if rec.Code != http.StatusOK || !slices.Equal(got.MemberIDs, []string{"u-member"}) || got.Source.Squad != "DOPE" || got.Source.Department != "Engineering" {
		t.Fatalf("get = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroup-handles/dope", f.memberJWT, "")
	if rec.Code != http.StatusOK || decodeBody[map[string]bool](t, rec)["available"] {
		t.Fatalf("handle check = %d %s, want taken", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroup-handles/design", f.memberJWT, "")
	if !decodeBody[map[string]bool](t, rec)["available"] {
		t.Fatalf("handle check = %s, want available", rec.Body.String())
	}

	rec = f.do(http.MethodPatch, "/api/v1/usergroups/"+dope, f.adminJWT, `{"name":"Pager crew"}`)
	if g := decodeBody[model.UserGroupDetail](t, rec); rec.Code != http.StatusOK || g.Name != "Pager crew" || !g.AdminEdited {
		t.Fatalf("update = %d %s", rec.Code, rec.Body.String())
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

func TestUserGroupHandler_SyncStatusAndHeldRemovals(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	rec := f.do(http.MethodGet, "/api/v1/usergroup-sync", f.adminJWT, "")
	if st := decodeBody[model.UserGroupSyncStatus](t, rec); rec.Code != http.StatusOK || st.LastSyncedAt == nil || st.Readable != 2 {
		t.Fatalf("sync status = %d %s", rec.Code, rec.Body.String())
	}

	// DOPE disappears from Microsoft 365: its member is kept until an admin
	// approves.
	f.svc.SyncDirectoryGroups(context.Background(), []service.DirectoryPerson{
		{UserID: "u-member", Department: "Engineering"},
		{UserID: "u-bob", Department: "Engineering - Platform"},
	})
	dope := f.id("dope")
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+dope+"/approve-removal", f.adminJWT, "")
	if g := decodeBody[model.UserGroupDetail](t, rec); rec.Code != http.StatusOK || !g.RemovalApproved || g.SyncState != model.UserGroupSyncSourceMissing {
		t.Fatalf("approve = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+f.id("platform")+"/approve-removal", f.adminJWT, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("approving a group with nothing held = %d %s, want 400", rec.Code, rec.Body.String())
	}
}

func TestUserGroupHandler_Refusals(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	id := f.id("dope")

	cases := []struct {
		name, method, path, token, body string
		want                            int
	}{
		{"guest lists", http.MethodGet, "/api/v1/usergroups", f.guestJWT, "", http.StatusForbidden},
		{"guest gets", http.MethodGet, "/api/v1/usergroups/" + id, f.guestJWT, "", http.StatusForbidden},
		{"guest checks a handle", http.MethodGet, "/api/v1/usergroup-handles/x", f.guestJWT, "", http.StatusForbidden},
		{"guest lists a user's groups", http.MethodGet, "/api/v1/users/u-bob/usergroups", f.guestJWT, "", http.StatusForbidden},
		{"bad update body", http.MethodPatch, "/api/v1/usergroups/" + id, f.adminJWT, `{`, http.StatusBadRequest},
		{"member updates", http.MethodPatch, "/api/v1/usergroups/" + id, f.memberJWT, `{"name":"x"}`, http.StatusForbidden},
		{"member disables", http.MethodPost, "/api/v1/usergroups/" + id + "/disable", f.memberJWT, "", http.StatusForbidden},
		{"member reads the sync status", http.MethodGet, "/api/v1/usergroup-sync", f.memberJWT, "", http.StatusForbidden},
		{"member approves a removal", http.MethodPost, "/api/v1/usergroups/" + id + "/approve-removal", f.memberJWT, "", http.StatusForbidden},
		{"missing group", http.MethodGet, "/api/v1/usergroups/group-nope", f.memberJWT, "", http.StatusNotFound},
		// Groups come from Microsoft 365 only: no way to create one, edit its
		// members, link or sync it by hand.
		{"creating", http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"x","name":"X"}`, http.StatusMethodNotAllowed},
		{"adding members", http.MethodPost, "/api/v1/usergroups/" + id + "/members", f.adminJWT, `{"userIds":["u-bob"]}`, http.StatusNotFound},
		{"linking", http.MethodPost, "/api/v1/usergroups/" + id + "/link", f.adminJWT, `{}`, http.StatusNotFound},
		{"syncing", http.MethodPost, "/api/v1/usergroups/" + id + "/sync", f.adminJWT, `{}`, http.StatusNotFound},
		{"searching Microsoft 365", http.MethodGet, "/api/v1/usergroup-sources/microsoft?q=x", f.adminJWT, "", http.StatusNotFound},
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
