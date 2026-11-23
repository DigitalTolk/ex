package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// --- doubles ---

// fakeSource answers Fetch with snap (or err), counting reads.
type fakeSource struct {
	mu    sync.Mutex
	snap  SourceSnapshot
	err   error
	panic bool
	calls atomic.Int64
}

func (s *fakeSource) Fetch(context.Context) (SourceSnapshot, error) {
	s.calls.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.panic {
		panic("source exploded")
	}
	return SourceSnapshot{Groups: slices.Clone(s.snap.Groups)}, s.err
}

func (s *fakeSource) set(groups ...SourceGroup) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snap = SourceSnapshot{Groups: groups}
}

// fakeSyncUsers pages users two at a time.
type fakeSyncUsers struct {
	users []*model.User
	err   error
}

func (u *fakeSyncUsers) ListUsers(_ context.Context, _ int, cursor string) ([]*model.User, string, error) {
	if u.err != nil {
		return nil, "", u.err
	}
	start := 0
	if cursor != "" {
		start = int(cursor[0] - '0')
	}
	end := min(start+2, len(u.users))
	next := ""
	if end < len(u.users) {
		next = string(rune('0' + end))
	}
	return u.users[start:end], next, nil
}

// fakeRunLock is the run guard: one holder at a time.
type fakeRunLock struct {
	mu         sync.Mutex
	holder     string
	acquireErr error
	releaseErr error
	ttl        time.Duration
}

func (l *fakeRunLock) AcquireLock(_ context.Context, _, token string, ttl time.Duration) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.acquireErr != nil {
		return false, l.acquireErr
	}
	if l.holder != "" {
		return false, nil
	}
	l.holder, l.ttl = token, ttl
	return true, nil
}

func (l *fakeRunLock) ReleaseLock(_ context.Context, _, token string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder == token {
		l.holder = ""
	}
	return l.releaseErr
}

type syncFixture struct {
	*userGroupFixture
	source *fakeSource
	users  *fakeSyncUsers
	lock   *fakeRunLock
}

// newSyncFixture connects the service to a fake source. People oid-1…oid-3
// are the members u-1…u-3; oid-guest, oid-bot, oid-gone and oid-local can't
// be members, and oid-unknown has no ex account.
func newSyncFixture() *syncFixture {
	f := &syncFixture{userGroupFixture: newUserGroupFixture(), source: &fakeSource{}, lock: &fakeRunLock{}}
	oidc := func(id, oid string) *model.User {
		return &model.User{ID: id, MSObjectID: oid, AuthProvider: model.AuthProviderOIDC, SystemRole: model.SystemRoleMember, Status: "active"}
	}
	guest, bot, gone, local := oidc("u-guest", "oid-guest"), oidc("u-bot", "oid-bot"), oidc("u-gone", "oid-gone"), oidc("u-local", "oid-local")
	guest.SystemRole, bot.IsBot, gone.Status, local.AuthProvider = model.SystemRoleGuest, true, "deactivated", model.AuthProviderGuest
	f.users = &fakeSyncUsers{users: []*model.User{
		oidc("u-1", "oid-1"), oidc("u-2", "oid-2"), oidc("u-3", "oid-3"),
		guest, bot, gone, local, oidc("u-nooid", ""),
	}}
	n := 0
	f.svc.SetSync(f.source, f.users, f.lock, 30*time.Minute, func() string { n++; return string(rune('a' + n)) })
	return f
}

func entraGroup(id, name string, members ...string) SourceGroup {
	return SourceGroup{Key: "entra-group:" + id, ID: id, Name: name, MemberRefs: members}
}

func (f *syncFixture) run() { f.svc.runSync(context.Background(), userGroupSyncScheduled) }

func (f *syncFixture) byHandle(t *testing.T, handle string) *model.UserGroupDetail {
	t.Helper()
	id, ok := f.store.handles[handle]
	if !ok {
		t.Fatalf("no group @%s (handles: %v)", handle, f.store.handles)
	}
	g := cloneGroup(f.store.groups[id])
	g.MemberIDs = slices.Clone(f.store.members[id])
	return g
}

func (f *syncFixture) syncStatus(t *testing.T) *model.UserGroupSyncStatus {
	t.Helper()
	st, err := f.svc.SyncStatus(context.Background(), ugAdmin)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func (f *syncFixture) syncEvents() int {
	n := 0
	for _, p := range f.pub.published {
		if p.channel == pubsub.UserEvents() && p.event.Type == events.EventUserGroupSync {
			n++
		}
	}
	return n
}

// --- creating and syncing ---

func TestSync_CreatesGroupsFromTheSource(t *testing.T) {
	f := newSyncFixture()
	eng := entraGroup("g-eng", " ENG ", "oid-1", "oid-2", "oid-1", "oid-guest", "oid-bot", "oid-gone", "oid-local", "oid-unknown")
	eng.Description = "Engineering department"
	f.source.set(eng, entraGroup("g-dope", "eng-dope", "oid-3"))
	f.run()

	g := f.byHandle(t, "eng")
	if g.Name != "ENG" || g.Description != "Engineering department" || g.MemberCount != 2 || g.SyncSkipped != 5 || g.SyncState != "" {
		t.Fatalf("@eng = %+v", g.UserGroup)
	}
	if g.Source != (model.UserGroupSource{Kind: model.UserGroupSourceEntraGroup, ID: "g-eng", Key: "entra-group:g-eng"}) {
		t.Fatalf("source = %+v", g.Source)
	}
	if !slices.Equal(g.MemberIDs, []string{"u-1", "u-2"}) {
		t.Fatalf("members = %v", g.MemberIDs)
	}
	if got := f.byHandle(t, "eng-dope").MemberIDs; !slices.Equal(got, []string{"u-3"}) {
		t.Fatalf("@eng-dope members = %v", got)
	}
	if len(f.changedEvents()) != 2 || f.syncEvents() != 2 {
		t.Fatalf("events: %d changed, %d sync", len(f.changedEvents()), f.syncEvents())
	}
	st := f.syncStatus(t)
	if !st.Configured || st.IntervalMinutes != 30 || st.Running || st.LastSyncedAt == nil || st.FinishedAt == nil ||
		st.LastError != "" || len(st.Skipped) != 0 || st.Trigger != userGroupSyncScheduled {
		t.Fatalf("status = %+v", st)
	}
	if f.lock.holder != "" || f.lock.ttl != 30*time.Minute {
		t.Fatalf("run guard: holder %q, ttl %v", f.lock.holder, f.lock.ttl)
	}
}

func TestSync_LongDetailsAreCut(t *testing.T) {
	f := newSyncFixture()
	g := entraGroup("g-1", "eng")
	g.Description = strings.Repeat("d", limits.MaxUserGroupDescriptionChars+10)
	f.source.set(g)
	f.run()
	if got := f.byHandle(t, "eng").Description; len([]rune(got)) != limits.MaxUserGroupDescriptionChars {
		t.Fatalf("description is %d characters", len([]rune(got)))
	}
}

func TestSync_RenameKeepsTheSameGroup(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng-it-squad", "oid-1", "oid-2"))
	f.run()
	before := f.byHandle(t, "eng-it-squad")

	renamed := entraGroup("g-1", "eng-it-support", "oid-1", "oid-2")
	renamed.Description = "IT"
	f.source.set(renamed)
	f.run()
	after := f.byHandle(t, "eng-it-support")
	if after.ID != before.ID || after.Name != "eng-it-support" || after.Description != "IT" || !slices.Equal(after.MemberIDs, before.MemberIDs) {
		t.Fatalf("after the rename = %+v (before %+v)", after, before)
	}
	if _, held := f.store.handles["eng-it-squad"]; held {
		t.Fatal("the old handle is still claimed")
	}
}

func TestSync_AppliesOnlyChanges(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1", "oid-2"))
	f.run()
	g := f.byHandle(t, "eng")

	// Nothing changed: no row write, no event.
	updates, changed := f.store.updates, len(f.changedEvents())
	f.run()
	if f.store.updates != updates || len(f.changedEvents()) != changed {
		t.Fatalf("a quiet run wrote %d rows, %d events", f.store.updates-updates, len(f.changedEvents())-changed)
	}

	// One leaves, one joins: only those member rows change.
	f.source.set(entraGroup("g-1", "eng", "oid-2", "oid-3"))
	f.run()
	if got := f.byHandle(t, "eng").MemberIDs; !slices.Equal(got, []string{"u-2", "u-3"}) {
		t.Fatalf("members = %v", got)
	}

	// A members-only change that leaves the count as is writes no row, but
	// forgets the copy and tells clients.
	f.copies.groups[g.ID] = g
	updates, changed = f.store.updates, len(f.changedEvents())
	f.source.set(entraGroup("g-1", "eng", "oid-1", "oid-3"))
	f.run()
	if f.store.updates != updates || len(f.changedEvents()) != changed+1 || f.copies.current(g.ID) != nil {
		t.Fatalf("members-only change: %d row writes, %d events, copy %v", f.store.updates-updates, len(f.changedEvents())-changed, f.copies.current(g.ID))
	}
}

func TestSync_DisabledGroupsKeepSyncing(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()
	g := f.byHandle(t, "eng")
	if _, err := f.svc.SetEnabled(context.Background(), ugAdmin, g.ID, false); err != nil {
		t.Fatal(err)
	}
	f.source.set(entraGroup("g-1", "eng", "oid-1", "oid-2"))
	f.run()
	if got := f.byHandle(t, "eng"); !got.Disabled || len(got.MemberIDs) != 2 {
		t.Fatalf("disabled group = %+v", got.UserGroup)
	}
}

// --- handles ---

func TestSync_NewGroupsWithUnusableNamesAreSkipped(t *testing.T) {
	f := newSyncFixture()
	f.create(t, "product")
	f.source.set(
		entraGroup("g-bad", "Product AI!"),
		entraGroup("g-all", "All"),
		entraGroup("g-dup", "product"),
		entraGroup("g-bot", "deploybot"),
		entraGroup("g-ok", "product-ai", "oid-1"),
	)
	f.run()
	if _, ok := f.store.handles["product-ai"]; !ok || len(f.store.groups) != 2 {
		t.Fatalf("groups = %v", f.store.handles)
	}
	reasons := map[string]string{}
	for _, s := range f.syncStatus(t).Skipped {
		reasons[s.Name] = s.Reason
	}
	want := map[string]string{
		"Product AI!": "not a valid handle",
		"All":         "@all is reserved",
		"product":     "@product is taken by another group",
		"deploybot":   "@deploybot is taken by a bot",
	}
	for name, reason := range want {
		if !strings.HasPrefix(reasons[name], reason) {
			t.Errorf("skip %q = %q, want %q…", name, reasons[name], reason)
		}
	}
}

func TestSync_RenameToATakenHandleKeepsTheOldOne(t *testing.T) {
	f := newSyncFixture()
	f.create(t, "product")
	f.source.set(entraGroup("g-1", "eng-ai", "oid-1"))
	f.run()
	g := f.byHandle(t, "eng-ai")

	f.source.set(entraGroup("g-1", "product", "oid-1"))
	f.run()
	got := f.byHandle(t, "eng-ai")
	if got.SyncState != model.UserGroupSyncHandleConflict || got.Name != "product" {
		t.Fatalf("after a clashing rename = %+v", got.UserGroup)
	}
	if st := f.syncStatus(t); len(st.Skipped) != 1 || st.Skipped[0].GroupID != g.ID || st.Skipped[0].Reason != "@product is taken by another group" {
		t.Fatalf("skipped = %+v", st.Skipped)
	}

	// Fixed upstream: the rename goes through and the flag clears.
	f.source.set(entraGroup("g-1", "product-ai", "oid-1"))
	f.run()
	if got := f.byHandle(t, "product-ai"); got.ID != g.ID || got.SyncState != "" {
		t.Fatalf("after the fix = %+v", got.UserGroup)
	}
}

func TestSync_HandleTakenBetweenCheckAndWrite(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()

	// On a rename: the old handle stays and the group is flagged.
	f.store.takenOnUpdate = "eng-x"
	f.source.set(entraGroup("g-1", "eng-x", "oid-1"))
	f.run()
	if got := f.byHandle(t, "eng"); got.SyncState != model.UserGroupSyncHandleConflict {
		t.Fatalf("after a lost race = %+v", got.UserGroup)
	}
	if st := f.syncStatus(t); len(st.Skipped) != 1 || st.Skipped[0].Reason != "@eng-x is taken" {
		t.Fatalf("skipped = %+v", st.Skipped)
	}

	// On a create: skipped.
	f.store.createErr = store.ErrAlreadyExists
	f.source.set(entraGroup("g-1", "eng-x", "oid-1"), entraGroup("g-2", "new"))
	f.run()
	f.store.createErr = nil
	if st := f.syncStatus(t); len(st.Skipped) != 1 || st.Skipped[0].Name != "new" || st.Skipped[0].Reason != "@new is taken" {
		t.Fatalf("skipped = %+v", st.Skipped)
	}
}

// --- gone groups and unreadable members ---

func TestSync_GroupLeavingTheParentIsEmptiedAndFlagged(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1", "oid-2", "oid-unknown"), entraGroup("g-2", "product"))
	f.run()

	f.source.set(entraGroup("g-2", "product"))
	f.run()
	g := f.byHandle(t, "eng")
	if g.SyncState != model.UserGroupSyncSourceMissing || g.MemberCount != 0 || g.SyncSkipped != 0 || len(g.MemberIDs) != 0 || g.Disabled {
		t.Fatalf("gone = %+v", g.UserGroup)
	}

	// Once flagged and empty, later runs write nothing.
	updates := f.store.updates
	f.run()
	if f.store.updates != updates {
		t.Fatal("an already-flagged group was written again")
	}

	// Members added behind its back are removed again, without a row write.
	_ = f.store.ApplyUserGroupMembers(context.Background(), g.ID, []string{"u-3"}, nil)
	f.run()
	if len(f.byHandle(t, "eng").MemberIDs) != 0 || f.store.updates != updates {
		t.Fatal("a flagged group kept a stray member")
	}

	// It comes back: synced again.
	f.source.set(entraGroup("g-1", "eng", "oid-1"), entraGroup("g-2", "product"))
	f.run()
	if got := f.byHandle(t, "eng"); got.SyncState != "" || !slices.Equal(got.MemberIDs, []string{"u-1"}) {
		t.Fatalf("back = %+v", got.UserGroup)
	}
}

func TestSync_UnreadableMembersAreKept(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1", "oid-2"))
	f.run()

	broken := entraGroup("g-1", "eng-renamed")
	broken.MembersErr = errors.New("graph 503")
	fresh := entraGroup("g-2", "product", "oid-3")
	fresh.MembersErr = errors.New("graph 503")
	f.source.set(broken, fresh)
	f.run()
	if got := f.byHandle(t, "eng-renamed"); !slices.Equal(got.MemberIDs, []string{"u-1", "u-2"}) || got.MemberCount != 2 {
		t.Fatalf("members after an unreadable read = %+v", got)
	}
	if got := f.byHandle(t, "product"); got.MemberCount != 0 || len(got.MemberIDs) != 0 {
		t.Fatalf("a new group with unreadable members = %+v", got)
	}
}

// --- a source that can't be used ---

func TestSync_BrokenSourceChangesNothing(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()
	last := f.syncStatus(t).LastSyncedAt
	updates := f.store.updates

	f.source.err = errors.New("the parent group can't be found in Microsoft 365")
	f.run()
	st := f.syncStatus(t)
	if st.LastError != "the parent group can't be found in Microsoft 365" || !st.LastSyncedAt.Equal(*last) || f.store.updates != updates {
		t.Fatalf("after a broken read: status %+v, writes %d", st, f.store.updates-updates)
	}
	if got := f.byHandle(t, "eng"); len(got.MemberIDs) != 1 || got.SyncState != "" {
		t.Fatalf("a broken read touched @eng: %+v", got.UserGroup)
	}

	// An empty parent is a failure too, never "every group is gone".
	f.source.err = nil
	f.source.set()
	f.run()
	if st := f.syncStatus(t); st.LastError != ErrUserGroupSourceEmpty.Error() || len(f.byHandle(t, "eng").MemberIDs) != 1 {
		t.Fatalf("after an empty read: %+v", st)
	}
	// Recovering clears the error.
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()
	if st := f.syncStatus(t); st.LastError != "" {
		t.Fatalf("after recovering: %+v", st)
	}
}

func TestSync_EmptySourceBeforeAnyGroupIsJustReported(t *testing.T) {
	f := newSyncFixture()
	f.run()
	if st := f.syncStatus(t); st.LastError != ErrUserGroupSourceEmpty.Error() || st.LastSyncedAt != nil {
		t.Fatalf("status = %+v", st)
	}
}

func TestSync_StoreAndAccountFailures(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1"))

	f.store.listErr = errors.New("dynamo down")
	f.run()
	if st := f.syncStatus(t); st.LastError != "reading ex's groups failed" {
		t.Fatalf("status = %+v", st)
	}
	f.store.listErr = nil

	f.users.err = errors.New("dynamo down")
	f.run()
	if st := f.syncStatus(t); st.LastError != "reading ex's accounts failed" || len(f.store.groups) != 0 {
		t.Fatalf("status = %+v", st)
	}
	f.users.err = nil
}

func errIf(on bool) error {
	if on {
		return errors.New("dynamo down")
	}
	return nil
}

// One group's failure is logged and never stops the others.
func TestSync_GroupFailures(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng", "oid-1"), entraGroup("g-2", "product", "oid-2"))

	// Creating: a failed create, a failed member write.
	f.store.createErr = errors.New("dynamo down")
	f.run()
	f.store.createErr = nil
	if len(f.store.groups) != 0 {
		t.Fatal("a failed create stored a group")
	}
	f.store.applyErr = errors.New("dynamo down")
	f.run()
	f.store.applyErr = nil
	f.run()
	if len(f.byHandle(t, "eng").MemberIDs) != 1 {
		t.Fatal("the next run didn't complete the members")
	}

	// Syncing: unreadable member rows, a failed member write, a failed row
	// write, a failed handle check.
	f.source.set(entraGroup("g-1", "eng-2", "oid-2"), entraGroup("g-2", "product", "oid-2"))
	for _, broken := range []func(on bool){
		func(on bool) { f.store.membersErr = errIf(on) },
		func(on bool) { f.store.applyErr = errIf(on) },
		func(on bool) { f.store.updateErr = errIf(on) },
		func(on bool) { f.store.ownerErr = errIf(on) },
		func(on bool) { f.bots.err = errIf(on) },
	} {
		broken(true)
		f.run()
		broken(false)
		if _, ok := f.store.handles["eng"]; !ok {
			t.Fatal("a failed sync renamed @eng")
		}
	}

	// A handle check that fails while creating.
	f.source.set(entraGroup("g-1", "eng", "oid-1"), entraGroup("g-2", "product", "oid-2"), entraGroup("g-3", "new"))
	f.store.ownerErr = errors.New("dynamo down")
	f.run()
	f.store.ownerErr = nil
	if _, ok := f.store.handles["new"]; ok {
		t.Fatal("a group was created past a failed handle check")
	}

	// Emptying a gone group: unreadable members, a failed member write, a
	// failed row write.
	f.source.set(entraGroup("g-2", "product", "oid-2"))
	for _, broken := range []func(on bool){
		func(on bool) { f.store.membersErr = errIf(on) },
		func(on bool) { f.store.applyErr = errIf(on) },
		func(on bool) { f.store.updateErr = errIf(on) },
	} {
		broken(true)
		f.run()
		broken(false)
	}
	f.run()
	if f.byHandle(t, "eng").SyncState != model.UserGroupSyncSourceMissing {
		t.Fatal("@eng wasn't flagged once the store recovered")
	}
}

func TestSync_StopsAtTheDeadline(t *testing.T) {
	f := newSyncFixture()
	f.create(t, "old")
	groups, _ := f.store.ListUserGroups(context.Background())
	past := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	snap := SourceSnapshot{Groups: []SourceGroup{entraGroup("g-1", "eng")}}
	if skipped := f.svc.applySnapshot(context.Background(), groups, snap, nil, past); len(skipped) != 0 || len(f.store.groups) != 1 {
		t.Fatalf("past the deadline: skipped %v, groups %d", skipped, len(f.store.groups))
	}
	// The gone-group pass stops too.
	f.svc.applySnapshot(context.Background(), groups, SourceSnapshot{}, nil, past)
	if f.byHandle(t, "old").SyncState != "" {
		t.Fatal("a gone group was handled past the deadline")
	}
}

// --- one run at a time, Sync now, scheduling ---

func TestSync_RunGuard(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng"))

	f.lock.holder = "another-server"
	f.run()
	if f.source.calls.Load() != 0 {
		t.Fatal("ran while another server held the guard")
	}
	f.lock.holder = ""

	f.lock.acquireErr = errors.New("redis down")
	f.run()
	if f.source.calls.Load() != 0 {
		t.Fatal("ran without the guard")
	}
	f.lock.acquireErr = nil

	// A failed release is logged; the guard expires on its own.
	f.lock.releaseErr = errors.New("redis down")
	f.run()
	if f.source.calls.Load() != 1 || f.syncStatus(t).LastSyncedAt == nil {
		t.Fatal("a failed release spoiled the run")
	}
}

func TestSyncNow(t *testing.T) {
	ctx := context.Background()

	// Not connected.
	plain := newUserGroupFixture()
	st, err := plain.svc.SyncNow(ctx, ugAdmin)
	if !errors.Is(err, errUserGroupSyncOff) || st.Configured {
		t.Fatalf("SyncNow without a source = %+v, %v", st, err)
	}

	// Connected, but the background jobs haven't started.
	f := newSyncFixture()
	if _, err := f.svc.SyncNow(ctx, ugAdmin); !errors.Is(err, errUserGroupSyncOff) {
		t.Fatalf("SyncNow before RunSync = %v", err)
	}

	var launched []func()
	f.svc.sync.ctx, f.svc.sync.launch = ctx, func(fn func()) { launched = append(launched, fn) }
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	st, err = f.svc.SyncNow(ctx, ugAdmin)
	if err != nil || !st.Running || st.Trigger != userGroupSyncManual || len(launched) != 1 {
		t.Fatalf("SyncNow = %+v, %v (launched %d)", st, err, len(launched))
	}
	launched[0]()
	if got := f.syncStatus(t); got.Trigger != userGroupSyncManual || got.LastSyncedAt == nil {
		t.Fatalf("after the manual run = %+v", got)
	}

	// Right after a run: refused with the status.
	if st, err := f.svc.SyncNow(ctx, ugAdmin); !errors.Is(err, ErrUserGroupSyncCooldown) || st.FinishedAt == nil {
		t.Fatalf("SyncNow in the cooldown = %+v, %v", st, err)
	}

	// A minute later it runs again.
	base := f.svc.now()
	f.svc.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, err := f.svc.SyncNow(ctx, ugAdmin); err != nil || len(launched) != 2 {
		t.Fatalf("SyncNow after the cooldown = %v (launched %d)", err, len(launched))
	}

	// A run in progress anywhere: reported, no second run.
	started := f.svc.now()
	f.status.values[userGroupSyncStatusKey] = &model.UserGroupSyncStatus{Running: true, StartedAt: &started}
	if st, err := f.svc.SyncNow(ctx, ugAdmin); err != nil || !st.Running || len(launched) != 2 {
		t.Fatalf("SyncNow while running = %+v, %v (launched %d)", st, err, len(launched))
	}
}

func TestSyncStatus_StaleRunIsNotRunning(t *testing.T) {
	f := newSyncFixture()
	long := f.svc.now().Add(-2 * time.Hour)
	f.status.values[userGroupSyncStatusKey] = &model.UserGroupSyncStatus{Running: true, StartedAt: &long}
	if f.syncStatus(t).Running {
		t.Fatal("a run older than the guard still reads as running")
	}
	f.status.values[userGroupSyncStatusKey] = &model.UserGroupSyncStatus{Running: true}
	if f.syncStatus(t).Running {
		t.Fatal("a run without a start time reads as running")
	}
}

// waitForCalls waits until the source has been read n times.
func waitForCalls(t *testing.T, src *fakeSource, n int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for src.calls.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("only %d runs, want %d", src.calls.Load(), n)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRunSync_RunsAtOnceThenOnSchedule(t *testing.T) {
	f := newSyncFixture()
	f.source.set(entraGroup("g-1", "eng"))
	f.svc.sync.interval = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		f.svc.RunSync(ctx, func(fn func()) { fn() })
		close(done)
	}()
	waitForCalls(t, f.source, 3)
	cancel()
	<-done
}

func TestRunSync_APanickingRunDoesNotStopTheSchedule(t *testing.T) {
	f := newSyncFixture()
	f.source.panic = true
	f.svc.sync.interval = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		f.svc.RunSync(ctx, func(fn func()) { fn() })
		close(done)
	}()
	waitForCalls(t, f.source, 2)
	cancel()
	<-done
}

// --- the Entra source ---

type fakeGraphGroups struct {
	groups     []msgraph.Group
	listErr    error
	members    map[string][]string
	membersErr map[string]error
}

func (g *fakeGraphGroups) ListMemberGroups(_ context.Context, parentID string) ([]msgraph.Group, error) {
	if parentID != "parent-1" {
		return nil, errors.New("wrong parent")
	}
	return g.groups, g.listErr
}

func (g *fakeGraphGroups) ListMemberUserIDs(_ context.Context, groupID string) ([]string, error) {
	return g.members[groupID], g.membersErr[groupID]
}

func TestEntraGroupsSource(t *testing.T) {
	ctx := context.Background()
	graph := &fakeGraphGroups{
		groups:     []msgraph.Group{{ID: "g-1", DisplayName: "eng", Description: "Engineering"}, {ID: "g-2", DisplayName: "product"}},
		members:    map[string][]string{"g-1": {"oid-1"}},
		membersErr: map[string]error{"g-2": errors.New("graph 503")},
	}
	snap, err := NewEntraGroupsSource(graph, "parent-1").Fetch(ctx)
	if err != nil || len(snap.Groups) != 2 {
		t.Fatalf("Fetch = %+v, %v", snap, err)
	}
	if g := snap.Groups[0]; g.Key != "entra-group:g-1" || g.ID != "g-1" || g.Name != "eng" || g.Description != "Engineering" || !slices.Equal(g.MemberRefs, []string{"oid-1"}) || g.MembersErr != nil {
		t.Fatalf("g-1 = %+v", g)
	}
	if snap.Groups[1].MembersErr == nil {
		t.Fatal("g-2's member error was dropped")
	}

	graph.listErr = msgraph.ErrNotFound
	if _, err := NewEntraGroupsSource(graph, "parent-1").Fetch(ctx); err == nil || !strings.Contains(err.Error(), "can't be found") {
		t.Fatalf("missing parent = %v", err)
	}
	graph.listErr = errors.New("graph 403")
	if _, err := NewEntraGroupsSource(graph, "parent-1").Fetch(ctx); err == nil || !strings.Contains(err.Error(), "reading the parent group failed") {
		t.Fatalf("unreadable parent = %v", err)
	}
}

// --- status storage ---

// Redis answers a missing status with cache.ErrCacheMiss: the first run (or
// one after the status expired) reads that as "no status", not a failure.
func TestUserGroupSync_StatusCacheMissIsNotAFailure(t *testing.T) {
	var logs bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })

	f := newSyncFixture()
	f.status.getErr = cache.ErrCacheMiss
	f.source.set(entraGroup("g-1", "eng"))
	f.run()
	if strings.Contains(logs.String(), "reading the last status failed") {
		t.Fatalf("a cache miss was logged as a failure:\n%s", logs.String())
	}
}

func TestUserGroupSync_StatusCacheFailures(t *testing.T) {
	f := newSyncFixture()
	f.status.getErr = errors.New("redis down")
	f.status.setErr = errors.New("redis down")
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()
	if _, ok := f.store.handles["eng"]; !ok {
		t.Fatal("a status cache failure stopped the sync")
	}
	if st := f.syncStatus(t); st.LastSyncedAt != nil || st.Skipped == nil {
		t.Fatalf("status with the cache down = %+v", st)
	}
}

// --- shared copy ---

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
	f := newSyncFixture()
	ctx := context.Background()
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()
	g := f.byHandle(t, "eng")
	warm := func() {
		t.Helper()
		if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID}); err != nil || f.copies.current(g.ID) == nil {
			t.Fatalf("warming the copy: %v", err)
		}
	}

	warm()
	f.source.set(entraGroup("g-1", "eng", "oid-1", "oid-2"))
	f.run()
	if f.copies.current(g.ID) != nil {
		t.Fatal("the copy from before the sync is still there")
	}
	got, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID})
	if err != nil || !slices.Equal(got[g.ID], []string{"u-1", "u-2"}) {
		t.Fatalf("MentionedMembers = %v, %v; want the members after the sync", got, err)
	}

	if _, err := f.svc.SetEnabled(ctx, ugAdmin, g.ID, true); err != nil {
		t.Fatal(err)
	}
	if f.copies.current(g.ID) != nil {
		t.Fatal("a copy from before the change is still there")
	}

	// A copy that can't be deleted is logged; the write stands.
	f.copies.forgetErr = errors.New("redis down")
	if _, err := f.svc.SetEnabled(ctx, ugAdmin, g.ID, false); err != nil {
		t.Fatalf("a failed delete failed the change: %v", err)
	}
}

func TestDiffMembers(t *testing.T) {
	added, removed := diffMembers([]string{"a", "b", "c"}, []string{"c", "d", "a", "e"})
	if !slices.Equal(added, []string{"d", "e"}) || !slices.Equal(removed, []string{"b"}) {
		t.Fatalf("diff = +%v -%v", added, removed)
	}
	if a, r := diffMembers(nil, nil); a != nil || r != nil {
		t.Fatalf("empty diff = %v %v", a, r)
	}
}

// Without a shared copy, mentions read the store and changes have nothing
// to forget.
func TestUserGroups_WorkWithoutASharedCopy(t *testing.T) {
	f := newSyncFixture()
	f.svc.copies = nil
	f.source.set(entraGroup("g-1", "eng", "oid-1"))
	f.run()
	g := f.byHandle(t, "eng")
	if got, err := f.svc.EnabledHandles(context.Background(), []string{g.ID}); err != nil || got[g.ID] != "eng" {
		t.Fatalf("EnabledHandles = %v, %v", got, err)
	}
	if _, err := f.svc.SetEnabled(context.Background(), ugAdmin, g.ID, false); err != nil {
		t.Fatal(err)
	}
	if !f.svc.SyncConfigured() || newUserGroupFixture().svc.SyncConfigured() {
		t.Fatal("SyncConfigured disagrees with SetSync")
	}
}
