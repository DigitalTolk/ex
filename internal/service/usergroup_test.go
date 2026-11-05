package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeUserGroupStore keeps groups in memory with the real store's version and
// handle-claim semantics.
type fakeUserGroupStore struct {
	groups    map[string]*model.UserGroupDetail
	handles   map[string]string
	createErr error
	updateErr error
	// conflicts makes the next N updates fail as a concurrent write would.
	conflicts int
	getErr    error
	batchErr  error
	listErr   error
	ownerErr  error
	updates   int
}

func newFakeUserGroupStore() *fakeUserGroupStore {
	return &fakeUserGroupStore{groups: map[string]*model.UserGroupDetail{}, handles: map[string]string{}}
}

func cloneGroup(g *model.UserGroupDetail) *model.UserGroupDetail {
	c := *g
	c.MemberIDs = slices.Clone(g.MemberIDs)
	return &c
}

func (f *fakeUserGroupStore) put(g *model.UserGroupDetail) {
	f.groups[g.ID] = cloneGroup(g)
	f.handles[g.Handle] = g.ID
}

func (f *fakeUserGroupStore) CreateUserGroup(_ context.Context, g *model.UserGroupDetail) error {
	if f.createErr != nil {
		return f.createErr
	}
	if _, taken := f.handles[g.Handle]; taken {
		return store.ErrAlreadyExists
	}
	g.Version = 1
	f.put(g)
	return nil
}

func (f *fakeUserGroupStore) UpdateUserGroup(_ context.Context, g *model.UserGroupDetail, previousHandle string, expected int64) error {
	f.updates++
	if f.updateErr != nil {
		return f.updateErr
	}
	if f.conflicts > 0 {
		f.conflicts--
		f.groups[g.ID].Version++
		return store.ErrUserGroupChanged
	}
	cur, ok := f.groups[g.ID]
	if !ok || cur.Version != expected {
		return store.ErrUserGroupChanged
	}
	if owner, taken := f.handles[g.Handle]; taken && owner != g.ID {
		return store.ErrAlreadyExists
	}
	delete(f.handles, previousHandle)
	g.Version = expected + 1
	f.put(g)
	return nil
}

func (f *fakeUserGroupStore) GetUserGroup(_ context.Context, id string) (*model.UserGroupDetail, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	g, ok := f.groups[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return cloneGroup(g), nil
}

func (f *fakeUserGroupStore) GetUserGroups(_ context.Context, ids []string) ([]*model.UserGroupDetail, error) {
	if f.batchErr != nil {
		return nil, f.batchErr
	}
	var out []*model.UserGroupDetail
	for _, id := range ids {
		if g, ok := f.groups[id]; ok {
			out = append(out, cloneGroup(g))
		}
	}
	return out, nil
}

func (f *fakeUserGroupStore) ListUserGroups(context.Context) ([]*model.UserGroupDetail, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []*model.UserGroupDetail
	for _, g := range f.groups {
		out = append(out, cloneGroup(g))
	}
	slices.SortFunc(out, func(a, b *model.UserGroupDetail) int { return strings.Compare(a.Handle, b.Handle) })
	return out, nil
}

func (f *fakeUserGroupStore) UserGroupHandleOwner(_ context.Context, handle string) (string, error) {
	if f.ownerErr != nil {
		return "", f.ownerErr
	}
	id, ok := f.handles[handle]
	if !ok {
		return "", store.ErrNotFound
	}
	return id, nil
}

// fakeGroupPeople is the people directory: active members unless marked.
type fakeGroupPeople struct {
	users map[string]*model.User
	err   error
	calls int
}

func (f *fakeGroupPeople) GetBatch(_ context.Context, ids []string) ([]*model.User, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	var out []*model.User
	for _, id := range ids {
		if u, ok := f.users[id]; ok {
			out = append(out, u)
		}
	}
	return out, nil
}

type fakeGroupSettings struct{ managers model.UserGroupManagers }

func (f *fakeGroupSettings) Effective(context.Context) *model.WorkspaceSettings {
	return &model.WorkspaceSettings{UserGroupManagers: f.managers}
}

type fakeBotNames struct {
	names map[string]string
	err   error
}

func (f *fakeBotNames) UsernameOwner(_ context.Context, username string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	if id, ok := f.names[username]; ok {
		return id, nil
	}
	return "", store.ErrNotFound
}

type userGroupFixture struct {
	svc      *UserGroupService
	store    *fakeUserGroupStore
	people   *fakeGroupPeople
	settings *fakeGroupSettings
	bots     *fakeBotNames
	pub      *mockPublisher
}

func newUserGroupFixture() *userGroupFixture {
	people := &fakeGroupPeople{users: map[string]*model.User{}}
	for _, id := range []string{"u-1", "u-2", "u-3", "u-admin", "u-member"} {
		people.users[id] = &model.User{ID: id, SystemRole: model.SystemRoleMember, Status: "active"}
	}
	people.users["u-guest"] = &model.User{ID: "u-guest", SystemRole: model.SystemRoleGuest, Status: "active"}
	people.users["u-bot"] = &model.User{ID: "u-bot", IsBot: true, SystemRole: model.SystemRoleMember, Status: "active"}
	people.users["u-gone"] = &model.User{ID: "u-gone", SystemRole: model.SystemRoleMember, Status: "deactivated"}
	f := &userGroupFixture{
		store:    newFakeUserGroupStore(),
		people:   people,
		settings: &fakeGroupSettings{},
		bots:     &fakeBotNames{names: map[string]string{"deploybot": "b-1"}},
		pub:      newMockPublisher(),
	}
	f.svc = NewUserGroupService(f.store, f.people, f.settings, f.bots, f.pub)
	f.svc.now = func() time.Time { return time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC) }
	return f
}

var (
	ugAdmin  = UserGroupActor{ID: "u-admin", Role: model.SystemRoleAdmin}
	ugMember = UserGroupActor{ID: "u-member", Role: model.SystemRoleMember}
	ugGuest  = UserGroupActor{ID: "u-guest", Role: model.SystemRoleGuest}
)

func (f *userGroupFixture) create(t *testing.T, handle string, members ...string) *model.UserGroupDetail {
	t.Helper()
	g, err := f.svc.Create(context.Background(), ugAdmin, UserGroupInput{Handle: handle, Name: "Group " + handle, MemberIDs: members})
	if err != nil {
		t.Fatalf("Create %s: %v", handle, err)
	}
	return g
}

// changedEvents lists the group IDs of the usergroup.changed events published.
func (f *userGroupFixture) changedEvents() []string {
	var out []string
	for _, p := range f.pub.published {
		if p.channel == pubsub.UserEvents() && p.event.Type == events.EventUserGroupChanged {
			out = append(out, string(p.event.Data))
		}
	}
	return out
}

func TestUserGroups_CreateNormalizesAndPublishes(t *testing.T) {
	f := newUserGroupFixture()
	g, err := f.svc.Create(context.Background(), ugAdmin, UserGroupInput{
		Handle: " @OnCall ", Name: "  On-call engineers ", Description: " Pages ", MemberIDs: []string{"u-1", "u-2", "u-1", " "},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(g.ID, model.UserGroupIDPrefix) || g.Handle != "oncall" || g.Name != "On-call engineers" || g.Description != "Pages" {
		t.Fatalf("group = %+v", g)
	}
	if !slices.Equal(g.MemberIDs, []string{"u-1", "u-2"}) || g.MemberCount != 2 || g.CreatedBy != "u-admin" {
		t.Fatalf("members = %v (%d), createdBy %q", g.MemberIDs, g.MemberCount, g.CreatedBy)
	}
	if got := f.changedEvents(); len(got) != 1 || !strings.Contains(got[0], g.ID) {
		t.Fatalf("usergroup.changed events = %v", got)
	}
}

func TestUserGroups_Permissions(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")

	// Guests and anonymous callers can't even read.
	for _, actor := range []UserGroupActor{ugGuest, {Role: model.SystemRoleAdmin}} {
		_, listErr := f.svc.List(ctx, actor, false)
		_, getErr := f.svc.Get(ctx, actor, g.ID)
		_, forErr := f.svc.GroupsForUser(ctx, actor, "u-1")
		_, availErr := f.svc.HandleAvailable(ctx, actor, "x")
		for name, err := range map[string]error{"List": listErr, "Get": getErr, "GroupsForUser": forErr, "HandleAvailable": availErr} {
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("%s by %+v = %v, want forbidden", name, actor, err)
			}
		}
	}

	// Members read, but manage only when the workspace allows it.
	if _, err := f.svc.List(ctx, ugMember, false); err != nil {
		t.Fatalf("member List: %v", err)
	}
	manage := func(actor UserGroupActor) map[string]error {
		_, createErr := f.svc.Create(ctx, actor, UserGroupInput{Handle: "x" + actor.ID, Name: "X"})
		name := "Renamed"
		_, updateErr := f.svc.Update(ctx, actor, g.ID, UserGroupPatch{Name: &name})
		_, addErr := f.svc.AddMembers(ctx, actor, g.ID, []string{"u-2"})
		_, removeErr := f.svc.RemoveMember(ctx, actor, g.ID, "u-2")
		_, enableErr := f.svc.SetEnabled(ctx, actor, g.ID, true)
		return map[string]error{"Create": createErr, "Update": updateErr, "AddMembers": addErr, "RemoveMember": removeErr, "SetEnabled": enableErr}
	}
	for name, err := range manage(ugMember) {
		if !errors.Is(err, ErrForbidden) {
			t.Errorf("member %s with admins-only = %v, want forbidden", name, err)
		}
	}
	if f.svc.CanManage(ctx, ugMember) || !f.svc.CanManage(ctx, ugAdmin) || f.svc.CanManage(ctx, ugGuest) {
		t.Error("CanManage disagrees with the admins-only setting")
	}
	f.settings.managers = model.UserGroupManagersMembers
	for name, err := range manage(ugMember) {
		if err != nil {
			t.Errorf("member %s with members allowed = %v", name, err)
		}
	}
	for name, err := range manage(ugGuest) {
		if !errors.Is(err, ErrForbidden) {
			t.Errorf("guest %s with members allowed = %v, want forbidden", name, err)
		}
	}
}

func TestUserGroups_CreateValidates(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	long := strings.Repeat("x", limits.MaxUserGroupNameChars+1)
	longDesc := strings.Repeat("x", limits.MaxUserGroupDescriptionChars+1)
	cases := map[string]UserGroupInput{
		"bad handle":       {Handle: "-x", Name: "X"},
		"short handle":     {Handle: "x", Name: "X"},
		"reserved handle":  {Handle: "here", Name: "X"},
		"everyone":         {Handle: "everyone", Name: "X"},
		"blank name":       {Handle: "ok", Name: "  "},
		"long name":        {Handle: "ok", Name: long},
		"long description": {Handle: "ok", Name: "X", Description: longDesc},
		"guest member":     {Handle: "ok", Name: "X", MemberIDs: []string{"u-guest"}},
		"bot member":       {Handle: "ok", Name: "X", MemberIDs: []string{"u-bot"}},
		"inactive member":  {Handle: "ok", Name: "X", MemberIDs: []string{"u-gone"}},
		"unknown member":   {Handle: "ok", Name: "X", MemberIDs: []string{"u-nobody"}},
	}
	for name, in := range cases {
		if _, err := f.svc.Create(ctx, ugAdmin, in); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: Create = %v, want validation error", name, err)
		}
	}
	if len(f.store.groups) != 0 {
		t.Fatalf("invalid input stored %d groups", len(f.store.groups))
	}
}

func TestUserGroups_HandleUniqueAcrossGroupsAndBots(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.create(t, "oncall")
	for _, handle := range []string{"oncall", "deploybot"} {
		if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: handle, Name: "X"}); !errors.Is(err, ErrUserGroupHandleTaken) {
			t.Errorf("Create %q = %v, want handle taken", handle, err)
		}
	}
	// Taken between the check and the write.
	f.store.createErr = store.ErrAlreadyExists
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "fresh", Name: "X"}); !errors.Is(err, ErrUserGroupHandleTaken) {
		t.Errorf("racing Create = %v, want handle taken", err)
	}
	f.store.createErr = errors.New("dynamo down")
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "fresh", Name: "X"}); err == nil || errors.Is(err, ErrUserGroupHandleTaken) {
		t.Errorf("failed Create = %v, want a wrapped store error", err)
	}
}

func TestUserGroups_HandleAvailable(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.create(t, "oncall")
	for handle, want := range map[string]bool{"oncall": false, "@OnCall": false, "deploybot": false, "all": false, "x": false, "design": true} {
		got, err := f.svc.HandleAvailable(ctx, ugMember, handle)
		if err != nil || got != want {
			t.Errorf("HandleAvailable(%q) = %v, %v; want %v", handle, got, err, want)
		}
	}
	f.store.ownerErr = errors.New("boom")
	if _, err := f.svc.HandleAvailable(ctx, ugMember, "design"); err == nil {
		t.Error("HandleAvailable swallowed a store error")
	}
	f.store.ownerErr = nil
	f.bots.err = errors.New("boom")
	if _, err := f.svc.HandleAvailable(ctx, ugMember, "design"); err == nil {
		t.Error("HandleAvailable swallowed a bot-store error")
	}
}

func TestUserGroups_UpdateDetails(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	f.create(t, "sre")
	handle, name, desc := "On-Call", "Pager crew", "Who gets paged"
	got, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Handle: &handle, Name: &name, Description: &desc})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got.Handle != "on-call" || got.Name != name || got.Description != desc || !slices.Equal(got.MemberIDs, []string{"u-1"}) {
		t.Fatalf("updated = %+v", got)
	}
	if _, held := f.store.handles["oncall"]; held {
		t.Error("the previous handle is still claimed")
	}
	// Keeping its own handle is fine; taking another group's is not.
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Handle: &handle}); err != nil {
		t.Errorf("re-saving own handle: %v", err)
	}
	taken := "sre"
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Handle: &taken}); !errors.Is(err, ErrUserGroupHandleTaken) {
		t.Errorf("taking sre = %v, want handle taken", err)
	}
	bad, blank, long := "-", " ", strings.Repeat("d", limits.MaxUserGroupDescriptionChars+1)
	for label, patch := range map[string]UserGroupPatch{"handle": {Handle: &bad}, "name": {Name: &blank}, "description": {Description: &long}} {
		if _, err := f.svc.Update(ctx, ugAdmin, g.ID, patch); !errors.Is(err, ErrValidation) {
			t.Errorf("bad %s: Update = %v, want validation error", label, err)
		}
	}
	f.store.ownerErr = errors.New("boom")
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Handle: &handle}); err == nil {
		t.Error("Update swallowed a handle-check error")
	}
}

func TestUserGroups_UpdateLosesHandleRaceAtWrite(t *testing.T) {
	f := newUserGroupFixture()
	g := f.create(t, "oncall")
	f.store.updateErr = store.ErrAlreadyExists
	handle := "fresh"
	if _, err := f.svc.Update(context.Background(), ugAdmin, g.ID, UserGroupPatch{Handle: &handle}); !errors.Is(err, ErrUserGroupHandleTaken) {
		t.Fatalf("Update = %v, want handle taken", err)
	}
}

func TestUserGroups_Members(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	got, err := f.svc.AddMembers(ctx, ugAdmin, g.ID, []string{"u-2", "u-1", "u-3"})
	if err != nil || !slices.Equal(got.MemberIDs, []string{"u-1", "u-2", "u-3"}) || got.MemberCount != 3 {
		t.Fatalf("AddMembers = %v, %v", got, err)
	}
	if _, err := f.svc.AddMembers(ctx, ugAdmin, g.ID, []string{"u-guest"}); !errors.Is(err, ErrValidation) {
		t.Errorf("adding a guest = %v, want validation error", err)
	}
	got, err = f.svc.RemoveMember(ctx, ugAdmin, g.ID, "u-2")
	if err != nil || !slices.Equal(got.MemberIDs, []string{"u-1", "u-3"}) || got.MemberCount != 2 {
		t.Fatalf("RemoveMember = %v, %v", got, err)
	}
	f.people.err = errors.New("users down")
	if _, err := f.svc.AddMembers(ctx, ugAdmin, g.ID, []string{"u-2"}); err == nil {
		t.Error("AddMembers swallowed a user-read error")
	}
	if _, err := f.svc.AddMembers(ctx, ugAdmin, "group-missing", []string{"u-2"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("AddMembers to a missing group = %v, want not found", err)
	}
}

func TestUserGroups_MemberCapIsOneHundred(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	ids := make([]string, limits.MaxUserGroupMembers+1)
	for i := range ids {
		ids[i] = fmt.Sprintf("p-%03d", i)
		f.people.users[ids[i]] = &model.User{ID: ids[i], SystemRole: model.SystemRoleMember, Status: "active"}
	}
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "big", Name: "Big", MemberIDs: ids}); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create with %d members = %v, want validation error", len(ids), err)
	}
	g := f.create(t, "full", ids[:limits.MaxUserGroupMembers]...)
	if g.MemberCount != limits.MaxUserGroupMembers {
		t.Fatalf("MemberCount = %d", g.MemberCount)
	}
	if _, err := f.svc.AddMembers(ctx, ugAdmin, g.ID, ids[limits.MaxUserGroupMembers:]); !errors.Is(err, ErrValidation) {
		t.Fatalf("adding the 101st member = %v, want validation error", err)
	}
}

func TestUserGroups_ConcurrentWritesRetryOnTheLatestVersion(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	f.store.conflicts = userGroupWriteAttempts - 1
	if _, err := f.svc.AddMembers(ctx, ugAdmin, g.ID, []string{"u-2"}); err != nil {
		t.Fatalf("AddMembers after %d conflicts: %v", userGroupWriteAttempts-1, err)
	}
	f.store.conflicts = userGroupWriteAttempts
	if _, err := f.svc.AddMembers(ctx, ugAdmin, g.ID, []string{"u-3"}); err == nil || !errors.Is(err, store.ErrUserGroupChanged) {
		t.Fatalf("AddMembers past the retry budget = %v, want the conflict", err)
	}
}

func TestUserGroups_SetEnabledAndListing(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	oncall := f.create(t, "oncall", "u-1")
	f.create(t, "sre", "u-1")
	disabled, err := f.svc.SetEnabled(ctx, ugAdmin, oncall.ID, false)
	if err != nil || !disabled.Disabled || !slices.Equal(disabled.MemberIDs, []string{"u-1"}) {
		t.Fatalf("disable = %+v, %v", disabled, err)
	}
	handles := func(groups []*model.UserGroup) []string {
		var out []string
		for _, g := range groups {
			out = append(out, g.Handle)
		}
		return out
	}
	if got, _ := f.svc.List(ctx, ugMember, false); !slices.Equal(handles(got), []string{"sre"}) {
		t.Errorf("List = %v, want enabled only", handles(got))
	}
	if got, _ := f.svc.List(ctx, ugMember, true); !slices.Equal(handles(got), []string{"oncall", "sre"}) {
		t.Errorf("List(includeDisabled) = %v", handles(got))
	}
	if got, _ := f.svc.GroupsForUser(ctx, ugMember, "u-1"); !slices.Equal(handles(got), []string{"sre"}) {
		t.Errorf("GroupsForUser = %v, want enabled groups only", handles(got))
	}
	if got, err := f.svc.SetEnabled(ctx, ugAdmin, oncall.ID, true); err != nil || got.Disabled {
		t.Fatalf("enable = %+v, %v", got, err)
	}
	if got, err := f.svc.Get(ctx, ugMember, oncall.ID); err != nil || got.Disabled {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	f.store.listErr = errors.New("boom")
	if _, err := f.svc.List(ctx, ugMember, false); err == nil {
		t.Error("List swallowed a store error")
	}
	if _, err := f.svc.GroupsForUser(ctx, ugMember, "u-1"); err == nil {
		t.Error("GroupsForUser swallowed a store error")
	}
}

func TestUserGroups_GetErrors(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	if _, err := f.svc.Get(ctx, ugMember, "group-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get missing = %v, want not found", err)
	}
	f.store.getErr = errors.New("boom")
	if _, err := f.svc.Get(ctx, ugMember, "group-nope"); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("Get on a store error = %v", err)
	}
}

func TestUserGroups_RemoveUserFromAllGroups(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	a := f.create(t, "oncall", "u-1", "u-2")
	b := f.create(t, "sre", "u-2")
	c := f.create(t, "design", "u-3")
	if err := f.svc.RemoveUserFromAllGroups(ctx, "u-2"); err != nil {
		t.Fatalf("RemoveUserFromAllGroups: %v", err)
	}
	for id, want := range map[string][]string{a.ID: {"u-1"}, b.ID: {}, c.ID: {"u-3"}} {
		if got := f.store.groups[id].MemberIDs; !slices.Equal(got, want) {
			t.Errorf("group %s members = %v, want %v", id, got, want)
		}
	}
	f.store.updateErr = errors.New("boom")
	if err := f.svc.RemoveUserFromAllGroups(ctx, "u-1"); err == nil {
		t.Error("RemoveUserFromAllGroups swallowed a write error")
	}
	f.store.listErr = errors.New("boom")
	if err := f.svc.RemoveUserFromAllGroups(ctx, "u-1"); err == nil {
		t.Error("RemoveUserFromAllGroups swallowed a list error")
	}
}

func TestUserGroups_MentionedMembers(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	oncall := f.create(t, "oncall", "u-1", "u-2")
	off := f.create(t, "off", "u-3")
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, off.ID, false); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.MentionedMembers(ctx, "u-3", []string{oncall.ID, off.ID, "group-unknown"})
	if err != nil || len(got) != 1 || !slices.Equal(got[oncall.ID], []string{"u-1", "u-2"}) {
		t.Fatalf("MentionedMembers = %v, %v; want only the enabled group", got, err)
	}
	// A webhook's sentinel author is nobody: not a guest.
	if got, err := f.svc.MentionedMembers(ctx, WebhookAuthorID, []string{oncall.ID}); err != nil || len(got) != 1 {
		t.Fatalf("webhook MentionedMembers = %v, %v", got, err)
	}
	if got, err := f.svc.MentionedMembers(ctx, "u-guest", []string{oncall.ID}); err != nil || got != nil {
		t.Fatalf("guest MentionedMembers = %v, %v; want nothing", got, err)
	}
	if got, err := f.svc.MentionedMembers(ctx, "u-1", nil); err != nil || got != nil {
		t.Fatalf("no groups = %v, %v", got, err)
	}
	f.store.batchErr = errors.New("boom")
	if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{oncall.ID}); err == nil {
		t.Error("MentionedMembers swallowed a store error")
	}
	f.people.err = errors.New("users down")
	if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{oncall.ID}); err == nil {
		t.Error("MentionedMembers swallowed an author-read error")
	}
}

func TestUserGroups_EnabledHandles(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	on := f.create(t, "oncall")
	off := f.create(t, "off")
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, off.ID, false); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.EnabledHandles(ctx, []string{on.ID, off.ID})
	if err != nil || len(got) != 1 || got[on.ID] != "oncall" {
		t.Fatalf("EnabledHandles = %v, %v", got, err)
	}
	if got, err := f.svc.EnabledHandles(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("EnabledHandles(nil) = %v, %v", got, err)
	}
	f.store.batchErr = errors.New("boom")
	if _, err := f.svc.EnabledHandles(ctx, []string{on.ID}); err == nil {
		t.Error("EnabledHandles swallowed a store error")
	}
}

func TestUserGroups_Wired(t *testing.T) {
	if err := newUserGroupFixture().svc.Wired(); err != nil {
		t.Fatalf("Wired = %v", err)
	}
	err := (&UserGroupService{}).Wired()
	if err == nil || !strings.Contains(err.Error(), "user group service: not wired:") {
		t.Fatalf("zero Wired = %v", err)
	}
}
