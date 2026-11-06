//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func newTestUserGroup(id, handle string, members ...string) *model.UserGroupDetail {
	now := time.Now().Truncate(time.Millisecond)
	return &model.UserGroupDetail{
		UserGroup: model.UserGroup{
			ID: id, Handle: handle, Name: "Group " + handle, Description: "desc",
			MemberCount: len(members), CreatedBy: "u-admin", CreatedAt: now, UpdatedAt: now,
		},
		MemberIDs: members,
	}
}

// prior is the row as read before an update: its handle and version.
func prior(handle string, version int64) *model.UserGroupDetail {
	return &model.UserGroupDetail{UserGroup: model.UserGroup{Handle: handle}, Version: version}
}

func TestUserGroupStore_CreateGetListAndHandles(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserGroupStore(db)

	oncall := newTestUserGroup("group-1", "oncall", "u-1", "u-2")
	if err := s.CreateUserGroup(ctx, oncall); err != nil {
		t.Fatalf("CreateUserGroup: %v", err)
	}
	if oncall.Version != 1 {
		t.Fatalf("Version = %d, want 1", oncall.Version)
	}
	if err := s.CreateUserGroup(ctx, newTestUserGroup("group-2", "design")); err != nil {
		t.Fatalf("CreateUserGroup design: %v", err)
	}

	got, err := s.GetUserGroup(ctx, "group-1")
	if err != nil || got.Handle != "oncall" || !slices.Equal(got.MemberIDs, []string{"u-1", "u-2"}) || got.Version != 1 || got.MemberCount != 2 {
		t.Fatalf("GetUserGroup = %+v, %v", got, err)
	}
	if _, err := s.GetUserGroup(ctx, "group-nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetUserGroup missing = %v, want ErrNotFound", err)
	}

	listed, err := s.ListUserGroups(ctx)
	if err != nil || len(listed) != 2 || listed[0].Handle != "design" || listed[1].Handle != "oncall" {
		t.Fatalf("ListUserGroups = %+v, %v; want both, by handle", listed, err)
	}

	batch, err := s.GetUserGroups(ctx, []string{"group-1", "group-nope", "group-1"})
	if err != nil || len(batch) != 1 || batch[0].ID != "group-1" {
		t.Fatalf("GetUserGroups = %+v, %v", batch, err)
	}
	if none, err := s.GetUserGroups(ctx, nil); err != nil || none != nil {
		t.Fatalf("GetUserGroups(nil) = %v, %v", none, err)
	}

	if owner, err := s.UserGroupHandleOwner(ctx, "oncall"); err != nil || owner != "group-1" {
		t.Fatalf("UserGroupHandleOwner = %q, %v", owner, err)
	}
	if _, err := s.UserGroupHandleOwner(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UserGroupHandleOwner(nobody) = %v, want ErrNotFound", err)
	}
}

func TestUserGroupStore_HandlesAreUniqueAcrossGroupsAndBots(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	groups := NewUserGroupStore(db)
	bots := NewBotStore(db)

	if err := groups.CreateUserGroup(ctx, newTestUserGroup("group-1", "oncall")); err != nil {
		t.Fatal(err)
	}
	if err := groups.CreateUserGroup(ctx, newTestUserGroup("group-2", "oncall")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate handle = %v, want ErrAlreadyExists", err)
	}
	if err := bots.CreateBot(ctx, newTestBot("b-1", "deploy-bot")); err != nil {
		t.Fatal(err)
	}
	if err := groups.CreateUserGroup(ctx, newTestUserGroup("group-3", "deploy-bot")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("handle equal to a bot username = %v, want ErrAlreadyExists", err)
	}
	// And the other way round: a bot can't take a group's handle.
	if err := bots.CreateBot(ctx, newTestBot("b-2", "oncall")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("bot named like a group = %v, want ErrAlreadyExists", err)
	}
	bot, _ := NewUserStore(db).GetUser(ctx, "b-1")
	bot.Username = "oncall"
	if err := bots.UpdateBot(ctx, bot, "deploy-bot"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("bot renamed to a group handle = %v, want ErrAlreadyExists", err)
	}
	if owner, err := bots.UsernameOwner(ctx, "deploy-bot"); err != nil || owner != "b-1" {
		t.Fatalf("the refused rename moved the bot's claim: %q, %v", owner, err)
	}
	if _, err := groups.GetUserGroup(ctx, "group-3"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a refused group was written: %v", err)
	}
}

func TestUserGroupStore_UpdateIsVersionedAndMovesTheHandleClaim(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserGroupStore(db)
	g := newTestUserGroup("group-1", "oncall", "u-1")
	if err := s.CreateUserGroup(ctx, g); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateUserGroup(ctx, newTestUserGroup("group-2", "sre")); err != nil {
		t.Fatal(err)
	}

	g.Handle, g.MemberIDs, g.MemberCount = "on-call", []string{"u-1", "u-2"}, 2
	if err := s.UpdateUserGroup(ctx, g, prior("oncall", 1)); err != nil {
		t.Fatalf("UpdateUserGroup: %v", err)
	}
	if g.Version != 2 {
		t.Fatalf("Version = %d, want 2", g.Version)
	}
	got, _ := s.GetUserGroup(ctx, "group-1")
	if got.Handle != "on-call" || !slices.Equal(got.MemberIDs, []string{"u-1", "u-2"}) || got.Version != 2 {
		t.Fatalf("stored = %+v", got)
	}
	if _, err := s.UserGroupHandleOwner(ctx, "oncall"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old handle still claimed: %v", err)
	}
	if owner, _ := s.UserGroupHandleOwner(ctx, "on-call"); owner != "group-1" {
		t.Fatalf("new handle owner = %q", owner)
	}
	listed, _ := s.ListUserGroups(ctx)
	if len(listed) != 2 || listed[0].Handle != "on-call" {
		t.Fatalf("listing not re-sorted by the new handle: %+v", listed)
	}

	// A stale version loses, and leaves the group as it was.
	g.MemberIDs = []string{"u-9"}
	if err := s.UpdateUserGroup(ctx, g, prior("on-call", 1)); !errors.Is(err, ErrUserGroupChanged) {
		t.Fatalf("stale update = %v, want ErrUserGroupChanged", err)
	}
	if g.Version != 1 {
		t.Fatalf("a failed update left Version = %d, want the expected version back", g.Version)
	}
	if got, _ := s.GetUserGroup(ctx, "group-1"); !slices.Equal(got.MemberIDs, []string{"u-1", "u-2"}) {
		t.Fatalf("stale update applied: %v", got.MemberIDs)
	}

	// Taking another group's handle fails as a taken handle.
	g.MemberIDs = []string{"u-1"}
	g.Handle = "sre"
	if err := s.UpdateUserGroup(ctx, g, prior("on-call", 2)); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("update to a taken handle = %v, want ErrAlreadyExists", err)
	}

	// A group that is gone reads as changed.
	gone := newTestUserGroup("group-gone", "gone")
	if err := s.UpdateUserGroup(ctx, gone, prior("gone", 1)); !errors.Is(err, ErrUserGroupChanged) {
		t.Fatalf("update of a missing group = %v, want ErrUserGroupChanged", err)
	}
}

func TestUserGroupStore_FaultArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewUserGroupStore(db).CreateUserGroup(ctx, newTestUserGroup("group-1", "oncall")); err != nil {
		t.Fatal(err)
	}
	g := newTestUserGroup("group-1", "oncall")

	failing := NewUserGroupStore(withFault(db, func(f *faultClient) {
		f.failGetItem, f.failQuery, f.failBatchGetItem, f.failTransactWriteItems = true, true, true, true
	}))
	for name, err := range map[string]error{
		"create": failing.CreateUserGroup(ctx, newTestUserGroup("group-2", "x2")),
		"update": failing.UpdateUserGroup(ctx, g, prior("oncall", 1)),
		"get":    func() error { _, err := failing.GetUserGroup(ctx, "group-1"); return err }(),
		"batch":  func() error { _, err := failing.GetUserGroups(ctx, []string{"group-1"}); return err }(),
		"list":   func() error { _, err := failing.ListUserGroups(ctx); return err }(),
		"owner":  func() error { _, err := failing.UserGroupHandleOwner(ctx, "oncall"); return err }(),
	} {
		if !errors.Is(err, errInjected) {
			t.Errorf("%s: err = %v, want the injected fault", name, err)
		}
	}

	corrupt := NewUserGroupStore(withFault(db, func(f *faultClient) {
		f.transformGetItem = corruptGetItem
		f.transformQuery = corruptQuery
		f.transformBatchGetItem = corruptBatchGetOut(db)
	}))
	_, getErr := corrupt.GetUserGroup(ctx, "group-1")
	assertUnmarshalErr(t, getErr, "user group get")
	_, ownerErr := corrupt.UserGroupHandleOwner(ctx, "oncall")
	assertUnmarshalErr(t, ownerErr, "user group handle owner")
	_, listErr := corrupt.ListUserGroups(ctx)
	assertUnmarshalErr(t, listErr, "user group list")
	_, batchErr := corrupt.GetUserGroups(ctx, []string{"group-1"})
	assertUnmarshalErr(t, batchErr, "user group batch")
}

func TestUserGroupStore_EntraClaimIsUniqueAndMoves(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserGroupStore(db)

	linked := newTestUserGroup("group-1", "oncall", "u-1")
	linked.EntraGroupID = "entra-A"
	if err := s.CreateUserGroup(ctx, linked); err != nil {
		t.Fatalf("create linked: %v", err)
	}
	if got, _ := s.GetUserGroup(ctx, "group-1"); got.EntraGroupID != "entra-A" {
		t.Fatalf("stored link = %q", got.EntraGroupID)
	}

	// Another group can't be created on, or linked to, the same Entra group.
	dup := newTestUserGroup("group-2", "sre")
	dup.EntraGroupID = "entra-A"
	if err := s.CreateUserGroup(ctx, dup); !errors.Is(err, ErrEntraGroupLinked) {
		t.Fatalf("create on a linked Entra group = %v, want ErrEntraGroupLinked", err)
	}
	other := newTestUserGroup("group-3", "design")
	if err := s.CreateUserGroup(ctx, other); err != nil {
		t.Fatal(err)
	}
	stale := *other
	stale.EntraGroupID = "entra-A"
	if err := s.UpdateUserGroup(ctx, &stale, other); !errors.Is(err, ErrEntraGroupLinked) {
		t.Fatalf("link to a linked Entra group = %v, want ErrEntraGroupLinked", err)
	}

	// Relinking group-1 to entra-B frees entra-A, which group-3 can then take.
	read, _ := s.GetUserGroup(ctx, "group-1")
	relinked := *read
	relinked.EntraGroupID = "entra-B"
	if err := s.UpdateUserGroup(ctx, &relinked, read); err != nil {
		t.Fatalf("relink: %v", err)
	}
	read3, _ := s.GetUserGroup(ctx, "group-3")
	take := *read3
	take.EntraGroupID = "entra-A"
	if err := s.UpdateUserGroup(ctx, &take, read3); err != nil {
		t.Fatalf("link to the freed Entra group: %v", err)
	}

	// Unlinking frees the claim.
	read, _ = s.GetUserGroup(ctx, "group-1")
	unlinked := *read
	unlinked.EntraGroupID = ""
	if err := s.UpdateUserGroup(ctx, &unlinked, read); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	again := newTestUserGroup("group-4", "again")
	again.EntraGroupID = "entra-B"
	if err := s.CreateUserGroup(ctx, again); err != nil {
		t.Fatalf("create on the unlinked Entra group: %v", err)
	}
}

func TestUserGroupStore_ThousandMembersInOneRow(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserGroupStore(db)
	members := make([]string, 1000)
	for i := range members {
		members[i] = fmt.Sprintf("01JTESTMEMBER%013d", i)
	}
	if err := s.CreateUserGroup(ctx, newTestUserGroup("group-big", "big", members...)); err != nil {
		t.Fatalf("create a 1000-member group: %v", err)
	}
	if got, err := s.GetUserGroup(ctx, "group-big"); err != nil || len(got.MemberIDs) != 1000 {
		t.Fatalf("read back = %d members, %v", len(got.MemberIDs), err)
	}
}
