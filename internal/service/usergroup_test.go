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
	sources   map[string]string
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
	// takenOnUpdate is a handle the next update to it finds taken, as if
	// claimed between the check and the write.
	takenOnUpdate string
}

func newFakeUserGroupStore() *fakeUserGroupStore {
	return &fakeUserGroupStore{
		groups: map[string]*model.UserGroupDetail{}, members: map[string][]string{},
		handles: map[string]string{}, sources: map[string]string{},
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
	if _, taken := f.sources[g.Source.Key]; taken {
		return store.ErrUserGroupSourceTaken
	}
	f.sources[g.Source.Key] = g.ID
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
	if g.Handle != previous.Handle && g.Handle == f.takenOnUpdate {
		f.takenOnUpdate = ""
		return store.ErrAlreadyExists
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
	copies *fakeCopies
	svc    *UserGroupService
	store  *fakeUserGroupStore
	people *fakeGroupPeople
	bots   *fakeBotNames
	pub    *mockPublisher
	status *mockCache
}

// newUserGroupFixture wires the service in memory. Users u-1, u-2, u-3,
// u-admin and u-member are active members; u-guest, u-bot and u-gone can't
// be group members.
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
		status: newMockCache(),
	}
	f.svc = NewUserGroupService(f.store, f.people, f.bots, f.pub)
	f.svc.now = func() time.Time { return time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC) }
	f.copies = newFakeCopies()
	f.svc.SetCopies(f.copies)
	f.svc.SetSyncStatusCache(f.status)
	return f
}

var (
	ugAdmin  = UserGroupActor{ID: "u-admin", Role: model.SystemRoleAdmin}
	ugMember = UserGroupActor{ID: "u-member", Role: model.SystemRoleMember}
	ugGuest  = UserGroupActor{ID: "u-guest", Role: model.SystemRoleGuest}
)

// create puts group @handle, holding members, straight into the store (the
// sync makes groups; these tests exercise the rest).
func (f *userGroupFixture) create(t *testing.T, handle string, members ...string) *model.UserGroupDetail {
	t.Helper()
	ctx := context.Background()
	g := &model.UserGroupDetail{UserGroup: model.UserGroup{
		ID: model.UserGroupIDPrefix + handle, Handle: handle, Name: "Group " + handle, MemberCount: len(members),
		Source: model.UserGroupSource{Kind: model.UserGroupSourceEntraGroup, ID: "eg-" + handle, Key: "entra-group:eg-" + handle},
	}}
	if err := f.store.CreateUserGroup(ctx, g); err != nil {
		t.Fatalf("create %s: %v", handle, err)
	}
	if err := f.store.ApplyUserGroupMembers(ctx, g.ID, members, nil); err != nil {
		t.Fatalf("members of %s: %v", handle, err)
	}
	g.MemberIDs = slices.Clone(members)
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

func TestUserGroups_Permissions(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")

	// Guests and anonymous callers can't even read.
	for _, actor := range []UserGroupActor{ugGuest, {Role: model.SystemRoleAdmin}} {
		_, listErr := f.svc.List(ctx, actor, false)
		_, getErr := f.svc.Get(ctx, actor, g.ID)
		_, forErr := f.svc.GroupsForUser(ctx, actor, "u-1")
		for name, err := range map[string]error{"List": listErr, "Get": getErr, "GroupsForUser": forErr} {
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("%s by %+v = %v, want forbidden", name, actor, err)
			}
		}
	}

	// Members read; only admins enable, disable and run or read the sync.
	if _, err := f.svc.List(ctx, ugMember, false); err != nil {
		t.Fatalf("member List: %v", err)
	}
	for _, actor := range []UserGroupActor{ugMember, ugGuest, {Role: model.SystemRoleAdmin}} {
		_, enableErr := f.svc.SetEnabled(ctx, actor, g.ID, true)
		_, statusErr := f.svc.SyncStatus(ctx, actor)
		_, nowErr := f.svc.SyncNow(ctx, actor)
		for op, err := range map[string]error{"SetEnabled": enableErr, "SyncStatus": statusErr, "SyncNow": nowErr} {
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("%+v %s = %v, want forbidden", actor, op, err)
			}
		}
	}
	if f.svc.CanManage(ugMember) || !f.svc.CanManage(ugAdmin) || f.svc.CanManage(ugGuest) {
		t.Error("CanManage disagrees with admins-only")
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
	f.store.conflicts = userGroupWriteAttempts - 1
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, g.ID, false); err != nil {
		t.Fatalf("SetEnabled after %d conflicts: %v", userGroupWriteAttempts-1, err)
	}
	f.store.conflicts = userGroupWriteAttempts
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, g.ID, true); err == nil || !errors.Is(err, store.ErrUserGroupChanged) {
		t.Fatalf("SetEnabled past the retry budget = %v, want the conflict", err)
	}
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, "group-missing", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetEnabled of a missing group = %v, want not found", err)
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
