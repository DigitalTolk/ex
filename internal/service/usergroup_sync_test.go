package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// people builds a sweep's reading from (userID, department) pairs; "" as the
// user ID is an account with no ex member.
func people(pairs ...string) []DirectoryPerson {
	out := make([]DirectoryPerson, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, DirectoryPerson{UserID: pairs[i], Department: pairs[i+1]})
	}
	return out
}

// byHandle is the stored group with this handle, members included.
func (f *userGroupFixture) byHandle(t *testing.T, handle string) *model.UserGroupDetail {
	t.Helper()
	id, ok := f.store.handles[handle]
	if !ok {
		t.Fatalf("no group @%s (handles: %v)", handle, f.store.handles)
	}
	g := cloneGroup(f.store.groups[id])
	g.MemberIDs = slices.Clone(f.store.members[id])
	return g
}

func (f *userGroupFixture) sync(pairs ...string) {
	f.svc.SyncDirectoryGroups(context.Background(), people(pairs...))
}

func TestSync_CreatesDepartmentAndSquadGroups(t *testing.T) {
	f := newUserGroupFixture()
	f.sync(
		"u-1", "Engineering - DOPE, Platform",
		"u-2", "Engineering - DOPE",
		"u-3", "Sales",
		"", "Engineering - DOPE",
		"u-member", "",
	)
	if got := len(f.store.groups); got != 4 {
		t.Fatalf("groups = %d, want 4 (2 departments, 2 squads)", got)
	}
	eng := f.byHandle(t, "engineering")
	if !slices.Equal(eng.MemberIDs, []string{"u-1", "u-2"}) || eng.MemberCount != 2 || eng.SyncSkipped != 1 ||
		eng.Name != "Engineering" || eng.Description != "Department Engineering" ||
		eng.Source != (model.UserGroupSource{Kind: model.UserGroupSourceDepartment, Department: "Engineering", Key: "dept:engineering"}) {
		t.Fatalf("@engineering = %+v", eng)
	}
	dope := f.byHandle(t, "dope")
	if !slices.Equal(dope.MemberIDs, []string{"u-1", "u-2"}) || dope.SyncSkipped != 1 || dope.Description != "Squad DOPE in Engineering" ||
		dope.Source != (model.UserGroupSource{Kind: model.UserGroupSourceSquad, Department: "Engineering", Squad: "DOPE", Key: "squad:dope"}) {
		t.Fatalf("@dope = %+v", dope)
	}
	if got := f.byHandle(t, "platform").MemberIDs; !slices.Equal(got, []string{"u-1"}) {
		t.Fatalf("@platform members = %v", got)
	}
	if got := f.byHandle(t, "sales").MemberIDs; !slices.Equal(got, []string{"u-3"}) {
		t.Fatalf("@sales members = %v", got)
	}
	if got := len(f.changedEvents()); got != 4 {
		t.Fatalf("usergroup.changed events = %d, want 4", got)
	}
	status, err := f.svc.SyncStatus(context.Background(), ugAdmin)
	if err != nil || status.LastSyncedAt == nil || status.Readable != 4 || status.Held || status.Anomalies.People != 0 {
		t.Fatalf("status = %+v, %v", status, err)
	}
}

func TestSync_SquadUnderTwoDepartmentsIsOneGroup(t *testing.T) {
	f := newUserGroupFixture()
	f.sync("u-1", "Engineering - Platform", "u-2", "Data - Platform", "u-3", "Data - platform")
	p := f.byHandle(t, "platform")
	if len(p.MemberIDs) != 3 || p.Source.Department != "Data" {
		t.Fatalf("@platform = %+v; want everyone, under the department most list", p)
	}
	// Tied spellings go to the alphabetically first: "Platform" < "platform".
	if p.Name != "Platform" {
		t.Fatalf("name = %q", p.Name)
	}
}

func TestSync_Handles(t *testing.T) {
	f := newUserGroupFixture()
	f.store.handles["taken"] = "group-other"
	f.sync(
		"u-1", "Sales - Sales",
		"u-2", "Data & AI",
		"u-3", "Försäljning - DeployBot, Here, Q, ???, Taken",
	)
	for handle, name := range map[string]string{
		"sales":       "Sales", // the department wins the bare handle
		"sales-2":     "Sales",
		"data-and-ai": "Data & AI",
		"forsaljning": "Försäljning",
		"deploybot-2": "DeployBot", // a bot holds "deploybot"
		"here-2":      "Here",      // a broadcast word
		"q-2":         "Q",         // too short alone
		"group":       "???",       // nothing usable
		"taken-2":     "Taken",
	} {
		if got := f.byHandle(t, handle).Name; got != name {
			t.Errorf("@%s name = %q, want %q", handle, got, name)
		}
	}
}

func TestUserGroupHandleBase(t *testing.T) {
	for name, want := range map[string]string{
		"Engineering":     "engineering",
		"Data & AI":       "data-and-ai",
		"R/D  ops.":       "r-d-ops",
		"Æble Øl Straße":  "aeble-ol-strasse",
		"Ålesund-Ötzi":    "alesund-otzi",
		"  -- Sales --  ": "sales",
		"???":             "group",
		"Customer Experience and Support Operations": "customer-experience-and",
		"abcdefghijklmnopqrstuvwxyz0123456789":       "abcdefghijklmnopqrstuvwxyz0123",
		"ab-cdefghijklmnopqrstuvwxyz0123456789":      "ab",
		"a-bcdefghijklmnopqrstuvwxyz0123456789":      "a-bcdefghijklmnopqrstuvwxyz012",
	} {
		if got := userGroupHandleBase(name); got != want {
			t.Errorf("userGroupHandleBase(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSync_HandleErrors(t *testing.T) {
	f := newUserGroupFixture()
	// Every handle up to the attempt limit is taken.
	f.store.handles["full"] = "group-x"
	for n := 2; n <= maxHandleAttempts; n++ {
		f.store.handles[fmt.Sprintf("full-%d", n)] = "group-x"
	}
	f.sync("u-1", "Full")
	if _, ok := f.store.sources["dept:full"]; ok {
		t.Fatal("a group was created with no free handle")
	}
	f.store.ownerErr = errors.New("dynamo down")
	f.sync("u-1", "Other")
	if len(f.store.sources) != 0 {
		t.Fatal("a group was created although the handle check failed")
	}
}

func TestSync_AppliesOnlyChanges(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE")
	updates, events := f.store.updates, len(f.changedEvents())

	// Nothing changed: nothing is written, nobody is told.
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE")
	if f.store.updates != updates || len(f.changedEvents()) != events {
		t.Fatalf("a quiet sweep wrote %d rows and sent %d events", f.store.updates-updates, len(f.changedEvents())-events)
	}

	// One person swapped for another: the members change, the row doesn't.
	dope := f.byHandle(t, "dope")
	if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{dope.ID}); err != nil {
		t.Fatal(err)
	}
	f.sync("u-1", "Engineering - DOPE", "u-3", "Engineering - DOPE")
	if got := f.byHandle(t, "dope").MemberIDs; !slices.Equal(got, []string{"u-1", "u-3"}) {
		t.Fatalf("members = %v", got)
	}
	if f.store.updates != updates || f.copies.current(dope.ID) != nil || len(f.changedEvents()) != events+2 {
		t.Fatalf("a member swap: %d row writes, copy kept %v, %d events", f.store.updates-updates, f.copies.current(dope.ID) != nil, len(f.changedEvents())-events)
	}

	// A new member changes the count, so the row is written.
	f.sync("u-1", "Engineering - DOPE", "u-3", "Engineering - DOPE", "u-2", "Engineering - DOPE")
	if got := f.byHandle(t, "dope"); got.MemberCount != 3 || f.store.updates == updates {
		t.Fatalf("after a join: count %d, row writes %d", got.MemberCount, f.store.updates-updates)
	}
}

func TestSync_HoldsLargeRemovalsUntilApproved(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	var all []string
	for i := range 12 {
		id := fmt.Sprintf("p-%02d", i)
		f.people.users[id] = &model.User{ID: id, SystemRole: model.SystemRoleMember, Status: "active"}
		all = append(all, id, "Engineering - DOPE")
	}
	f.sync(all...)

	// 7 of 12 leave (more than half) while one joins: the joiner is added,
	// the removal waits.
	kept := append(slices.Clone(all[:10]), "u-1", "Engineering - DOPE")
	f.sync(kept...)
	dope := f.byHandle(t, "dope")
	if dope.SyncState != model.UserGroupSyncHeld || dope.PendingRemoval != 7 || len(dope.MemberIDs) != 13 || dope.MemberCount != 13 {
		t.Fatalf("held = %+v (%d members)", dope.UserGroup, len(dope.MemberIDs))
	}

	if _, err := f.svc.ApproveHeldRemoval(ctx, ugAdmin, dope.ID); err != nil {
		t.Fatalf("approve: %v", err)
	}
	f.sync(kept...)
	dope = f.byHandle(t, "dope")
	if dope.SyncState != "" || dope.PendingRemoval != 0 || dope.RemovalApproved || len(dope.MemberIDs) != 6 {
		t.Fatalf("applied = %+v (%d members)", dope.UserGroup, len(dope.MemberIDs))
	}
	if _, err := f.svc.ApproveHeldRemoval(ctx, ugAdmin, dope.ID); !errors.Is(err, ErrValidation) {
		t.Fatalf("approving with nothing held = %v", err)
	}
	if _, err := f.svc.ApproveHeldRemoval(ctx, ugAdmin, "group-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("approving a missing group = %v", err)
	}
}

func TestSync_GoneSourceKeepsMembersUntilApproved(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE")

	// DOPE is renamed in Entra: a new group appears, the old one is held.
	f.sync("u-1", "Engineering - DOPE Squad", "u-2", "Engineering - DOPE Squad")
	dope := f.byHandle(t, "dope")
	if dope.SyncState != model.UserGroupSyncSourceMissing || dope.PendingRemoval != 2 || len(dope.MemberIDs) != 2 {
		t.Fatalf("gone = %+v", dope.UserGroup)
	}
	if got := f.byHandle(t, "dope-squad").MemberIDs; len(got) != 2 {
		t.Fatalf("@dope-squad members = %v", got)
	}

	// An approval empties it; it stays gone.
	if _, err := f.svc.ApproveHeldRemoval(ctx, ugAdmin, dope.ID); err != nil {
		t.Fatal(err)
	}
	f.sync("u-1", "Engineering - DOPE Squad", "u-2", "Engineering - DOPE Squad")
	dope = f.byHandle(t, "dope")
	if dope.SyncState != model.UserGroupSyncSourceMissing || dope.PendingRemoval != 0 || len(dope.MemberIDs) != 0 || dope.RemovalApproved {
		t.Fatalf("emptied = %+v", dope.UserGroup)
	}

	// It comes back: synced again.
	f.sync("u-1", "Engineering - DOPE")
	dope = f.byHandle(t, "dope")
	if dope.SyncState != "" || !slices.Equal(dope.MemberIDs, []string{"u-1"}) {
		t.Fatalf("back = %+v", dope.UserGroup)
	}
}

func TestSync_ApprovalIsDroppedWhenNothingIsLeftToRemove(t *testing.T) {
	f := newUserGroupFixture()
	f.sync("u-1", "Engineering - DOPE")
	f.sync("u-2", "Engineering - Ops")
	dope := f.byHandle(t, "dope")
	if _, err := f.svc.ApproveHeldRemoval(context.Background(), ugAdmin, dope.ID); err != nil {
		t.Fatal(err)
	}
	f.sync("u-1", "Engineering - DOPE")
	if got := f.byHandle(t, "dope"); got.RemovalApproved || got.SyncState != "" {
		t.Fatalf("after the source came back = %+v", got.UserGroup)
	}
}

func TestSync_AdminEditsStick(t *testing.T) {
	f := newUserGroupFixture()
	ctx := context.Background()
	f.sync("u-1", "Engineering - DOPE")

	// Before an admin edits it, the name follows Entra's spelling.
	f.sync("u-1", "Engineering - Dope")
	dope := f.byHandle(t, "dope")
	if dope.Name != "Dope" || dope.Description != "Squad Dope in Engineering" {
		t.Fatalf("followed Entra = %q / %q", dope.Name, dope.Description)
	}
	name, handle := "Pager crew", "pagers"
	if _, err := f.svc.Update(ctx, ugAdmin, dope.ID, UserGroupPatch{Name: &name, Handle: &handle}); err != nil {
		t.Fatal(err)
	}
	f.sync("u-1", "Engineering - DOPE")
	got := f.byHandle(t, "pagers")
	if got.Name != "Pager crew" || got.Description != "Squad Dope in Engineering" || !got.AdminEdited || got.Source.Squad != "DOPE" {
		t.Fatalf("after an admin edit = %+v", got.UserGroup)
	}
}

func TestSync_DisabledGroupsKeepSyncing(t *testing.T) {
	f := newUserGroupFixture()
	f.sync("u-1", "Engineering - DOPE")
	dope := f.byHandle(t, "dope")
	if _, err := f.svc.SetEnabled(context.Background(), ugAdmin, dope.ID, false); err != nil {
		t.Fatal(err)
	}
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE")
	if got := f.byHandle(t, "dope"); !got.Disabled || len(got.MemberIDs) != 2 {
		t.Fatalf("disabled group = %+v", got.UserGroup)
	}
}

func TestSync_HoldsATenantWideDropOnce(t *testing.T) {
	f := newUserGroupFixture()
	var many []string
	for i := range departmentDropFloor {
		id := fmt.Sprintf("p-%02d", i)
		f.people.users[id] = &model.User{ID: id, SystemRole: model.SystemRoleMember, Status: "active"}
		many = append(many, id, "Engineering - DOPE")
	}
	f.sync(many...)
	updates := f.store.updates

	// Departments come back blank for most people: held once.
	few := slices.Clone(many[:8])
	f.sync(few...)
	status, _ := f.svc.SyncStatus(context.Background(), ugAdmin)
	if !status.Held || status.Readable != departmentDropFloor || f.store.updates != updates || len(f.byHandle(t, "dope").MemberIDs) != departmentDropFloor {
		t.Fatalf("first low sweep: status %+v, writes %d", status, f.store.updates-updates)
	}

	// The next sweep agrees: it applies (the large removal itself is still
	// held per group).
	f.sync(few...)
	status, _ = f.svc.SyncStatus(context.Background(), ugAdmin)
	if status.Held || status.Readable != 4 {
		t.Fatalf("second low sweep: status %+v", status)
	}
	if got := f.byHandle(t, "dope"); got.SyncState != model.UserGroupSyncHeld {
		t.Fatalf("@dope = %+v", got.UserGroup)
	}
}

func TestSync_ReportsAnomalies(t *testing.T) {
	f := newUserGroupFixture()
	pairs := []string{
		"u-1", "Engineering – DOPE",
		"u-2", "Engineering – DOPE",
		"u-3", "Engineering - DOPE,Platform",
		"", "- Lost",
	}
	for i := range maxAnomalyExamples + 2 {
		pairs = append(pairs, "", fmt.Sprintf("Team%02d -", i))
	}
	f.sync(pairs...)
	status, _ := f.svc.SyncStatus(context.Background(), ugAdmin)
	a := status.Anomalies
	if a.People != 4+maxAnomalyExamples+2 || a.Counts[string(AnomalyDash)] != 2 || a.Counts[string(AnomalySpacing)] != 1+maxAnomalyExamples+2 {
		t.Fatalf("anomalies = %+v", a)
	}
	if len(a.Examples) != maxAnomalyExamples || a.Examples[0].Value != "Engineering – DOPE" || a.Examples[0].People != 2 ||
		!slices.Equal(a.Examples[0].Kinds, []string{string(AnomalyDash)}) {
		t.Fatalf("examples = %+v", a.Examples)
	}
	if a.Examples[1].Value != "- Lost" {
		t.Fatalf("ties go by value: %+v", a.Examples[1])
	}
}

func TestSync_Failures(t *testing.T) {
	ctx := context.Background()

	// The group list can't be read: nothing happens, the status stays.
	f := newUserGroupFixture()
	f.store.listErr = errors.New("dynamo down")
	f.sync("u-1", "Engineering")
	if len(f.store.groups) != 0 || len(f.status.values) != 0 {
		t.Fatal("a sweep ran without its group list")
	}

	// A group whose members can't be read is skipped; the others sync.
	f = newUserGroupFixture()
	f.sync("u-1", "Engineering - DOPE")
	f.store.membersErr = errors.New("dynamo down")
	f.sync("u-1", "Engineering - DOPE", "u-2", "Sales")
	if _, ok := f.store.handles["sales"]; !ok {
		t.Fatal("one failing group stopped the others")
	}
	f.store.membersErr = nil

	// Members that can't be written are completed by the next sweep.
	f.store.applyErr = errors.New("dynamo down")
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE, Ops")
	if got := f.byHandle(t, "ops"); len(got.MemberIDs) != 0 || got.MemberCount != 1 {
		t.Fatalf("@ops after a failed member write = %+v", got.UserGroup)
	}
	f.store.applyErr = nil
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE, Ops")
	if got := f.byHandle(t, "ops").MemberIDs; !slices.Equal(got, []string{"u-2"}) {
		t.Fatalf("@ops after the next sweep = %v", got)
	}

	// A group that can't be created, or whose row can't be written, is
	// logged; the sweep goes on.
	f.store.createErr = store.ErrUserGroupSourceTaken
	f.store.updateErr = errors.New("dynamo down")
	f.sync("u-1", "Engineering - DOPE", "u-3", "Engineering - DOPE, Ops", "u-2", "Finance")
	if _, ok := f.store.handles["finance"]; ok {
		t.Fatal("a refused group was stored")
	}
	f.store.createErr, f.store.updateErr = nil, nil

	// The gone-group pass logs its failures too.
	f.store.membersErr = errors.New("dynamo down")
	f.sync("u-1", "Sales")
	f.store.membersErr = nil

	// The status cache can't be read or written: the sync still runs.
	f.status.getErr = errors.New("redis down")
	f.status.setErr = errors.New("redis down")
	f.sync("u-1", "Engineering - DOPE", "u-2", "Legal")
	if _, ok := f.store.handles["legal"]; !ok {
		t.Fatal("a cache failure stopped the sync")
	}
	if status, err := f.svc.SyncStatus(ctx, ugAdmin); err != nil || status.LastSyncedAt != nil {
		t.Fatalf("status with the cache down = %+v, %v", status, err)
	}
}

// --- shared copy on the mention paths ---

func TestUserGroups_WorkWithoutASharedCopyOrStatusCache(t *testing.T) {
	f := newUserGroupFixture()
	svc := NewUserGroupService(f.store, f.people, f.bots, f.pub)
	ctx := context.Background()
	svc.SyncDirectoryGroups(ctx, people("u-1", "Engineering - DOPE"))
	g := f.byHandle(t, "dope")
	if got, err := svc.EnabledHandles(ctx, []string{g.ID}); err != nil || got[g.ID] != "dope" {
		t.Fatalf("EnabledHandles = %v, %v", got, err)
	}
	svc.SyncDirectoryGroups(ctx, people("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE"))
	if status, err := svc.SyncStatus(ctx, ugAdmin); err != nil || status.LastSyncedAt != nil {
		t.Fatalf("status without a cache = %+v, %v", status, err)
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
	f.sync("u-1", "Engineering - DOPE")
	g := f.byHandle(t, "dope")
	warm := func() {
		t.Helper()
		if _, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID}); err != nil || f.copies.current(g.ID) == nil {
			t.Fatalf("warming the copy: %v", err)
		}
	}

	warm()
	f.sync("u-1", "Engineering - DOPE", "u-2", "Engineering - DOPE")
	if f.copies.current(g.ID) != nil {
		t.Fatal("the copy from before the sync is still there")
	}
	got, err := f.svc.MentionedMembers(ctx, "u-3", []string{g.ID})
	if err != nil || !slices.Equal(got[g.ID], []string{"u-1", "u-2"}) {
		t.Fatalf("MentionedMembers = %v, %v; want the members after the sync", got, err)
	}

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

func TestDiffMembers(t *testing.T) {
	added, removed := diffMembers([]string{"a", "b", "c"}, []string{"c", "d", "a", "e"})
	if !slices.Equal(added, []string{"d", "e"}) || !slices.Equal(removed, []string{"b"}) {
		t.Fatalf("diff = +%v -%v", added, removed)
	}
	if a, r := diffMembers(nil, nil); a != nil || r != nil {
		t.Fatalf("empty diff = %v %v", a, r)
	}
}
