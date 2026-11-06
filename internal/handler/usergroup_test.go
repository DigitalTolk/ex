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
	adminJWT  string
	memberJWT string
	guestJWT  string
}

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
	svc.SetMicrosoft(service.UserGroupMicrosoftDeps{
		Directory: handlerEntraDirectory{}, Index: handlerEntraIndex{}, Accounts: newMockUserStore(),
		Locker: handlerLocker{}, Cache: newMockCache(), IndexTTL: time.Hour, NewToken: func() string { return "t" },
	})
	h := NewUserGroupHandler(svc)
	f := &userGroupAPIFixture{handler: h}
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

func (f *userGroupAPIFixture) do(method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func TestUserGroupHandler_Lifecycle(t *testing.T) {
	f := newUserGroupAPIFixture(t)

	rec := f.do(http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"oncall","name":"On-call","entraGroupId":"entra-sre"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	g := decodeBody[model.UserGroupDetail](t, rec)
	if g.Handle != "oncall" || g.EntraGroupID != "entra-sre" || !slices.Equal(g.MemberIDs, []string{"u-member"}) {
		t.Fatalf("created = %+v", g)
	}

	rec = f.do(http.MethodGet, "/api/v1/usergroups", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); rec.Code != http.StatusOK || len(listed) != 1 || listed[0].ID != g.ID {
		t.Fatalf("list = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroups/"+g.ID, f.memberJWT, "")
	if got := decodeBody[model.UserGroupDetail](t, rec); rec.Code != http.StatusOK || got.ID != g.ID || !slices.Equal(got.MemberIDs, []string{"u-member"}) {
		t.Fatalf("get = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroup-handles/oncall", f.memberJWT, "")
	if rec.Code != http.StatusOK || decodeBody[map[string]bool](t, rec)["available"] {
		t.Fatalf("handle check = %d %s, want taken", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroup-handles/design", f.memberJWT, "")
	if !decodeBody[map[string]bool](t, rec)["available"] {
		t.Fatalf("handle check = %s, want available", rec.Body.String())
	}

	rec = f.do(http.MethodPatch, "/api/v1/usergroups/"+g.ID, f.adminJWT, `{"name":"Pager crew"}`)
	if rec.Code != http.StatusOK || decodeBody[model.UserGroupDetail](t, rec).Name != "Pager crew" {
		t.Fatalf("update = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/users/u-member/usergroups", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); rec.Code != http.StatusOK || len(listed) != 1 {
		t.Fatalf("groups for the member = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+g.ID+"/disable", f.adminJWT, "")
	if rec.Code != http.StatusOK || !decodeBody[model.UserGroupDetail](t, rec).Disabled {
		t.Fatalf("disable = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroups?includeDisabled=true", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); len(listed) != 1 || !listed[0].Disabled {
		t.Fatalf("list with disabled = %s", rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+g.ID+"/enable", f.adminJWT, "")
	if rec.Code != http.StatusOK || decodeBody[model.UserGroupDetail](t, rec).Disabled {
		t.Fatalf("enable = %d %s", rec.Code, rec.Body.String())
	}
}

func TestUserGroupHandler_Refusals(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	rec := f.do(http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"oncall","name":"On-call","entraGroupId":"entra-sre"}`)
	id := decodeBody[model.UserGroupDetail](t, rec).ID

	cases := []struct {
		name, method, path, token, body string
		want                            int
	}{
		{"guest lists", http.MethodGet, "/api/v1/usergroups", f.guestJWT, "", http.StatusForbidden},
		{"guest gets", http.MethodGet, "/api/v1/usergroups/" + id, f.guestJWT, "", http.StatusForbidden},
		{"guest checks a handle", http.MethodGet, "/api/v1/usergroup-handles/x", f.guestJWT, "", http.StatusForbidden},
		{"guest lists a user's groups", http.MethodGet, "/api/v1/users/u-bob/usergroups", f.guestJWT, "", http.StatusForbidden},
		{"member creates", http.MethodPost, "/api/v1/usergroups", f.memberJWT, `{"handle":"sre","name":"SRE","entraGroupId":"entra-oncall"}`, http.StatusForbidden},
		{"bad create body", http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{`, http.StatusBadRequest},
		{"no Microsoft 365 group", http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"sre","name":"SRE"}`, http.StatusBadRequest},
		{"missing Microsoft 365 group", http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"sre","name":"SRE","entraGroupId":"entra-gone"}`, http.StatusNotFound},
		{"taken handle", http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"oncall","name":"Again","entraGroupId":"entra-oncall"}`, http.StatusConflict},
		{"bad update body", http.MethodPatch, "/api/v1/usergroups/" + id, f.adminJWT, `{`, http.StatusBadRequest},
		{"member updates", http.MethodPatch, "/api/v1/usergroups/" + id, f.memberJWT, `{"name":"x"}`, http.StatusForbidden},
		{"member disables", http.MethodPost, "/api/v1/usergroups/" + id + "/disable", f.memberJWT, "", http.StatusForbidden},
		{"missing group", http.MethodGet, "/api/v1/usergroups/group-nope", f.memberJWT, "", http.StatusNotFound},
		// Members come from Microsoft 365 only: there is no way to edit them.
		{"adding members", http.MethodPost, "/api/v1/usergroups/" + id + "/members", f.adminJWT, `{"userIds":["u-bob"]}`, http.StatusNotFound},
		{"removing a member", http.MethodDelete, "/api/v1/usergroups/" + id + "/members/u-member", f.adminJWT, "", http.StatusNotFound},
		{"unlinking", http.MethodPost, "/api/v1/usergroups/" + id + "/unlink", f.adminJWT, "", http.StatusNotFound},
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

// --- Microsoft 365 links ---

// handlerEntraDirectory: "entra-oncall" holds Bob and someone without an ex
// account; "entra-sre" holds the member.
type handlerEntraDirectory struct{}

var handlerEntraMembers = map[string][]string{"entra-oncall": {"o-bob", "o-stranger"}, "entra-sre": {"o-member"}}

func (handlerEntraDirectory) SearchGroups(context.Context, string) ([]model.EntraGroup, error) {
	return []model.EntraGroup{{ID: "entra-oncall", DisplayName: "On-call engineers", Kind: "security"}}, nil
}

func (handlerEntraDirectory) GetGroup(_ context.Context, id string) (*model.EntraGroup, error) {
	if _, ok := handlerEntraMembers[id]; !ok {
		return nil, service.ErrEntraGroupNotFound
	}
	return &model.EntraGroup{ID: id, DisplayName: "Group " + id, Kind: "security"}, nil
}

func (handlerEntraDirectory) GroupUserIDs(_ context.Context, id string) ([]string, error) {
	members, ok := handlerEntraMembers[id]
	if !ok {
		return nil, service.ErrEntraGroupNotFound
	}
	return slices.Clone(members), nil
}

type handlerEntraIndex struct{}

func (handlerEntraIndex) Lookup(context.Context, []string) (map[string]string, bool, error) {
	return map[string]string{"o-bob": "u-bob", "o-member": "u-member"}, true, nil
}
func (handlerEntraIndex) Replace(context.Context, map[string]string, time.Duration) error { return nil }
func (handlerEntraIndex) Add(context.Context, string, string) error                       { return nil }

type handlerLocker struct{}

func (handlerLocker) AcquireLock(context.Context, string, string, time.Duration) (bool, error) {
	return true, nil
}
func (handlerLocker) ReleaseLock(context.Context, string, string) error { return nil }

func TestUserGroupHandler_MicrosoftLinkFlow(t *testing.T) {
	f := newUserGroupAPIFixture(t)

	rec := f.do(http.MethodGet, "/api/v1/usergroup-permissions", f.adminJWT, "")
	if perms := decodeBody[map[string]bool](t, rec); !perms["canLinkMicrosoft"] {
		t.Fatalf("admin permissions = %v", perms)
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroup-sources/microsoft?q=on", f.adminJWT, "")
	if found := decodeBody[[]model.EntraGroup](t, rec); rec.Code != http.StatusOK || len(found) != 1 || found[0].ID != "entra-oncall" {
		t.Fatalf("search = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/usergroup-sources/microsoft/entra-oncall/preview", f.adminJWT, "")
	if p := decodeBody[model.UserGroupLinkPreview](t, rec); rec.Code != http.StatusOK || p.Users != 2 || p.ToAdd != 1 || p.Skipped != 1 {
		t.Fatalf("preview = %d %s", rec.Code, rec.Body.String())
	}

	rec = f.do(http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"oncall","name":"On-call","entraGroupId":"entra-sre"}`)
	id := decodeBody[model.UserGroupDetail](t, rec).ID
	rec = f.do(http.MethodGet, "/api/v1/usergroup-sources/microsoft/entra-oncall/preview?groupId="+id, f.adminJWT, "")
	if p := decodeBody[model.UserGroupLinkPreview](t, rec); rec.Code != http.StatusOK || p.ToAdd != 1 || p.ToRemove != 1 {
		t.Fatalf("preview for the group = %d %s", rec.Code, rec.Body.String())
	}
	// Changing the Microsoft 365 group replaces the members.
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+id+"/link", f.adminJWT, `{"entraGroupId":"entra-oncall"}`)
	if g := decodeBody[model.UserGroupDetail](t, rec); rec.Code != http.StatusOK || g.EntraGroupID != "entra-oncall" || !slices.Equal(g.MemberIDs, []string{"u-bob"}) {
		t.Fatalf("link = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodGet, "/api/v1/users/u-bob/usergroups", f.memberJWT, "")
	if listed := decodeBody[[]model.UserGroup](t, rec); rec.Code != http.StatusOK || len(listed) != 1 {
		t.Fatalf("groups for bob = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/usergroups/"+id+"/sync", f.adminJWT, `{"applyRemovals":false}`)
	if rec.Code != http.StatusOK || decodeBody[model.UserGroupDetail](t, rec).SyncedAt == nil {
		t.Fatalf("sync = %d %s", rec.Code, rec.Body.String())
	}
}

func TestUserGroupHandler_MicrosoftRefusals(t *testing.T) {
	f := newUserGroupAPIFixture(t)
	rec := f.do(http.MethodPost, "/api/v1/usergroups", f.adminJWT, `{"handle":"oncall","name":"On-call","entraGroupId":"entra-sre"}`)
	id := decodeBody[model.UserGroupDetail](t, rec).ID

	cases := []struct {
		name, method, path, token, body string
		want                            int
	}{
		{"member searches", http.MethodGet, "/api/v1/usergroup-sources/microsoft?q=x", f.memberJWT, "", http.StatusForbidden},
		{"member previews", http.MethodGet, "/api/v1/usergroup-sources/microsoft/entra-oncall/preview", f.memberJWT, "", http.StatusForbidden},
		{"missing Entra group", http.MethodGet, "/api/v1/usergroup-sources/microsoft/entra-gone/preview", f.adminJWT, "", http.StatusNotFound},
		{"bad link body", http.MethodPost, "/api/v1/usergroups/" + id + "/link", f.adminJWT, `{`, http.StatusBadRequest},
		{"member links", http.MethodPost, "/api/v1/usergroups/" + id + "/link", f.memberJWT, `{"entraGroupId":"entra-oncall"}`, http.StatusForbidden},
		{"bad sync body", http.MethodPost, "/api/v1/usergroups/" + id + "/sync", f.adminJWT, ``, http.StatusBadRequest},
		{"member syncs", http.MethodPost, "/api/v1/usergroups/" + id + "/sync", f.memberJWT, `{}`, http.StatusForbidden},
		{"sync a missing group", http.MethodPost, "/api/v1/usergroups/group-nope/sync", f.adminJWT, `{}`, http.StatusNotFound},
	}
	for _, tc := range cases {
		if rec := f.do(tc.method, tc.path, tc.token, tc.body); rec.Code != tc.want {
			t.Errorf("%s: %d %s, want %d", tc.name, rec.Code, rec.Body.String(), tc.want)
		}
	}
}
