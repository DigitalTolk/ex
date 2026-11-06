package service

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// fakeEntraDirectory is Microsoft 365 in memory: groups and their user
// object IDs (nested already flattened).
type fakeEntraDirectory struct {
	mu        sync.Mutex
	groups    map[string]*model.EntraGroup
	members   map[string][]string
	search    []model.EntraGroup
	searchErr error
	getErr    error
	membersErr map[string]error
	searches  int
	reads     []string // group IDs whose members were read, in order
}

func (d *fakeEntraDirectory) SearchGroups(_ context.Context, _ string) ([]model.EntraGroup, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.searches++
	return d.search, d.searchErr
}

func (d *fakeEntraDirectory) GetGroup(_ context.Context, id string) (*model.EntraGroup, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.getErr != nil {
		return nil, d.getErr
	}
	g, ok := d.groups[id]
	if !ok {
		return nil, ErrEntraGroupNotFound
	}
	c := *g
	return &c, nil
}

func (d *fakeEntraDirectory) GroupUserIDs(_ context.Context, id string) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.reads = append(d.reads, id)
	if err := d.membersErr[id]; err != nil {
		return nil, err
	}
	if _, ok := d.groups[id]; !ok {
		return nil, ErrEntraGroupNotFound
	}
	return slices.Clone(d.members[id]), nil
}

type fakeEntraIndex struct {
	mu         sync.Mutex
	m          map[string]string
	complete   bool
	lookupErr  error
	replaceErr error
	addErr     error
	replaced   int
	ttl        time.Duration
}

func (x *fakeEntraIndex) Lookup(_ context.Context, ids []string) (map[string]string, bool, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.lookupErr != nil {
		return nil, false, x.lookupErr
	}
	out := map[string]string{}
	for _, id := range ids {
		if v, ok := x.m[id]; ok {
			out[id] = v
		}
	}
	return out, x.complete, nil
}

func (x *fakeEntraIndex) Replace(_ context.Context, m map[string]string, ttl time.Duration) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.replaced++
	x.ttl = ttl
	if x.replaceErr != nil {
		return x.replaceErr
	}
	x.m, x.complete = m, true
	return nil
}

func (x *fakeEntraIndex) Add(_ context.Context, objectID, userID string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.addErr != nil {
		return x.addErr
	}
	x.m[objectID] = userID
	return nil
}

type fakeGroupSyncLocker struct {
	mu         sync.Mutex
	held       map[string]bool
	acquireErr error
	releaseErr error
}

func (l *fakeGroupSyncLocker) AcquireLock(_ context.Context, key, _ string, _ time.Duration) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.acquireErr != nil {
		return false, l.acquireErr
	}
	if l.held[key] {
		return false, nil
	}
	l.held[key] = true
	return true, nil
}

func (l *fakeGroupSyncLocker) ReleaseLock(_ context.Context, key, _ string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.held, key)
	return l.releaseErr
}

// pagedAccounts serves accounts two pages at a time.
type pagedAccounts struct {
	users []*model.User
	err   error
	calls int
}

func (p *pagedAccounts) ListUsers(_ context.Context, _ int, cursor string) ([]*model.User, string, error) {
	p.calls++
	if p.err != nil {
		return nil, "", p.err
	}
	if cursor == "" {
		return p.users[:1], "page-2", nil
	}
	return p.users[1:], "", nil
}

type entraFixture struct {
	*userGroupFixture
}

// newEntraFixture: Entra group "entra-oncall" holds o-1, o-2, a guest and
// someone without an ex account; "entra-sre" holds o-3.
func newEntraFixture() *entraFixture {
	f := &entraFixture{newUserGroupFixture()}
	f.dir.groups["entra-oncall"] = &model.EntraGroup{ID: "entra-oncall", DisplayName: "On-call engineers", Kind: "security"}
	f.dir.groups["entra-sre"] = &model.EntraGroup{ID: "entra-sre", DisplayName: "SRE", Kind: "m365"}
	f.dir.members["entra-oncall"] = []string{"o-1", "o-2", "o-guest", "o-new"}
	f.dir.members["entra-sre"] = []string{"o-3"}
	for oid, uid := range map[string]string{"o-1": "u-1", "o-2": "u-2", "o-3": "u-3", "o-guest": "u-guest"} {
		f.index.m[oid] = uid
	}
	f.accounts.users = []*model.User{
		{ID: "u-1", MSObjectID: "o-1"}, {ID: "u-2", MSObjectID: "o-2"}, {ID: "u-3", MSObjectID: "o-3"},
		{ID: "u-local"},
	}
	return f
}

func (f *entraFixture) linked(t *testing.T, handle, entraID string) *model.UserGroupDetail {
	t.Helper()
	g, err := f.svc.Create(context.Background(), ugAdmin, UserGroupInput{Handle: handle, Name: handle, EntraGroupID: entraID})
	if err != nil {
		t.Fatalf("create %s: %v", handle, err)
	}
	return g
}

// stored is the group as the store holds it, members included.
func (f *entraFixture) stored(id string) *model.UserGroupDetail {
	g, _ := f.store.GetUserGroup(context.Background(), id)
	g.MemberIDs = slices.Clone(f.store.members[id])
	return g
}

func TestEntra_NotConfigured(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	svc := NewUserGroupService(f.store, f.people, f.bots, f.pub)
	if svc.CanLinkMicrosoft(ugAdmin) {
		t.Fatal("CanLinkMicrosoft without the integration")
	}
	_, searchErr := svc.SearchEntraGroups(ctx, ugAdmin, "x")
	_, previewErr := svc.PreviewLink(ctx, ugAdmin, "entra", "")
	_, linkErr := svc.Link(ctx, ugAdmin, g.ID, "entra")
	_, syncErr := svc.SyncNow(ctx, ugAdmin, g.ID, false)
	_, createErr := svc.Create(ctx, ugAdmin, UserGroupInput{Handle: "x2", Name: "X", EntraGroupID: "entra"})
	for name, err := range map[string]error{"search": searchErr, "preview": previewErr, "link": linkErr, "sync": syncErr, "create": createErr} {
		if !errors.Is(err, ErrValidation) {
			t.Errorf("%s = %v, want 'not configured'", name, err)
		}
	}
	svc.SyncLinkedGroups(ctx, time.Now().Add(time.Hour)) // no-op
	svc.NoteEntraUser(ctx, "o-1", "u-1")                 // no-op
	// Existing groups still work.
	if got, err := svc.EnabledHandles(ctx, []string{g.ID}); err != nil || got[g.ID] != "oncall" {
		t.Fatalf("EnabledHandles = %v, %v", got, err)
	}
}

func TestEntra_AdminsOnly(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	if !f.svc.CanLinkMicrosoft(ugAdmin) || f.svc.CanLinkMicrosoft(ugMember) || f.svc.CanLinkMicrosoft(UserGroupActor{Role: model.SystemRoleAdmin}) {
		t.Fatal("CanLinkMicrosoft disagrees with admins-only")
	}
	_, searchErr := f.svc.SearchEntraGroups(ctx, ugMember, "x")
	_, previewErr := f.svc.PreviewLink(ctx, ugMember, "entra-oncall", "")
	_, linkErr := f.svc.Link(ctx, ugMember, g.ID, "entra-oncall")
	_, syncErr := f.svc.SyncNow(ctx, ugMember, g.ID, false)
	_, createErr := f.svc.Create(ctx, ugMember, UserGroupInput{Handle: "x2", Name: "X", EntraGroupID: "entra-oncall"})
	for name, err := range map[string]error{"search": searchErr, "preview": previewErr, "link": linkErr, "sync": syncErr, "create": createErr} {
		if !errors.Is(err, ErrForbidden) {
			t.Errorf("member %s = %v, want forbidden", name, err)
		}
	}
}

func TestEntra_SearchIsCachedAcrossCalls(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	f.dir.search = []model.EntraGroup{{ID: "entra-oncall", DisplayName: "On-call engineers", Kind: "security"}}
	if got, err := f.svc.SearchEntraGroups(ctx, ugAdmin, "  "); err != nil || len(got) != 0 || f.dir.searches != 0 {
		t.Fatalf("blank search = %v, %v (searches %d)", got, err, f.dir.searches)
	}
	for _, q := range []string{"On-call", " on-call "} {
		got, err := f.svc.SearchEntraGroups(ctx, ugAdmin, q)
		if err != nil || len(got) != 1 || got[0].ID != "entra-oncall" {
			t.Fatalf("SearchEntraGroups(%q) = %v, %v", q, got, err)
		}
	}
	if f.dir.searches != 1 {
		t.Fatalf("Graph searched %d times, want once (cached)", f.dir.searches)
	}
	f.cache.setErr = errors.New("redis down")
	if _, err := f.svc.SearchEntraGroups(ctx, ugAdmin, "sre"); err != nil {
		t.Fatalf("a failed cache write failed the search: %v", err)
	}
	f.dir.searchErr = errors.New("graph down")
	if _, err := f.svc.SearchEntraGroups(ctx, ugAdmin, "design"); err == nil {
		t.Fatal("SearchEntraGroups swallowed a Graph error")
	}
}

func TestEntra_PreviewLink(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	got, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-oncall", "")
	if err != nil || *got != (model.UserGroupLinkPreview{Users: 4, ToAdd: 2, Skipped: 2}) {
		t.Fatalf("preview for a new group = %+v, %v", got, err)
	}
	g := f.create(t, "oncall", "u-1", "u-3")
	got, err = f.svc.PreviewLink(ctx, ugAdmin, "entra-oncall", g.ID)
	if err != nil || *got != (model.UserGroupLinkPreview{Users: 4, ToAdd: 1, ToRemove: 1, Skipped: 2}) {
		t.Fatalf("preview for %s = %+v, %v", g.ID, got, err)
	}
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-oncall", "group-missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("preview for a missing group = %v", err)
	}
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-gone", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("preview of a missing Entra group = %v", err)
	}
	f.store.membersErr = errors.New("dynamo down")
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-oncall", g.ID); err == nil {
		t.Error("preview swallowed a member read error")
	}
	f.store.membersErr = nil
	f.dir.membersErr["entra-sre"] = errors.New("graph down")
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-sre", ""); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("preview on a Graph failure = %v", err)
	}
}

// Link points a group at another Microsoft 365 group and replaces its
// members with that group's.
func TestEntra_LinkReplacesMembers(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-3")
	previous := g.EntraGroupID
	linked, err := f.svc.Link(ctx, ugAdmin, g.ID, "entra-oncall")
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	if !slices.Equal(linked.MemberIDs, []string{"u-1", "u-2"}) || linked.EntraGroupID != "entra-oncall" ||
		linked.EntraGroupName != "On-call engineers" || linked.SyncSkipped != 2 || linked.SyncedAt == nil || linked.MemberCount != 2 {
		t.Fatalf("linked = %+v", linked)
	}
	if got := f.store.members[g.ID]; !slices.Equal(got, []string{"u-1", "u-2"}) {
		t.Fatalf("member rows = %v", got)
	}
	if _, held := f.store.entra[previous]; held {
		t.Error("the previous Microsoft 365 group is still claimed")
	}
	if len(f.locker.held) != 0 {
		t.Fatal("the sync lock wasn't released")
	}
	// Details stay editable.
	name := "Pager crew"
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Name: &name}); err != nil {
		t.Errorf("renaming a group: %v", err)
	}

	other := f.create(t, "sre")
	if _, err := f.svc.Link(ctx, ugAdmin, other.ID, "entra-oncall"); !errors.Is(err, ErrEntraGroupLinked) {
		t.Errorf("linking a second group to the same Entra group = %v", err)
	}
	if got := f.store.members[other.ID]; len(got) != 0 {
		t.Errorf("a refused link wrote members: %v", got)
	}
	if _, err := f.svc.Link(ctx, ugAdmin, other.ID, "entra-gone"); !errors.Is(err, ErrNotFound) {
		t.Errorf("linking to a missing Entra group = %v", err)
	}
	f.store.membersErr = errors.New("dynamo down")
	if _, err := f.svc.Link(ctx, ugAdmin, other.ID, "entra-sre"); err == nil {
		t.Errorf("Link swallowed a member read error")
	}
	f.store.membersErr = nil
	f.store.applyErr = errors.New("dynamo down")
	if _, err := f.svc.Link(ctx, ugAdmin, other.ID, "entra-sre"); err == nil {
		t.Fatal("Link swallowed a member write error")
	}
	if got := f.stored(other.ID); got.SyncState != model.UserGroupSyncError || got.EntraGroupID != "entra-sre" {
		t.Fatalf("after a failed member write = %+v; want linked, sync failed", got)
	}
	f.store.applyErr = nil
	f.dir.getErr = errors.New("graph down")
	if _, err := f.svc.Link(ctx, ugAdmin, other.ID, "entra-sre"); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("linking while Graph is down = %v", err)
	}
	f.dir.getErr = nil
	f.locker.held["ugsync:"+other.ID] = true
	if _, err := f.svc.Link(ctx, ugAdmin, other.ID, "entra-sre"); !errors.Is(err, ErrUserGroupSyncBusy) {
		t.Errorf("linking while the group syncs = %v, want busy", err)
	}
}

// A mention between Link's row write and its member write copies the
// previous members; Link deletes that copy once the members are written.
func TestEntra_LinkLeavesNoCopyOfThePreviousMembers(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-3")
	f.store.beforeApply = func() {
		f.store.beforeApply = nil
		if got, _ := f.svc.MentionedMembers(ctx, "u-1", []string{g.ID}); !slices.Equal(got[g.ID], []string{"u-3"}) {
			t.Errorf("mid-link mention = %v, want the previous members", got)
		}
	}
	if _, err := f.svc.Link(ctx, ugAdmin, g.ID, "entra-oncall"); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID})
	if err != nil || !slices.Equal(got[g.ID], []string{"u-1", "u-2"}) {
		t.Fatalf("MentionedMembers after Link = %v, %v; want the new members", got, err)
	}
}

func TestEntra_CreateLinked(t *testing.T) {
	f := newEntraFixture()
	g := f.linked(t, "oncall", "entra-oncall")
	if !slices.Equal(g.MemberIDs, []string{"u-1", "u-2"}) || g.MemberCount != 2 {
		t.Fatalf("created = %+v; want Entra's members", g)
	}
	if _, err := f.svc.Create(context.Background(), ugAdmin, UserGroupInput{Handle: "again", Name: "Again", EntraGroupID: "entra-oncall"}); !errors.Is(err, ErrEntraGroupLinked) {
		t.Fatalf("a second group on the same Entra group = %v", err)
	}
}

func TestEntra_SyncNowAppliesChanges(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	g := f.linked(t, "oncall", "entra-oncall")
	f.dir.members["entra-oncall"] = []string{"o-1", "o-3"}
	f.dir.groups["entra-oncall"].DisplayName = "Renamed in Entra"
	before := len(f.changedEvents())
	got, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false)
	if err != nil || !slices.Equal(got.MemberIDs, []string{"u-1", "u-3"}) || got.EntraGroupName != "Renamed in Entra" || got.SyncSkipped != 0 || got.MemberCount != 2 {
		t.Fatalf("SyncNow = %+v, %v", got, err)
	}
	if rows := f.store.members[g.ID]; !slices.Equal(rows, []string{"u-1", "u-3"}) {
		t.Fatalf("member rows = %v", rows)
	}
	if len(f.changedEvents()) != before+1 {
		t.Fatal("a sync that changed members didn't tell clients")
	}
	if len(f.locker.held) != 0 {
		t.Fatal("the sync lock wasn't released")
	}
	if _, err := f.svc.SyncNow(ctx, ugAdmin, "group-missing", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("syncing a missing group = %v", err)
	}
}

func TestEntra_SyncHoldsLargeRemovals(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	many := make([]string, 0, 12)
	for i := range 12 {
		oid, uid := "o-m"+string(rune('a'+i)), "u-m"+string(rune('a'+i))
		many = append(many, oid)
		f.index.m[oid] = uid
		f.people.users[uid] = &model.User{ID: uid, SystemRole: model.SystemRoleMember, Status: "active"}
	}
	f.dir.members["entra-oncall"] = many
	g := f.linked(t, "oncall", "entra-oncall")

	// Losing 7 of 12 (more than half) is held for an admin.
	f.dir.members["entra-oncall"] = many[:5]
	held, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false)
	if err != nil || held.SyncState != model.UserGroupSyncHeld || held.PendingRemoval != 7 || len(f.store.members[g.ID]) != 12 {
		t.Fatalf("held sync = %+v, %v", held, err)
	}
	applied, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, true)
	if err != nil || applied.SyncState != "" || applied.PendingRemoval != 0 || len(applied.MemberIDs) != 5 || len(f.store.members[g.ID]) != 5 {
		t.Fatalf("applied sync = %+v, %v", applied, err)
	}

	// An empty result is held whatever the size.
	f.dir.members["entra-oncall"] = nil
	if got, _ := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); got.SyncState != model.UserGroupSyncHeld || len(f.store.members[g.ID]) != 5 {
		t.Fatalf("empty sync = %+v; want held, members kept", got)
	}
}

func TestEntra_SyncNeverEmptiesOnFailures(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	g := f.linked(t, "oncall", "entra-oncall")

	f.dir.membersErr["entra-oncall"] = errors.New("graph down")
	if _, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err == nil {
		t.Fatal("SyncNow swallowed a Graph error")
	}
	if got := f.stored(g.ID); got.SyncState != model.UserGroupSyncError || len(got.MemberIDs) != 2 {
		t.Fatalf("after a Graph error = %+v; want members kept, state error", got)
	}
	delete(f.dir.membersErr, "entra-oncall")

	// Members that can't be written are written by the next sync.
	f.dir.members["entra-oncall"] = []string{"o-1", "o-2", "o-3"}
	f.store.applyErr = errors.New("dynamo down")
	if _, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err == nil {
		t.Fatal("SyncNow swallowed a member write error")
	}
	if got := f.stored(g.ID); got.SyncState != model.UserGroupSyncError || len(got.MemberIDs) != 2 {
		t.Fatalf("after a failed member write = %+v", got)
	}
	f.store.applyErr = nil
	if got, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err != nil || len(got.MemberIDs) != 3 || got.SyncState != "" {
		t.Fatalf("the next sync = %+v, %v", got, err)
	}

	delete(f.dir.groups, "entra-oncall")
	got, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false)
	if err != nil || got.SyncState != model.UserGroupSyncSourceMissing || got.Disabled || len(f.store.members[g.ID]) != 3 {
		t.Fatalf("source missing = %+v, %v; want enabled, members kept", got, err)
	}
	// The sweep, which doesn't read the name, sees the vanished group the same way.
	f.store.groups[g.ID].SyncState = ""
	if got, err := f.svc.syncGroup(ctx, g.ID, false, false); err != nil || got.SyncState != model.UserGroupSyncSourceMissing {
		t.Fatalf("sweep on a missing source = %+v, %v", got, err)
	}

	f.store.membersErr = errors.New("dynamo down")
	if _, err := f.svc.syncGroup(ctx, g.ID, false, false); err == nil {
		t.Fatal("syncGroup swallowed a member read error")
	}
}

func TestEntra_SyncFailureRecordingCanFailToo(t *testing.T) {
	f := newEntraFixture()
	g := f.linked(t, "oncall", "entra-oncall")
	f.dir.membersErr["entra-oncall"] = errors.New("graph down")
	f.store.updateErr = errors.New("dynamo down")
	if _, err := f.svc.SyncNow(context.Background(), ugAdmin, g.ID, false); err == nil {
		t.Fatal("SyncNow = nil")
	}
	// The row write after the members can fail too.
	delete(f.dir.membersErr, "entra-oncall")
	f.dir.members["entra-oncall"] = []string{"o-1"}
	if _, err := f.svc.SyncNow(context.Background(), ugAdmin, g.ID, false); err == nil {
		t.Fatal("SyncNow swallowed a row write error")
	}
}

func TestEntra_SyncLock(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	g := f.linked(t, "oncall", "entra-oncall")
	f.locker.held["ugsync:"+g.ID] = true
	if _, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); !errors.Is(err, ErrUserGroupSyncBusy) {
		t.Fatalf("SyncNow while syncing = %v, want busy", err)
	}
	delete(f.locker.held, "ugsync:"+g.ID)
	f.locker.releaseErr = errors.New("redis blip")
	if _, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err != nil {
		t.Fatalf("a failed lock release failed the sync: %v", err)
	}
	f.locker.acquireErr = errors.New("redis down")
	if _, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err == nil || errors.Is(err, ErrUserGroupSyncBusy) {
		t.Fatalf("lock failure = %v", err)
	}
}

func TestEntra_UnchangedSyncTellsNoOne(t *testing.T) {
	f := newEntraFixture()
	g := f.linked(t, "oncall", "entra-oncall")
	before := len(f.changedEvents())
	if _, err := f.svc.syncGroup(context.Background(), g.ID, false, false); err != nil {
		t.Fatal(err)
	}
	if len(f.changedEvents()) != before {
		t.Fatal("a sync that changed nothing told clients")
	}
	if got := f.stored(g.ID); got.EntraGroupName != "On-call engineers" {
		t.Fatalf("the sweep lost the group's name: %q", got.EntraGroupName)
	}
}

func TestEntra_SyncLinkedGroupsOldestFirstWithinBudget(t *testing.T) {
	f := newEntraFixture()
	ctx := context.Background()
	oncall := f.linked(t, "oncall", "entra-oncall")
	sre := f.linked(t, "sre", "entra-sre")
	f.store.groups[sre.ID].SyncedAt = nil // never synced: first in line
	f.dir.reads = nil

	// Budget for one group: the least recently synced (sre) goes.
	start := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	var clock sync.Mutex
	calls := 0
	f.svc.now = func() time.Time {
		clock.Lock()
		defer clock.Unlock()
		calls++
		return start.Add(time.Duration(calls) * time.Minute)
	}
	f.svc.SyncLinkedGroups(ctx, start.Add(90*time.Second))
	if !slices.Equal(f.dir.reads, []string{"entra-sre"}) {
		t.Fatalf("synced %v, want only the oldest (entra-sre) within the budget", f.dir.reads)
	}

	// With time enough, every linked group syncs; one failing doesn't stop the rest.
	f.dir.reads = nil
	f.svc.now = func() time.Time { return start }
	f.dir.membersErr["entra-sre"] = errors.New("graph down")
	f.locker.held["ugsync:"+oncall.ID] = false
	f.svc.SyncLinkedGroups(ctx, start.Add(time.Hour))
	slices.Sort(f.dir.reads)
	if !slices.Equal(f.dir.reads, []string{"entra-oncall", "entra-sre"}) {
		t.Fatalf("synced %v, want both groups", f.dir.reads)
	}

	// A group already syncing elsewhere is skipped quietly.
	f.dir.reads = nil
	f.locker.held["ugsync:"+oncall.ID] = true
	f.svc.SyncLinkedGroups(ctx, start.Add(time.Hour))
	if slices.Contains(f.dir.reads, "entra-oncall") {
		t.Fatal("a busy group was synced twice")
	}

	f.store.listErr = errors.New("dynamo down")
	f.dir.reads = nil
	f.svc.SyncLinkedGroups(ctx, start.Add(time.Hour))
	if len(f.dir.reads) != 0 {
		t.Fatal("synced although the group list failed")
	}
}

func TestEntra_UserIndex(t *testing.T) {
	ctx := context.Background()

	// A complete index answers without reading the accounts.
	f := newEntraFixture()
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-oncall", ""); err != nil || f.accounts.calls != 0 {
		t.Fatalf("preview with a complete index: %v (account reads %d)", err, f.accounts.calls)
	}

	// An incomplete or unreadable index is rebuilt from the accounts.
	for name, prep := range map[string]func(*entraFixture){
		"incomplete": func(f *entraFixture) { f.index.complete = false },
		"unreadable": func(f *entraFixture) { f.index.lookupErr = errors.New("redis down") },
	} {
		f := newEntraFixture()
		prep(f)
		got, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-sre", "")
		if err != nil || got.ToAdd != 1 || f.accounts.calls != 2 || f.index.replaced != 1 {
			t.Fatalf("%s: preview = %+v, %v (account reads %d, rebuilds %d)", name, got, err, f.accounts.calls, f.index.replaced)
		}
	}

	f = newEntraFixture()
	f.index.complete = false
	f.index.replaceErr = errors.New("redis down")
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-sre", ""); err != nil {
		t.Fatalf("a failed index write failed the preview: %v", err)
	}
	f.accounts.err = errors.New("dynamo down")
	if _, err := f.svc.PreviewLink(ctx, ugAdmin, "entra-sre", ""); err == nil {
		t.Fatal("preview swallowed an account read error")
	}

	// A sign-in is recorded; failures are only logged.
	f = newEntraFixture()
	f.svc.NoteEntraUser(ctx, "o-9", "u-9")
	f.svc.NoteEntraUser(ctx, "", "u-local")
	if f.index.m["o-9"] != "u-9" || len(f.index.m) != 5 {
		t.Fatalf("index after sign-ins = %v", f.index.m)
	}
	f.index.addErr = errors.New("redis down")
	f.svc.NoteEntraUser(ctx, "o-10", "u-10")
	f.svc.ReplaceEntraIndex(ctx, map[string]string{"o-1": "u-1"})
	if f.index.replaced != 1 || len(f.index.m) != 1 {
		t.Fatalf("ReplaceEntraIndex = %v", f.index.m)
	}
}

func TestEntra_IndexTTLDefaultsWithoutAnInterval(t *testing.T) {
	f := newEntraFixture()
	f.svc.SetMicrosoft(UserGroupMicrosoftDeps{Directory: f.dir, Index: f.index, Accounts: f.accounts, Locker: f.locker, Cache: f.cache, NewToken: func() string { return "t" }})
	f.svc.ReplaceEntraIndex(context.Background(), map[string]string{})
	if f.index.ttl != defaultEntraIndexTTL {
		t.Fatalf("index TTL = %v, want %v", f.index.ttl, defaultEntraIndexTTL)
	}
}

func TestEntra_MembersReadFailure(t *testing.T) {
	f := newEntraFixture()
	f.people.err = errors.New("users down")
	if _, err := f.svc.PreviewLink(context.Background(), ugAdmin, "entra-oncall", ""); err == nil {
		t.Fatal("preview swallowed a member read error")
	}
	f.people.err = nil
	f.dir.members["entra-sre"] = []string{"o-unknown"}
	if got, err := f.svc.PreviewLink(context.Background(), ugAdmin, "entra-sre", ""); err != nil || got.ToAdd != 0 || got.Skipped != 1 {
		t.Fatalf("preview with nobody in ex = %+v, %v", got, err)
	}
}

func TestEntra_LinkPublishesAndChangedEvents(t *testing.T) {
	f := newEntraFixture()
	g := f.linked(t, "oncall", "entra-oncall")
	found := false
	for _, p := range f.pub.published {
		if p.channel == pubsub.UserEvents() && p.event.Type == events.EventUserGroupChanged && strings.Contains(string(p.event.Data), g.ID) {
			found = true
		}
	}
	if !found {
		t.Fatal("creating a linked group told no client")
	}
}

// --- shared copy on the mention paths ---

func TestUserGroups_WorkWithoutASharedCopy(t *testing.T) {
	f := newUserGroupFixture()
	svc := NewUserGroupService(f.store, f.people, f.bots, f.pub)
	svc.SetMicrosoft(UserGroupMicrosoftDeps{Directory: f.dir, Index: f.index, Accounts: f.accounts, Locker: f.locker, Cache: f.cache, NewToken: func() string { return "t" }})
	g, err := svc.Create(context.Background(), ugAdmin, UserGroupInput{Handle: "oncall", Name: "On call", EntraGroupID: f.msGroup("oncall", "u-1")})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := svc.EnabledHandles(context.Background(), []string{g.ID}); err != nil || got[g.ID] != "oncall" {
		t.Fatalf("EnabledHandles = %v, %v", got, err)
	}
	if _, err := svc.SyncNow(context.Background(), ugAdmin, g.ID, false); err != nil {
		t.Fatalf("SyncNow = %v", err)
	}
}

func TestUserGroupCopies_ReadThroughAndBackfill(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")

	// A first read goes to the store and is copied.
	if got, _ := f.svc.EnabledHandles(ctx, []string{g.ID, g.ID}); got[g.ID] != "oncall" {
		t.Fatalf("EnabledHandles from the store = %v", got)
	}
	if c := f.copies.current(g.ID); c == nil || !slices.Equal(c.MemberIDs, []string{"u-1"}) {
		t.Fatalf("the copy wasn't backfilled with the members: %+v", c)
	}

	// Then served from the copy without touching the store.
	f.store.batchErr = errors.New("must not be read")
	f.store.membersErr = errors.New("must not be read")
	if got, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID}); err != nil || !slices.Equal(got[g.ID], []string{"u-1"}) {
		t.Fatalf("MentionedMembers from the copy = %v, %v", got, err)
	}
	f.store.batchErr, f.store.membersErr = nil, nil

	// An unreadable copy reads the store.
	f.copies.getErr = errors.New("redis down")
	if got, _ := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID}); !slices.Equal(got[g.ID], []string{"u-1"}) {
		t.Fatalf("MentionedMembers without the copy = %v", got)
	}
	f.copies.getErr = nil

	// A copy that can't be stored only costs the next reader a store read.
	f.copies.drop()
	f.copies.putErr = errors.New("redis down")
	if got, err := f.svc.EnabledHandles(ctx, []string{g.ID}); err != nil || got[g.ID] != "oncall" {
		t.Fatalf("EnabledHandles with a failing copy write = %v, %v", got, err)
	}
}

// Every committed change deletes the copy, so the next mention reads the
// store and sees the change.
func TestUserGroupCopies_ForgottenOnEveryChange(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	g := f.create(t, "oncall", "u-1")
	warm := func() {
		t.Helper()
		if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID}); err != nil || f.copies.current(g.ID) == nil {
			t.Fatalf("warming the copy: %v", err)
		}
	}

	// A sync that changes the members.
	warm()
	f.msGroup("oncall", "u-1", "u-2")
	if _, err := f.svc.SyncNow(ctx, ugAdmin, g.ID, false); err != nil {
		t.Fatal(err)
	}
	if f.copies.current(g.ID) != nil {
		t.Fatal("the copy from before the sync is still there")
	}
	got, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID})
	if err != nil || !slices.Equal(got[g.ID], []string{"u-1", "u-2"}) {
		t.Fatalf("MentionedMembers = %v, %v; want the members after the sync", got, err)
	}

	// Detail edits too.
	name := "Renamed"
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if f.copies.current(g.ID) != nil {
		t.Fatal("a copy from before the edit is still there")
	}


	// A copy that can't be deleted is logged; the write stands.
	f.copies.forgetErr = errors.New("redis down")
	if _, err := f.svc.Update(ctx, ugAdmin, g.ID, UserGroupPatch{Name: &name}); err != nil {
		t.Fatalf("a failed delete failed the edit: %v", err)
	}
}

// --- the Graph adapter ---

type fakeGraphGroups struct {
	groups []msgraph.Group
	err    error
}

func (g *fakeGraphGroups) SearchGroups(context.Context, string) ([]msgraph.Group, error) {
	return g.groups, g.err
}

func (g *fakeGraphGroups) GetGroup(_ context.Context, id string) (*msgraph.Group, error) {
	if g.err != nil {
		return nil, g.err
	}
	for i := range g.groups {
		if g.groups[i].ID == id {
			return &g.groups[i], nil
		}
	}
	return nil, msgraph.ErrNotFound
}

func (g *fakeGraphGroups) GroupUserIDs(_ context.Context, id string) ([]string, error) {
	if g.err != nil {
		return nil, g.err
	}
	if id == "gone" {
		return nil, msgraph.ErrNotFound
	}
	return []string{"o-1"}, nil
}

func TestMSGroupDirectory(t *testing.T) {
	ctx := context.Background()
	graph := &fakeGraphGroups{groups: []msgraph.Group{
		{ID: "g-1", DisplayName: "On call", Mail: "oncall@example.com", GroupTypes: []string{"Unified"}},
		{ID: "g-2", DisplayName: "Engineers", GroupTypes: []string{"Unified", "DynamicMembership"}},
	}}
	d := NewMSGroupDirectory(graph)
	got, err := d.SearchGroups(ctx, "x")
	if err != nil || len(got) != 2 || got[0] != (model.EntraGroup{ID: "g-1", DisplayName: "On call", Mail: "oncall@example.com", Kind: "m365"}) || got[1].Kind != "dynamic" {
		t.Fatalf("SearchGroups = %+v, %v", got, err)
	}
	if g, err := d.GetGroup(ctx, "g-2"); err != nil || g.Kind != "dynamic" {
		t.Fatalf("GetGroup = %+v, %v", g, err)
	}
	if _, err := d.GetGroup(ctx, "nope"); !errors.Is(err, ErrEntraGroupNotFound) {
		t.Fatalf("GetGroup(nope) = %v", err)
	}
	if ids, err := d.GroupUserIDs(ctx, "g-1"); err != nil || !slices.Equal(ids, []string{"o-1"}) {
		t.Fatalf("GroupUserIDs = %v, %v", ids, err)
	}
	if _, err := d.GroupUserIDs(ctx, "gone"); !errors.Is(err, ErrEntraGroupNotFound) {
		t.Fatalf("GroupUserIDs(gone) = %v", err)
	}
	graph.err = errors.New("graph down")
	if _, err := d.SearchGroups(ctx, "x"); err == nil {
		t.Error("SearchGroups swallowed an error")
	}
	if _, err := d.GetGroup(ctx, "g-1"); err == nil || errors.Is(err, ErrEntraGroupNotFound) {
		t.Errorf("GetGroup error = %v", err)
	}
}
