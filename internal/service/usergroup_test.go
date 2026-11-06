package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeUserGroupStore keeps groups in memory with the real store's version and
// claim semantics: a row per group and a row per member.
type fakeUserGroupStore struct {
	mu        sync.Mutex
	groups    map[string]*model.UserGroupDetail
	members   map[string][]string
	handles   map[string]string
	entra     map[string]string
	createErr error
	updateErr error
	// conflicts makes the next N updates fail as a concurrent write would.
	conflicts  int
	getErr     error
	batchErr   error
	listErr    error
	ownerErr   error
	applyErr   error
	membersErr error
	forUserErr error
	updates    int
	// beforeApply runs as a member write starts (what happens meanwhile).
	beforeApply func()
}

func newFakeUserGroupStore() *fakeUserGroupStore {
	return &fakeUserGroupStore{
		groups: map[string]*model.UserGroupDetail{}, members: map[string][]string{},
		handles: map[string]string{}, entra: map[string]string{},
	}
}

func cloneGroup(g *model.UserGroupDetail) *model.UserGroupDetail {
	c := *g
	c.MemberIDs = slices.Clone(g.MemberIDs)
	return &c
}

// put stores g's row; the row never carries members.
func (f *fakeUserGroupStore) put(g *model.UserGroupDetail) {
	c := cloneGroup(g)
	c.MemberIDs = nil
	f.groups[g.ID] = c
	f.handles[g.Handle] = g.ID
}

func (f *fakeUserGroupStore) CreateUserGroup(_ context.Context, g *model.UserGroupDetail) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return f.createErr
	}
	if _, taken := f.handles[g.Handle]; taken {
		return store.ErrAlreadyExists
	}
	if _, taken := f.entra[g.EntraGroupID]; taken {
		return store.ErrEntraGroupLinked
	}
	f.entra[g.EntraGroupID] = g.ID
	g.Version = 1
	f.put(g)
	return nil
}

func (f *fakeUserGroupStore) UpdateUserGroup(_ context.Context, g, previous *model.UserGroupDetail) error {
	f.mu.Lock()
	defer f.mu.Unlock()
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
	if !ok || cur.Version != previous.Version {
		return store.ErrUserGroupChanged
	}
	if owner, taken := f.handles[g.Handle]; taken && owner != g.ID {
		return store.ErrAlreadyExists
	}
	if g.EntraGroupID != previous.EntraGroupID {
		if owner, taken := f.entra[g.EntraGroupID]; taken && owner != g.ID {
			return store.ErrEntraGroupLinked
		}
		f.entra[g.EntraGroupID] = g.ID
		delete(f.entra, previous.EntraGroupID)
	}
	delete(f.handles, previous.Handle)
	g.Version = previous.Version + 1
	f.put(g)
	return nil
}

func (f *fakeUserGroupStore) GetUserGroup(_ context.Context, id string) (*model.UserGroupDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
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
	f.mu.Lock()
	defer f.mu.Unlock()
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
	f.mu.Lock()
	defer f.mu.Unlock()
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
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ownerErr != nil {
		return "", f.ownerErr
	}
	id, ok := f.handles[handle]
	if !ok {
		return "", store.ErrNotFound
	}
	return id, nil
}

func (f *fakeUserGroupStore) ApplyUserGroupMembers(_ context.Context, groupID string, add, remove []string) error {
	if f.beforeApply != nil {
		f.beforeApply()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.applyErr != nil {
		return f.applyErr
	}
	cur := f.members[groupID]
	for _, id := range add {
		if !slices.Contains(cur, id) {
			cur = append(cur, id)
		}
	}
	f.members[groupID] = slices.DeleteFunc(cur, func(id string) bool { return slices.Contains(remove, id) })
	return nil
}

func (f *fakeUserGroupStore) UserGroupMemberIDs(_ context.Context, groupID string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.membersErr != nil {
		return nil, f.membersErr
	}
	return slices.Clone(f.members[groupID]), nil
}

func (f *fakeUserGroupStore) UserGroupIDsForUser(_ context.Context, userID string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.forUserErr != nil {
		return nil, f.forUserErr
	}
	var out []string
	for gid, members := range f.members {
		if slices.Contains(members, userID) {
			out = append(out, gid)
		}
	}
	slices.Sort(out)
	return out, nil
}

// fakeGroupPeople is the people directory: active members unless marked.
type fakeGroupPeople struct {
	mu    sync.Mutex
	users map[string]*model.User
	err   error
	calls int
}

func (f *fakeGroupPeople) GetBatch(_ context.Context, ids []string) ([]*model.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
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

// fakeCopies is the shared copy in memory, with injectable failures.
type fakeCopies struct {
	mu        sync.Mutex
	groups    map[string]*model.UserGroupDetail
	getErr    error
	putErr    error
	forgetErr error
	forgotten []string
}

func newFakeCopies() *fakeCopies { return &fakeCopies{groups: map[string]*model.UserGroupDetail{}} }

func (c *fakeCopies) Get(_ context.Context, ids []string) (map[string]*model.UserGroupDetail, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.getErr != nil {
		return nil, c.getErr
	}
	out := map[string]*model.UserGroupDetail{}
	for _, id := range ids {
		if g, ok := c.groups[id]; ok {
			out[id] = cloneGroup(g)
		}
	}
	return out, nil
}

func (c *fakeCopies) Put(_ context.Context, g *model.UserGroupDetail) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.putErr != nil {
		return c.putErr
	}
	c.groups[g.ID] = cloneGroup(g)
	return nil
}

func (c *fakeCopies) Forget(_ context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.forgotten = append(c.forgotten, id)
	if c.forgetErr != nil {
		return c.forgetErr
	}
	delete(c.groups, id)
	return nil
}

// current is the copy a reader would be served now, if any.
func (c *fakeCopies) current(id string) *model.UserGroupDetail {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.groups[id]
}

// drop empties the copy, so reads go to the store.
func (c *fakeCopies) drop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.groups = map[string]*model.UserGroupDetail{}
}

type userGroupFixture struct {
	copies   *fakeCopies
	svc      *UserGroupService
	store    *fakeUserGroupStore
	people   *fakeGroupPeople
	bots     *fakeBotNames
	pub      *mockPublisher
	dir      *fakeEntraDirectory
	index    *fakeEntraIndex
	locker   *fakeGroupSyncLocker
	accounts *pagedAccounts
	cache    *mockCache
}

// newUserGroupFixture wires the service with Microsoft 365 in memory. Users
// u-1, u-2, u-3, u-admin and u-member are active members; u-guest, u-bot and
// u-gone can't be group members.
func newUserGroupFixture() *userGroupFixture {
	people := &fakeGroupPeople{users: map[string]*model.User{}}
	for _, id := range []string{"u-1", "u-2", "u-3", "u-admin", "u-member"} {
		people.users[id] = &model.User{ID: id, SystemRole: model.SystemRoleMember, Status: "active"}
	}
	people.users["u-guest"] = &model.User{ID: "u-guest", SystemRole: model.SystemRoleGuest, Status: "active"}
	people.users["u-bot"] = &model.User{ID: "u-bot", IsBot: true, SystemRole: model.SystemRoleMember, Status: "active"}
	people.users["u-gone"] = &model.User{ID: "u-gone", SystemRole: model.SystemRoleMember, Status: "deactivated"}
	f := &userGroupFixture{
		store:  newFakeUserGroupStore(),
		people: people,
		bots:   &fakeBotNames{names: map[string]string{"deploybot": "b-1"}},
		pub:    newMockPublisher(),
		dir: &fakeEntraDirectory{
			groups: map[string]*model.EntraGroup{}, members: map[string][]string{}, membersErr: map[string]error{},
		},
		index:    &fakeEntraIndex{m: map[string]string{}, complete: true},
		locker:   &fakeGroupSyncLocker{held: map[string]bool{}},
		accounts: &pagedAccounts{},
		cache:    newMockCache(),
	}
	f.svc = NewUserGroupService(f.store, f.people, f.bots, f.pub)
	f.svc.now = func() time.Time { return time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC) }
	f.copies = newFakeCopies()
	f.svc.SetCopies(f.copies)
	f.svc.SetMicrosoft(UserGroupMicrosoftDeps{
		Directory: f.dir, Index: f.index, Accounts: f.accounts, Locker: f.locker,
		Cache: f.cache, IndexTTL: time.Hour, NewToken: func() string { return "tok" },
	})
	return f
}

var (
	ugAdmin  = UserGroupActor{ID: "u-admin", Role: model.SystemRoleAdmin}
	ugMember = UserGroupActor{ID: "u-member", Role: model.SystemRoleMember}
	ugGuest  = UserGroupActor{ID: "u-guest", Role: model.SystemRoleGuest}
)

// msGroup puts a Microsoft 365 group "ms-<handle>" holding these ex users
// (their object IDs are their user IDs) and returns its ID.
func (f *userGroupFixture) msGroup(handle string, members ...string) string {
	id := "ms-" + handle
	f.dir.mu.Lock()
	f.dir.groups[id] = &model.EntraGroup{ID: id, DisplayName: "MS " + handle, Kind: "security"}
	f.dir.members[id] = slices.Clone(members)
	f.dir.mu.Unlock()
	f.index.mu.Lock()
	for _, m := range members {
		f.index.m[m] = m
	}
	f.index.mu.Unlock()
	return id
}

// create makes group @handle from a Microsoft 365 group holding members.
func (f *userGroupFixture) create(t *testing.T, handle string, members ...string) *model.UserGroupDetail {
	t.Helper()
	g, err := f.svc.Create(context.Background(), ugAdmin, UserGroupInput{Handle: handle, Name: "Group " + handle, EntraGroupID: f.msGroup(handle, members...)})
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
	entra := f.msGroup("oncall", "u-1", "u-2", "u-1", "u-guest", "u-bot", "u-gone", "u-nobody")
	g, err := f.svc.Create(context.Background(), ugAdmin, UserGroupInput{
		Handle: " @OnCall ", Name: "  On-call engineers ", Description: " Pages ", EntraGroupID: " " + entra + " ",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(g.ID, model.UserGroupIDPrefix) || g.Handle != "oncall" || g.Name != "On-call engineers" || g.Description != "Pages" {
		t.Fatalf("group = %+v", g)
	}
	if !slices.Equal(g.MemberIDs, []string{"u-1", "u-2"}) || g.MemberCount != 2 || g.CreatedBy != "u-admin" {
		t.Fatalf("members = %v (%d), createdBy %q; want the eligible Microsoft 365 members", g.MemberIDs, g.MemberCount, g.CreatedBy)
	}
	if g.EntraGroupID != entra || g.EntraGroupName != "MS oncall" || g.SyncedAt == nil || g.SyncSkipped != 5 {
		t.Fatalf("link = %+v", g)
	}
	if got := f.store.members[g.ID]; !slices.Equal(got, []string{"u-1", "u-2"}) {
		t.Fatalf("member rows = %v", got)
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

	// Members read; only admins create and edit.
	if _, err := f.svc.List(ctx, ugMember, false); err != nil {
		t.Fatalf("member List: %v", err)
	}
	for _, actor := range []UserGroupActor{ugMember, ugGuest, {Role: model.SystemRoleAdmin}} {
		_, createErr := f.svc.Create(ctx, actor, UserGroupInput{Handle: "x" + actor.ID, Name: "X", EntraGroupID: f.msGroup("x")})
		name := "Renamed"
		_, updateErr := f.svc.Update(ctx, actor, g.ID, UserGroupPatch{Name: &name})
		_, enableErr := f.svc.SetEnabled(ctx, actor, g.ID, true)
		for op, err := range map[string]error{"Create": createErr, "Update": updateErr, "SetEnabled": enableErr} {
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("%+v %s = %v, want forbidden", actor, op, err)
			}
		}
	}
	if f.svc.CanManage(ugMember) || !f.svc.CanManage(ugAdmin) || f.svc.CanManage(ugGuest) {
		t.Error("CanManage disagrees with admins-only")
	}
}

func TestUserGroups_CreateValidates(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	entra := f.msGroup("src", "u-1")
	long := strings.Repeat("x", limits.MaxUserGroupNameChars+1)
	longDesc := strings.Repeat("x", limits.MaxUserGroupDescriptionChars+1)
	cases := map[string]UserGroupInput{
		"bad handle":          {Handle: "-x", Name: "X", EntraGroupID: entra},
		"short handle":        {Handle: "x", Name: "X", EntraGroupID: entra},
		"reserved handle":     {Handle: "here", Name: "X", EntraGroupID: entra},
		"everyone":            {Handle: "everyone", Name: "X", EntraGroupID: entra},
		"blank name":          {Handle: "ok", Name: "  ", EntraGroupID: entra},
		"long name":           {Handle: "ok", Name: long, EntraGroupID: entra},
		"long description":    {Handle: "ok", Name: "X", Description: longDesc, EntraGroupID: entra},
		"no Microsoft group":  {Handle: "ok", Name: "X"},
		"blank Microsoft one": {Handle: "ok", Name: "X", EntraGroupID: "  "},
	}
	for name, in := range cases {
		if _, err := f.svc.Create(ctx, ugAdmin, in); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: Create = %v, want validation error", name, err)
		}
	}
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "ok", Name: "X", EntraGroupID: "ms-missing"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("Create from a missing Microsoft 365 group = %v, want not found", err)
	}
	if len(f.store.groups) != 0 {
		t.Fatalf("invalid input stored %d groups", len(f.store.groups))
	}
}

func TestUserGroups_CreateFailures(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	entra := f.msGroup("oncall", "u-1")
	f.store.createErr = errors.New("dynamo down")
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "oncall", Name: "X", EntraGroupID: entra}); err == nil || errors.Is(err, ErrUserGroupHandleTaken) {
		t.Errorf("failed Create = %v, want a wrapped store error", err)
	}
	f.store.createErr = nil

	// The members can't be written: the group exists, says its sync failed,
	// and the next sync writes them.
	f.store.applyErr = errors.New("dynamo down")
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "oncall", Name: "X", EntraGroupID: entra}); err == nil {
		t.Fatal("Create swallowed a member write error")
	}
	var g *model.UserGroupDetail
	for _, row := range f.store.groups {
		g = row
	}
	if g == nil || g.SyncState != model.UserGroupSyncError {
		t.Fatalf("group after a failed member write = %+v", g)
	}
	f.store.applyErr = nil
	if got, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err != nil || !slices.Equal(got.MemberIDs, []string{"u-1"}) || got.SyncState != "" {
		t.Fatalf("the next sync = %+v, %v; want the members written", got, err)
	}

	f.dir.getErr = errors.New("graph down")
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "sre", Name: "X", EntraGroupID: entra}); err == nil {
		t.Error("Create swallowed a Graph error")
	}
}

func TestUserGroups_HandleUniqueAcrossGroupsAndBots(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.create(t, "oncall")
	entra := f.msGroup("other")
	for _, handle := range []string{"oncall", "deploybot"} {
		if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: handle, Name: "X", EntraGroupID: entra}); !errors.Is(err, ErrUserGroupHandleTaken) {
			t.Errorf("Create %q = %v, want handle taken", handle, err)
		}
	}
	// Taken between the check and the write.
	f.store.createErr = store.ErrAlreadyExists
	if _, err := f.svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "fresh", Name: "X", EntraGroupID: entra}); !errors.Is(err, ErrUserGroupHandleTaken) {
		t.Errorf("racing Create = %v, want handle taken", err)
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
	if got.Handle != "on-call" || got.Name != name || got.Description != desc || got.MemberCount != 1 {
		t.Fatalf("updated = %+v", got)
	}
	if _, held := f.store.handles["oncall"]; held {
		t.Error("the previous handle is still claimed")
	}
	if !slices.Equal(f.store.members[g.ID], []string{"u-1"}) {
		t.Errorf("editing details touched the members: %v", f.store.members[g.ID])
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
	if _, err := f.svc.Update(ctx, ugAdmin, "group-missing", UserGroupPatch{Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Errorf("Update of a missing group = %v, want not found", err)
	}
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, "group-missing", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetEnabled of a missing group = %v, want not found", err)
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

// A group has no size limit: its members are rows of their own.
func TestUserGroups_NoMemberLimit(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	ids := make([]string, 2500)
	for i := range ids {
		ids[i] = fmt.Sprintf("p-%04d", i)
		f.people.users[ids[i]] = &model.User{ID: ids[i], SystemRole: model.SystemRoleMember, Status: "active"}
	}
	g := f.create(t, "everyone-eng", ids...)
	if g.MemberCount != len(ids) || len(f.store.members[g.ID]) != len(ids) {
		t.Fatalf("MemberCount = %d, rows = %d; want %d", g.MemberCount, len(f.store.members[g.ID]), len(ids))
	}
	got, err := f.svc.MentionedMembers(ctx, "u-1", []string{g.ID})
	if err != nil || len(got[g.ID]) != len(ids) {
		t.Fatalf("MentionedMembers = %d members, %v", len(got[g.ID]), err)
	}
}

func TestUserGroups_ConcurrentWritesRetryOnTheLatestVersion(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	name := "Renamed"
	f.store.conflicts = userGroupWriteAttempts - 1
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Name: &name}); err != nil {
		t.Fatalf("Update after %d conflicts: %v", userGroupWriteAttempts-1, err)
	}
	f.store.conflicts = userGroupWriteAttempts
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Name: &name}); err == nil || !errors.Is(err, store.ErrUserGroupChanged) {
		t.Fatalf("Update past the retry budget = %v, want the conflict", err)
	}
}

func TestUserGroups_SetEnabledAndListing(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	oncall := f.create(t, "oncall", "u-1")
	f.create(t, "sre", "u-1")
	disabled, err := f.svc.SetEnabled(ctx, ugAdmin, oncall.ID, false)
	if err != nil || !disabled.Disabled || !slices.Equal(f.store.members[oncall.ID], []string{"u-1"}) {
		t.Fatalf("disable = %+v, %v; want the members kept", disabled, err)
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
	if got, _ := f.svc.GroupsForUser(ctx, ugMember, "u-1"); !slices.Equal(handles(got), []string{"oncall", "sre"}) {
		t.Errorf("GroupsForUser = %v, want by handle", handles(got))
	}
	if got, err := f.svc.Get(ctx, ugMember, oncall.ID); err != nil || got.Disabled || !slices.Equal(got.MemberIDs, []string{"u-1"}) {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	f.store.listErr = errors.New("boom")
	if _, err := f.svc.List(ctx, ugMember, false); err == nil {
		t.Error("List swallowed a store error")
	}
	f.store.forUserErr = errors.New("boom")
	if _, err := f.svc.GroupsForUser(ctx, ugMember, "u-1"); err == nil {
		t.Error("GroupsForUser swallowed a member-row error")
	}
	f.store.forUserErr = nil
	f.store.batchErr = errors.New("boom")
	if _, err := f.svc.GroupsForUser(ctx, ugMember, "u-1"); err == nil {
		t.Error("GroupsForUser swallowed a group read error")
	}
}

func TestUserGroups_GetErrors(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	if _, err := f.svc.Get(ctx, ugMember, "group-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get missing = %v, want not found", err)
	}
	g := f.create(t, "oncall", "u-1")
	f.store.membersErr = errors.New("boom")
	if _, err := f.svc.Get(ctx, ugMember, g.ID); err == nil {
		t.Error("Get swallowed a member read error")
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
		if got := f.store.members[id]; !slices.Equal(got, want) {
			t.Errorf("group %s members = %v, want %v", id, got, want)
		}
		if got := f.store.groups[id].MemberCount; got != len(want) {
			t.Errorf("group %s MemberCount = %d, want %d", id, got, len(want))
		}
	}
	f.store.membersErr = errors.New("boom")
	if err := f.svc.RemoveUserFromAllGroups(ctx, "u-1"); err == nil {
		t.Error("RemoveUserFromAllGroups swallowed a recount error")
	}
	f.store.membersErr = nil
	f.store.applyErr = errors.New("boom")
	if err := f.svc.RemoveUserFromAllGroups(ctx, "u-3"); err == nil {
		t.Error("RemoveUserFromAllGroups swallowed a member write error")
	}
	f.store.forUserErr = errors.New("boom")
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
	f.copies.drop() // not in the shared copy: read from the store
	f.store.membersErr = errors.New("boom")
	if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{oncall.ID}); err == nil {
		t.Error("MentionedMembers swallowed a member read error")
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
	f.copies.drop() // not in the shared copy: read from the store
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
