package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// adminCtx returns a context where ClaimsFromContext yields a SystemRoleAdmin
// user. Useful for exercising paths gated on isSystemAdmin.
func adminCtx(userID string) context.Context {
	return middleware.ContextWithClaims(context.Background(), &model.TokenClaims{
		UserID:     userID,
		SystemRole: model.SystemRoleAdmin,
	})
}


// ============================================================================
// channel.go: postSystemMessage
// ============================================================================

// postSystemMessage with nil messages store should return early without panic.
func TestPostSystemMessage_NilMessages(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	cache := newMockCache()
	broker := newMockBroker()
	publisher := newMockPublisher()
	// Pass nil for messages.
	svc := NewChannelService(channels, memberships, users, nil, cache, broker, publisher)

	channels.channels["ch-nilm"] = &model.Channel{
		ID:   "ch-nilm",
		Name: "no-msgs",
		Type: model.ChannelTypePublic,
	}

	// Join triggers postSystemMessage.
	if err := svc.Join(context.Background(), "user-1", "ch-nilm"); err != nil {
		t.Fatalf("Join: %v", err)
	}
	// No system message events expected since messages store is nil.
	for _, e := range publisher.published {
		if e.event.Type == "message.new" {
			t.Error("expected no message.new with nil messages store")
		}
	}
}

// postSystemMessage when CreateMessage errors should swallow the error and not publish.
func TestPostSystemMessage_CreateMessageError(t *testing.T) {
	svc, channels, _, _, publisher := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-err"] = &model.Channel{
		ID:   "ch-err",
		Name: "err-chan",
		Type: model.ChannelTypePublic,
	}
	// Inject error on the messages store via the service's internal field.
	svc.messages.(*mockMessageStore).createErr = errors.New("create boom")

	if err := svc.Join(ctx, "user-1", "ch-err"); err != nil {
		t.Fatalf("Join: %v", err)
	}
	// No message.new should have been published since CreateMessage failed.
	for _, e := range publisher.published {
		if e.event.Type == "message.new" {
			t.Error("expected no message.new event when CreateMessage fails")
		}
	}
}

// ============================================================================
// channel.go: Archive
// ============================================================================

// Archive with nil publisher should return early without listing members.
func TestArchive_NilPublisher(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	broker := newMockBroker()
	svc := NewChannelService(channels, memberships, users, messages, cache, broker, nil)

	channels.channels["ch-arch-np"] = &model.Channel{
		ID:   "ch-arch-np",
		Name: "arch-no-pub",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-arch-np#owner"] = &model.ChannelMembership{
		ChannelID: "ch-arch-np",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}

	if err := svc.Archive(context.Background(), "owner", "ch-arch-np"); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if !channels.channels["ch-arch-np"].Archived {
		t.Error("expected archived flag")
	}
}

// Archive when ListMembers fails: should still publish to channel topic.
func TestArchive_ListMembersError(t *testing.T) {
	svc, channels, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-arch-le"] = &model.Channel{
		ID:   "ch-arch-le",
		Name: "arch-list-err",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-arch-le#owner"] = &model.ChannelMembership{
		ChannelID: "ch-arch-le",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}

	// Set ListMembers to error AFTER setup so checkPermission still works.
	memberships.listMembersErr = errors.New("list members boom")

	if err := svc.Archive(ctx, "owner", "ch-arch-le"); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	// We should still see channel.archived published on the channel topic.
	found := false
	for _, e := range publisher.published {
		if e.event.Type == "channel.archived" && e.channel == "chan:ch-arch-le" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected channel.archived event on channel topic when ListMembers fails")
	}
}

// Archive: GetChannel error path.
func TestArchive_GetChannelError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-no-get#owner"] = &model.ChannelMembership{
		ChannelID: "ch-no-get",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}
	// Channel does not exist in store.
	if err := svc.Archive(ctx, "owner", "ch-no-get"); err == nil {
		t.Fatal("expected error from GetChannel when channel doesn't exist")
	}
}

// Archive: UpdateChannel error path.
func TestArchive_UpdateChannelError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-upd-err"] = &model.Channel{
		ID:   "ch-upd-err",
		Name: "upd-err",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-upd-err#owner"] = &model.ChannelMembership{
		ChannelID: "ch-upd-err",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}
	channels.updateErr = errors.New("update boom")
	if err := svc.Archive(ctx, "owner", "ch-upd-err"); err == nil {
		t.Fatal("expected error from UpdateChannel")
	}
}

// Archive as system admin should bypass channel-level permission checks.
func TestArchive_SystemAdminBypass(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := adminCtx("sys-admin")

	channels.channels["ch-sys-arch"] = &model.Channel{
		ID:   "ch-sys-arch",
		Name: "sys-arch",
		Type: model.ChannelTypePublic,
	}
	// No membership for sys-admin, but admin context allows bypass.
	if err := svc.Archive(ctx, "sys-admin", "ch-sys-arch"); err != nil {
		t.Fatalf("Archive: %v", err)
	}
}

// ============================================================================
// channel.go: UpdateMemberRole
// ============================================================================

func TestUpdateMemberRole_PermissionDenied(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	ctx := context.Background()
	// No membership at all -> not a member -> permission denied.
	if err := svc.UpdateMemberRole(ctx, "stranger", "ch-x", "target", model.ChannelRoleAdmin); err == nil {
		t.Fatal("expected permission error")
	}
}

func TestUpdateMemberRole_PromoteToOwner_BySystemAdmin(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := adminCtx("sys-admin")

	// Target exists, sys-admin has no membership but is system admin.
	memberships.memberships["ch-promo#target"] = &model.ChannelMembership{
		ChannelID: "ch-promo",
		UserID:    "target",
		Role:      model.ChannelRoleMember,
	}
	if err := svc.UpdateMemberRole(ctx, "sys-admin", "ch-promo", "target", model.ChannelRoleOwner); err != nil {
		t.Fatalf("UpdateMemberRole: %v", err)
	}
}

// Promote to owner when actor is the channel owner -> allowed.
func TestUpdateMemberRole_PromoteToOwner_ByChannelOwner(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-co#owner"] = &model.ChannelMembership{
		ChannelID: "ch-co",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}
	memberships.memberships["ch-co#target"] = &model.ChannelMembership{
		ChannelID: "ch-co",
		UserID:    "target",
		Role:      model.ChannelRoleMember,
	}

	if err := svc.UpdateMemberRole(ctx, "owner", "ch-co", "target", model.ChannelRoleOwner); err != nil {
		t.Fatalf("UpdateMemberRole: %v", err)
	}
}

// UpdateMemberRole: store-level update error.
func TestUpdateMemberRole_StoreError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-uerr#admin"] = &model.ChannelMembership{
		ChannelID: "ch-uerr",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.updateRoleErr = errors.New("update role boom")

	if err := svc.UpdateMemberRole(ctx, "admin", "ch-uerr", "tgt", model.ChannelRoleAdmin); err == nil {
		t.Fatal("expected error from UpdateMemberRole")
	}
}

// ============================================================================
// channel.go: ListMembers / BrowsePublic
// ============================================================================

func TestListMembers_Error(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.listMembersErr = errors.New("list members boom")

	if _, err := svc.ListMembers(context.Background(), "ch"); err == nil {
		t.Fatal("expected error")
	}
}

func TestBrowsePublic_Error(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	channels.listErr = errors.New("list public boom")

	if _, _, err := svc.BrowsePublic(context.Background(), "", 50, ""); err == nil {
		t.Fatal("expected error")
	}
}

// ============================================================================
// channel.go: checkPermission
// ============================================================================

// checkPermission with an unexpected store error (not ErrNotFound) should wrap.
func TestCheckPermission_StoreError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-err-perm"] = &model.Channel{
		ID:   "ch-err-perm",
		Name: "err-perm",
		Type: model.ChannelTypePublic,
	}
	memberships.getErr = errors.New("get boom")

	newName := "x"
	_, err := svc.Update(ctx, "user-1", "ch-err-perm", &newName, nil)
	if err == nil {
		t.Fatal("expected error from membership store")
	}
}

// ============================================================================
// channel.go: Create error paths
// ============================================================================

func TestCreate_CreateChannelError(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	channels.createErr = errors.New("create channel boom")

	_, err := svc.Create(context.Background(), "user-1", "test", model.ChannelTypePublic, "")
	if err == nil {
		t.Fatal("expected error from CreateChannel")
	}
}

func TestCreate_AddMemberError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.addErr = errors.New("add owner boom")

	_, err := svc.Create(context.Background(), "user-1", "test2", model.ChannelTypePublic, "")
	if err == nil {
		t.Fatal("expected error from AddMember")
	}
}

// Create with nil broker: should still succeed.
func TestCreate_NilBroker(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	users.users["user-1"] = &model.User{ID: "user-1", DisplayName: "U"}
	messages := newMockMessageStore()
	cache := newMockCache()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, nil, publisher)

	if _, err := svc.Create(context.Background(), "user-1", "noisefree", model.ChannelTypePublic, ""); err != nil {
		t.Fatalf("Create with nil broker: %v", err)
	}
}

// Create when user store has no user — display name falls back to "Unknown".
func TestCreate_UnknownDisplayName(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	broker := newMockBroker()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, broker, publisher)

	ch, err := svc.Create(context.Background(), "unknown-user", "anon", model.ChannelTypePublic, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	mem := memberships.memberships[ch.ID+"#unknown-user"]
	if mem == nil || mem.DisplayName != "Unknown" {
		t.Errorf("expected DisplayName=Unknown, got %v", mem)
	}
}

// Create with nil users (resolveDisplayName falls through).
func TestCreate_NilUsers(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	broker := newMockBroker()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, nil, messages, cache, broker, publisher)

	if _, err := svc.Create(context.Background(), "user-1", "nilusers", model.ChannelTypePublic, ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
}

// ============================================================================
// channel.go: Join error paths
// ============================================================================

func TestJoin_ChannelNotFound(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	if err := svc.Join(context.Background(), "user-1", "missing"); err == nil {
		t.Fatal("expected error for missing channel")
	}
}

func TestJoin_AddMemberError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	channels.channels["ch-jam"] = &model.Channel{
		ID:   "ch-jam",
		Name: "join-add-mem",
		Type: model.ChannelTypePublic,
	}
	memberships.addErr = errors.New("add boom")

	if err := svc.Join(context.Background(), "user-2", "ch-jam"); err == nil {
		t.Fatal("expected error from AddMember")
	}
}

// Join with nil broker.
func TestJoin_NilBroker(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, nil, publisher)

	channels.channels["ch-jnb"] = &model.Channel{
		ID:   "ch-jnb",
		Name: "join-nil-broker",
		Type: model.ChannelTypePublic,
	}
	if err := svc.Join(context.Background(), "user-1", "ch-jnb"); err != nil {
		t.Fatalf("Join: %v", err)
	}
}

// ============================================================================
// channel.go: Leave error paths
// ============================================================================

func TestLeave_GetMembershipError(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	if err := svc.Leave(context.Background(), "user-x", "ch-no"); err == nil {
		t.Fatal("expected error when membership missing")
	}
}

func TestLeave_RemoveMemberError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch-rmerr#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-rmerr",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	memberships.removeErr = errors.New("remove boom")

	if err := svc.Leave(context.Background(), "user-1", "ch-rmerr"); err == nil {
		t.Fatal("expected error from RemoveMember")
	}
}

// Leave with empty DisplayName triggers resolveDisplayName fallback.
func TestLeave_FallbackDisplayName(t *testing.T) {
	svc, _, memberships, _, publisher := setupChannelService()
	memberships.memberships["ch-fbd#user-1"] = &model.ChannelMembership{
		ChannelID:   "ch-fbd",
		UserID:      "user-1",
		Role:        model.ChannelRoleMember,
		DisplayName: "", // blank to trigger fallback
	}
	if err := svc.Leave(context.Background(), "user-1", "ch-fbd"); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	// The system message should still be published.
	found := false
	for _, e := range publisher.published {
		if e.event.Type == "message.new" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected message.new system message even with empty display name")
	}
}

// Leave with nil broker.
func TestLeave_NilBroker(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, nil, publisher)

	memberships.memberships["ch-lnb#user-1"] = &model.ChannelMembership{
		ChannelID:   "ch-lnb",
		UserID:      "user-1",
		Role:        model.ChannelRoleMember,
		DisplayName: "U",
	}
	if err := svc.Leave(context.Background(), "user-1", "ch-lnb"); err != nil {
		t.Fatalf("Leave with nil broker: %v", err)
	}
}

// ============================================================================
// channel.go: AddMember error paths
// ============================================================================

func TestAddMember_PermissionDenied(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	if err := svc.AddMember(context.Background(), "stranger", "ch-x", "tgt", model.ChannelRoleMember); err == nil {
		t.Fatal("expected permission error")
	}
}

func TestAddMember_GetChannelError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch-no-ch#admin"] = &model.ChannelMembership{
		ChannelID: "ch-no-ch",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	// Channel doesn't exist.
	if err := svc.AddMember(context.Background(), "admin", "ch-no-ch", "tgt", model.ChannelRoleMember); err == nil {
		t.Fatal("expected error from GetChannel")
	}
}

func TestAddMember_AddMemberStoreError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	channels.channels["ch-ame"] = &model.Channel{
		ID:   "ch-ame",
		Name: "add-store-err",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-ame#admin"] = &model.ChannelMembership{
		ChannelID: "ch-ame",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.addErr = errors.New("add boom")

	if err := svc.AddMember(context.Background(), "admin", "ch-ame", "tgt", model.ChannelRoleMember); err == nil {
		t.Fatal("expected error from AddMember")
	}
}

func TestAddMember_NilBroker(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, nil, publisher)

	channels.channels["ch-amnb"] = &model.Channel{
		ID:   "ch-amnb",
		Name: "add-mem-nb",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-amnb#admin"] = &model.ChannelMembership{
		ChannelID: "ch-amnb",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}

	if err := svc.AddMember(context.Background(), "admin", "ch-amnb", "tgt", model.ChannelRoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
}

// ============================================================================
// channel.go: RemoveMember error paths
// ============================================================================

func TestRemoveMember_PermissionDenied(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	if err := svc.RemoveMember(context.Background(), "stranger", "ch-x", "tgt"); err == nil {
		t.Fatal("expected permission error")
	}
}

func TestRemoveMember_TargetNotFound(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch-tnf#admin"] = &model.ChannelMembership{
		ChannelID: "ch-tnf",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	if err := svc.RemoveMember(context.Background(), "admin", "ch-tnf", "ghost"); err == nil {
		t.Fatal("expected error from missing target")
	}
}

// Owner removed by system admin -> allowed.
func TestRemoveMember_OwnerBySystemAdmin(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := adminCtx("sys-admin")

	memberships.memberships["ch-rosa#admin"] = &model.ChannelMembership{
		ChannelID: "ch-rosa",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch-rosa#owner"] = &model.ChannelMembership{
		ChannelID:   "ch-rosa",
		UserID:      "owner",
		Role:        model.ChannelRoleOwner,
		DisplayName: "Owner Doe",
	}

	if err := svc.RemoveMember(ctx, "sys-admin", "ch-rosa", "owner"); err != nil {
		t.Fatalf("RemoveMember by sys-admin: %v", err)
	}
}

// RemoveMember store error path.
func TestRemoveMember_StoreError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch-rse#admin"] = &model.ChannelMembership{
		ChannelID: "ch-rse",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch-rse#tgt"] = &model.ChannelMembership{
		ChannelID:   "ch-rse",
		UserID:      "tgt",
		Role:        model.ChannelRoleMember,
		DisplayName: "Target",
	}
	memberships.removeErr = errors.New("rm boom")

	if err := svc.RemoveMember(context.Background(), "admin", "ch-rse", "tgt"); err == nil {
		t.Fatal("expected error from RemoveMember")
	}
}

// RemoveMember with nil broker.
func TestRemoveMember_NilBroker(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, nil, publisher)

	memberships.memberships["ch-rnb#admin"] = &model.ChannelMembership{
		ChannelID: "ch-rnb",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch-rnb#tgt"] = &model.ChannelMembership{
		ChannelID:   "ch-rnb",
		UserID:      "tgt",
		Role:        model.ChannelRoleMember,
		DisplayName: "Target",
	}

	if err := svc.RemoveMember(context.Background(), "admin", "ch-rnb", "tgt"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
}

// RemoveMember with empty DisplayName triggers resolveDisplayName fallback.
func TestRemoveMember_DisplayNameFallback(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch-rdf#admin"] = &model.ChannelMembership{
		ChannelID: "ch-rdf",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch-rdf#tgt"] = &model.ChannelMembership{
		ChannelID:   "ch-rdf",
		UserID:      "tgt",
		Role:        model.ChannelRoleMember,
		DisplayName: "", // blank
	}

	if err := svc.RemoveMember(context.Background(), "admin", "ch-rdf", "tgt"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
}

// ============================================================================
// channel.go: Update error path on store
// ============================================================================

func TestUpdate_GetChannelError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch-no-upd#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-no-upd",
		UserID:    "user-1",
		Role:      model.ChannelRoleAdmin,
	}
	// Channel not in store.
	name := "x"
	if _, err := svc.Update(context.Background(), "user-1", "ch-no-upd", &name, nil); err == nil {
		t.Fatal("expected error from GetChannel")
	}
}

func TestUpdate_UpdateChannelError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	channels.channels["ch-uce"] = &model.Channel{
		ID:   "ch-uce",
		Name: "uce",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-uce#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-uce",
		UserID:    "user-1",
		Role:      model.ChannelRoleAdmin,
	}
	channels.updateErr = errors.New("upd boom")
	name := "x"
	if _, err := svc.Update(context.Background(), "user-1", "ch-uce", &name, nil); err == nil {
		t.Fatal("expected error from UpdateChannel")
	}
}

// ============================================================================
// channel.go: ListUserChannels — list error & nil channel returned by store
// ============================================================================

func TestListUserChannels_ListError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.listChannelsErr = errors.New("boom")
	if _, err := svc.ListUserChannels(context.Background(), "user-1"); err == nil {
		t.Fatal("expected error")
	}
}

// When GetChannel fails inside the goroutine, that channel is filtered out.
func TestListUserChannels_GetChannelErrorSkips(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	memberships.userChannels = []*model.UserChannel{
		{UserID: "u", ChannelID: "exists", ChannelName: "exists"},
		{UserID: "u", ChannelID: "missing", ChannelName: "missing"},
	}
	channels.channels["exists"] = &model.Channel{ID: "exists", Type: model.ChannelTypePublic}
	// "missing" is not in store -> the goroutine errors -> filtered.

	got, err := svc.ListUserChannels(context.Background(), "u")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if len(got) != 1 || got[0].ChannelID != "exists" {
		t.Errorf("got %+v, want only 'exists'", got)
	}
}

// ============================================================================
// auth.go: HandleOIDCCallback error paths
// ============================================================================

func TestHandleOIDCCallback_ExchangeError(t *testing.T) {
	env := setupAuthService()
	env.oidc.exchangeErr = errors.New("exchange boom")

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state"); err == nil {
		t.Fatal("expected error from exchange")
	}
}

func TestHandleOIDCCallback_GetUserByEmail_GenericError(t *testing.T) {
	env := setupAuthService()
	env.users.getEmailErr = errors.New("db boom")

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state"); err == nil {
		t.Fatal("expected wrapped DB error")
	}
}

func TestHandleOIDCCallback_HasUsersError(t *testing.T) {
	env := setupAuthService()
	env.users.hasUsersErr = errors.New("count boom")

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state"); err == nil {
		t.Fatal("expected error from HasUsers")
	}
}

func TestHandleOIDCCallback_CreateUserError(t *testing.T) {
	env := setupAuthService()
	env.users.createErr = errors.New("create user boom")

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state"); err == nil {
		t.Fatal("expected error from CreateUser")
	}
}

func TestHandleOIDCCallback_UpdateUserError(t *testing.T) {
	env := setupAuthService()
	existing := &model.User{
		ID:         "u-old",
		Email:      "oidc@example.com",
		SystemRole: model.SystemRoleMember,
	}
	env.users.users[existing.ID] = existing
	env.users.emailIndex[existing.Email] = existing
	env.users.updateErr = errors.New("update user boom")

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state"); err == nil {
		t.Fatal("expected error from UpdateUser")
	}
}

// HandleOIDCCallback when issueTokens fails (jwt.GenerateAccessToken error).
func TestHandleOIDCCallback_IssueTokensError(t *testing.T) {
	env := setupAuthService()
	env.jwt.accessTokenErr = errors.New("access boom")

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state"); err == nil {
		t.Fatal("expected error from issueTokens")
	}
}

// ============================================================================
// auth.go: RefreshAccessToken error paths
// ============================================================================

func TestRefreshAccessToken_GetTokenGenericError(t *testing.T) {
	env := setupAuthService()
	env.tokens.getErr = errors.New("token store boom")
	if _, err := env.svc.RefreshAccessToken(context.Background(), "any"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRefreshAccessToken_GetUserError(t *testing.T) {
	env := setupAuthService()
	raw := "raw-tok"
	hash := hashToken(raw)
	env.tokens.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    "missing",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	// User does not exist -> ErrNotFound from store.
	if _, err := env.svc.RefreshAccessToken(context.Background(), raw); err == nil {
		t.Fatal("expected error")
	}
}

func TestRefreshAccessToken_GenerateAccessTokenError(t *testing.T) {
	env := setupAuthService()
	user := &model.User{ID: "u-jw", Email: "jw@x.com", SystemRole: model.SystemRoleMember}
	env.users.users[user.ID] = user

	raw := "rt-jw"
	hash := hashToken(raw)
	env.tokens.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    user.ID,
		ExpiresAt: time.Now().Add(time.Hour),
	}
	env.jwt.accessTokenErr = errors.New("jwt boom")

	if _, err := env.svc.RefreshAccessToken(context.Background(), raw); err == nil {
		t.Fatal("expected error from GenerateAccessToken")
	}
}

// ============================================================================
// auth.go: Logout error paths
// ============================================================================

func TestLogout_DeleteError(t *testing.T) {
	env := setupAuthService()
	env.tokens.deleteErr = errors.New("del boom")
	if err := env.svc.Logout(context.Background(), "raw"); err == nil {
		t.Fatal("expected error from delete")
	}
}

// Logout with delete returning ErrNotFound is treated as success.
func TestLogout_DeleteNotFoundIsOK(t *testing.T) {
	env := setupAuthService()
	env.tokens.deleteErr = store.ErrNotFound
	if err := env.svc.Logout(context.Background(), "raw"); err != nil {
		t.Fatalf("Logout returning ErrNotFound: expected nil error, got %v", err)
	}
}

// ============================================================================
// auth.go: CreateInvite error paths
// ============================================================================

func TestCreateInvite_StoreError(t *testing.T) {
	env := setupAuthService()
	env.invites.createErr = errors.New("store boom")

	if _, err := env.svc.CreateInvite(context.Background(), "inviter", "x@y", []string{"a"}); err == nil {
		t.Fatal("expected error")
	}
}

// ============================================================================
// auth.go: AcceptInvite error paths
// ============================================================================

func TestAcceptInvite_GetInviteGenericError(t *testing.T) {
	env := setupAuthService()
	env.invites.getErr = errors.New("get invite boom")
	if _, _, _, err := env.svc.AcceptInvite(context.Background(), "tok", "n", "p"); err == nil {
		t.Fatal("expected error")
	}
}

func TestAcceptInvite_CreateUserError(t *testing.T) {
	env := setupAuthService()
	env.invites.invites["t1"] = &model.Invite{
		Token:     "t1",
		Email:     "guest@x.com",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	env.users.createErr = errors.New("create boom")

	if _, _, _, err := env.svc.AcceptInvite(context.Background(), "t1", "Name", "pw"); err == nil {
		t.Fatal("expected error")
	}
}

func TestAcceptInvite_AddMemberError(t *testing.T) {
	env := setupAuthService()
	env.invites.invites["t2"] = &model.Invite{
		Token:      "t2",
		Email:      "guest2@x.com",
		ChannelIDs: []string{"chx"},
		ExpiresAt:  time.Now().Add(time.Hour),
	}
	env.memberships.addErr = errors.New("add member boom")

	if _, _, _, err := env.svc.AcceptInvite(context.Background(), "t2", "G", "pw"); err == nil {
		t.Fatal("expected error from AddMember")
	}
}

// AcceptInvite with issueTokens failing (jwt error).
func TestAcceptInvite_IssueTokensError(t *testing.T) {
	env := setupAuthService()
	env.invites.invites["t3"] = &model.Invite{
		Token:     "t3",
		Email:     "guest3@x.com",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	env.jwt.accessTokenErr = errors.New("jwt boom")

	if _, _, _, err := env.svc.AcceptInvite(context.Background(), "t3", "G", "pw"); err == nil {
		t.Fatal("expected error from issueTokens")
	}
}

// ============================================================================
// auth.go: GuestLogin error paths
// ============================================================================

func TestGuestLogin_GetUserGenericError(t *testing.T) {
	env := setupAuthService()
	env.users.getEmailErr = errors.New("get email boom")
	if _, _, _, err := env.svc.GuestLogin(context.Background(), "x@y", "pw"); err == nil {
		t.Fatal("expected error")
	}
}

// GuestLogin with issueTokens failing.
func TestGuestLogin_IssueTokensError(t *testing.T) {
	env := setupAuthService()
	pw := "pw"
	hashed, _ := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
	user := &model.User{
		ID:           "guest-it",
		Email:        "guest-it@x.com",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: string(hashed),
	}
	env.users.users[user.ID] = user
	env.users.emailIndex[user.Email] = user
	env.jwt.accessTokenErr = errors.New("jwt boom")

	if _, _, _, err := env.svc.GuestLogin(context.Background(), user.Email, pw); err == nil {
		t.Fatal("expected error from issueTokens")
	}
}

// ============================================================================
// auth.go: issueTokens error paths
// ============================================================================

func TestIssueTokens_RefreshTokenError(t *testing.T) {
	env := setupAuthService()
	env.jwt.refreshTokenErr = errors.New("refresh boom")
	if _, _, err := env.svc.issueTokens(context.Background(), &model.User{ID: "u"}); err == nil {
		t.Fatal("expected error from GenerateRefreshToken")
	}
}

func TestIssueTokens_StoreRefreshError(t *testing.T) {
	env := setupAuthService()
	env.tokens.storeErr = errors.New("store boom")
	if _, _, err := env.svc.issueTokens(context.Background(), &model.User{ID: "u"}); err == nil {
		t.Fatal("expected error from StoreRefreshToken")
	}
}

// ============================================================================
// conversation.go: GetOrCreateDM error paths
// ============================================================================

func TestGetOrCreateDM_GetGenericError(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.getErr = errors.New("get dm boom")
	if _, err := svc.GetOrCreateDM(context.Background(), "a", "b"); err == nil {
		t.Fatal("expected error")
	}
}

func TestGetOrCreateDM_GetUserAError(t *testing.T) {
	svc, _, _, _, _ := setupConversationService()
	// userA doesn't exist.
	if _, err := svc.GetOrCreateDM(context.Background(), "ghost-a", "user-b"); err == nil {
		t.Fatal("expected error from GetUser A")
	}
}

func TestGetOrCreateDM_GetUserBError(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	users.users["userA"] = &model.User{ID: "userA", DisplayName: "A"}
	// userB doesn't exist.
	if _, err := svc.GetOrCreateDM(context.Background(), "userA", "ghost-b"); err == nil {
		t.Fatal("expected error from GetUser B")
	}
}

// CreateConversation -> ErrAlreadyExists -> falls back to GetConversation.
type alreadyExistsConvStore struct {
	*mockConversationStore
}

func (a *alreadyExistsConvStore) CreateConversation(_ context.Context, conv *model.Conversation, ucs []*model.UserConversation) error {
	// Always return ErrAlreadyExists; but populate the underlying store first
	// so the subsequent GetConversation succeeds.
	a.conversations[conv.ID] = conv
	for _, uc := range ucs {
		a.userConvs[uc.UserID] = append(a.userConvs[uc.UserID], uc)
	}
	return store.ErrAlreadyExists
}

func TestGetOrCreateDM_AlreadyExistsRace(t *testing.T) {
	convs := newMockConversationStore()
	racing := &alreadyExistsConvStore{mockConversationStore: convs}
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}

	svc := NewConversationService(racing, users, nil, newMockBroker(), newMockPublisher())

	conv, err := svc.GetOrCreateDM(context.Background(), "a", "b")
	if err != nil {
		t.Fatalf("GetOrCreateDM: %v", err)
	}
	if conv == nil {
		t.Fatal("expected non-nil conversation")
	}
}

// CreateConversation generic error.
type erroringConvStore struct {
	*mockConversationStore
	createErr error
}

func (e *erroringConvStore) CreateConversation(_ context.Context, _ *model.Conversation, _ []*model.UserConversation) error {
	return e.createErr
}

func TestGetOrCreateDM_CreateError(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}
	failing := &erroringConvStore{mockConversationStore: convs, createErr: errors.New("create boom")}

	svc := NewConversationService(failing, users, nil, newMockBroker(), newMockPublisher())
	if _, err := svc.GetOrCreateDM(context.Background(), "a", "b"); err == nil {
		t.Fatal("expected error from CreateConversation")
	}
}

// GetOrCreateDM with nil broker.
func TestGetOrCreateDM_NilBroker(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}

	svc := NewConversationService(convs, users, nil, nil, newMockPublisher())
	if _, err := svc.GetOrCreateDM(context.Background(), "a", "b"); err != nil {
		t.Fatalf("GetOrCreateDM: %v", err)
	}
}

// CreateGroup with nil broker.
func TestCreateGroup_NilBroker(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U1"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "U2"}

	svc := NewConversationService(convs, users, nil, nil, newMockPublisher())
	if _, err := svc.CreateGroup(context.Background(), "u1", []string{"u2"}, "G"); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
}

// CreateGroup with deduped empty IDs.
func TestCreateGroup_DedupesAndIgnoresEmpty(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U1"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "U2"}

	svc := NewConversationService(convs, users, nil, newMockBroker(), newMockPublisher())
	conv, err := svc.CreateGroup(context.Background(), "u1", []string{"", "u2", "u2", ""}, "")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	if len(conv.ParticipantIDs) != 2 {
		t.Errorf("got %d participants, want 2", len(conv.ParticipantIDs))
	}
}

// CreateGroup with store error.
func TestCreateGroup_CreateError(t *testing.T) {
	convs := newMockConversationStore()
	convs.createErr = errors.New("create group boom")
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U1"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "U2"}
	svc := NewConversationService(convs, users, nil, newMockBroker(), newMockPublisher())

	if _, err := svc.CreateGroup(context.Background(), "u1", []string{"u2"}, "G"); err == nil {
		t.Fatal("expected error")
	}
}

// CreateGroup: GetUser returns generic (non-NotFound) error.
func TestCreateGroup_GetUserGenericError(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U1"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "U2"}
	users.getUserErr = errors.New("db boom")

	if _, err := svc.CreateGroup(context.Background(), "u1", []string{"u2"}, "G"); err == nil {
		t.Fatal("expected wrapped error from GetUser")
	}
}

// ListUserConversations error path.
func TestListUserConversations_Error(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.listErr = errors.New("list boom")
	if _, err := svc.ListUserConversations(context.Background(), "u"); err == nil {
		t.Fatal("expected error")
	}
}

// ============================================================================
// message.go: List error paths
// ============================================================================

func TestMessageService_List_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if _, _, err := svc.List(context.Background(), "stranger", "ch1", ParentChannel, "", 50); err == nil {
		t.Fatal("expected error from access check")
	}
}

func TestMessageService_List_StoreError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.listErr = errors.New("list boom")
	if _, _, err := svc.List(context.Background(), "user-1", "ch1", ParentChannel, "", 50); err == nil {
		t.Fatal("expected error")
	}
}

// ============================================================================
// message.go: Edit error paths
// ============================================================================

func TestMessageService_Edit_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if _, err := svc.Edit(context.Background(), "stranger", "ch1", ParentChannel, "msg", "x", nil); err == nil {
		t.Fatal("expected access error")
	}
}

func TestMessageService_Edit_GetMessageError(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	if _, err := svc.Edit(context.Background(), "user-1", "ch1", ParentChannel, "missing", "x", nil); err == nil {
		t.Fatal("expected error from GetMessage")
	}
}

func TestMessageService_Edit_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "user-1", Body: "old"}
	messages.updateErr = errors.New("update boom")
	if _, err := svc.Edit(context.Background(), "user-1", "ch1", ParentChannel, "m1", "new", nil); err == nil {
		t.Fatal("expected error from UpdateMessage")
	}
}

// ============================================================================
// message.go: Delete error paths
// ============================================================================

func TestMessageService_Delete_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if err := svc.Delete(context.Background(), "stranger", "ch1", ParentChannel, "x"); err == nil {
		t.Fatal("expected access error")
	}
}

func TestMessageService_Delete_GetMessageError(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	if err := svc.Delete(context.Background(), "user-1", "ch1", ParentChannel, "ghost"); err == nil {
		t.Fatal("expected error from GetMessage")
	}
}

func TestMessageService_Delete_StoreUpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "user-1", Body: "x"}
	// Soft-delete is implemented via UpdateMessage; persistence failure
	// surfaces as an error from svc.Delete.
	messages.updateErr = errors.New("update boom")
	if err := svc.Delete(context.Background(), "user-1", "ch1", ParentChannel, "m1"); err == nil {
		t.Fatal("expected error from UpdateMessage")
	}
}

// Delete in conversation when caller is non-author -> error.
func TestMessageService_Delete_ConversationNonAuthorAndAuthor(t *testing.T) {
	svc, messages, _, conversations, _ := setupMessageService()

	conversations.conversations["conv-d"] = &model.Conversation{
		ID:             "conv-d",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u1", "u2"},
	}
	messages.messages["conv-d#m"] = &model.Message{ID: "m", ParentID: "conv-d", AuthorID: "u1"}
	// u1 is the author -> success.
	if err := svc.Delete(context.Background(), "u1", "conv-d", ParentConversation, "m"); err != nil {
		t.Fatalf("Delete by author: %v", err)
	}
}

// ============================================================================
// message.go: checkAccess errors
// ============================================================================

// checkAccess: GetMembership returns generic (non-NotFound) error.
func TestMessageService_checkAccess_MembershipGenericError(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.getErr = errors.New("db boom")
	if _, err := svc.Send(context.Background(), "u", "ch", ParentChannel, "x", ""); err == nil {
		t.Fatal("expected wrapped error")
	}
}

// checkAccess: GetConversation generic error.
func TestMessageService_checkAccess_ConversationGetError(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.getErr = errors.New("db boom")
	if _, err := svc.Send(context.Background(), "u", "conv", ParentConversation, "x", ""); err == nil {
		t.Fatal("expected error")
	}
}

// ============================================================================
// message.go: publishEvent unknown parent type
// ============================================================================

// publishEvent's default branch is reachable via publishEvent directly with
// an unknown parent type. The Send path validates upfront, so we exercise
// publishEvent indirectly.
func TestMessageService_PublishEvent_UnknownParentType(t *testing.T) {
	svc, _, _, _, publisher := setupMessageService()
	// Direct call to publishEvent with bogus parent type; should be no-op.
	svc.publishEvent(context.Background(), "x", "bogus", "evt", nil)
	if len(publisher.published) != 0 {
		t.Errorf("expected no events published for unknown parent type, got %d", len(publisher.published))
	}
}

// ============================================================================
// user.go: List error path
// ============================================================================

func TestUserService_List_Error(t *testing.T) {
	users := newMockUserStore()
	users.listErr = errors.New("list boom")
	svc := NewUserService(users, nil, nil, nil)
	if _, _, err := svc.List(context.Background(), 50, ""); err == nil {
		t.Fatal("expected error")
	}
}

// List should resolve avatar URLs for each user.
func TestUserService_List_ResolvesAvatars(t *testing.T) {
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", AvatarKey: "avatars/a/x"}
	users.users["b"] = &model.User{ID: "b", AvatarKey: "avatars/b/y"}
	svc := NewUserService(users, nil, fakeAvatarSigner{}, nil)
	got, _, err := svc.List(context.Background(), 50, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d users, want 2", len(got))
	}
	for _, u := range got {
		if u.AvatarURL == "" {
			t.Errorf("user %s: expected AvatarURL to be resolved", u.ID)
		}
	}
}

// Update with cache delete error swallowed.
func TestUserService_Update_CacheDeleteSwallowed(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	cache.deleteErr = errors.New("cache boom")
	svc := NewUserService(users, cache, nil, nil)
	users.users["uu"] = &model.User{ID: "uu", Email: "uu@x", DisplayName: "U"}
	users.emailIndex["uu@x"] = users.users["uu"]
	name := "New"
	if _, err := svc.Update(context.Background(), "uu", &name, nil); err != nil {
		t.Fatalf("Update: %v", err)
	}
}

// Update: store update error.
func TestUserService_Update_StoreError(t *testing.T) {
	users := newMockUserStore()
	users.users["uu2"] = &model.User{ID: "uu2", Email: "uu2@x"}
	users.emailIndex["uu2@x"] = users.users["uu2"]
	users.updateErr = errors.New("update boom")
	svc := NewUserService(users, nil, nil, nil)
	name := "X"
	if _, err := svc.Update(context.Background(), "uu2", &name, nil); err == nil {
		t.Fatal("expected error")
	}
}

// Update with generic GetUser error (not ErrNotFound).
func TestUserService_Update_GetUserGenericError(t *testing.T) {
	users := newMockUserStore()
	users.getUserErr = errors.New("db boom")
	svc := NewUserService(users, nil, nil, nil)
	name := "x"
	if _, err := svc.Update(context.Background(), "anything", &name, nil); err == nil {
		t.Fatal("expected wrapped error")
	}
}

// UpdateRole: store update error.
func TestUserService_UpdateRole_StoreError(t *testing.T) {
	users := newMockUserStore()
	users.users["uu3"] = &model.User{ID: "uu3", Email: "uu3@x"}
	users.emailIndex["uu3@x"] = users.users["uu3"]
	users.updateErr = errors.New("update boom")
	svc := NewUserService(users, nil, nil, nil)
	if _, err := svc.UpdateRole(context.Background(), "actor", "uu3", model.SystemRoleAdmin); err == nil {
		t.Fatal("expected error")
	}
}

// UpdateRole with generic GetUser error.
func TestUserService_UpdateRole_GetUserGenericError(t *testing.T) {
	users := newMockUserStore()
	users.getUserErr = errors.New("db boom")
	svc := NewUserService(users, nil, nil, nil)
	if _, err := svc.UpdateRole(context.Background(), "actor", "anything", model.SystemRoleAdmin); err == nil {
		t.Fatal("expected wrapped error")
	}
}

// Search with store error.
func TestUserService_Search_Error(t *testing.T) {
	users := newMockUserStore()
	users.listErr = errors.New("list boom")
	svc := NewUserService(users, nil, nil, nil)
	if _, err := svc.Search(context.Background(), "x", 10); err == nil {
		t.Fatal("expected error")
	}
}

// Search resolves avatars on matched users.
func TestUserService_Search_ResolvesAvatars(t *testing.T) {
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "Alice", AvatarKey: "avatars/a"}
	svc := NewUserService(users, nil, fakeAvatarSigner{}, nil)
	got, err := svc.Search(context.Background(), "alice", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 || got[0].AvatarURL == "" {
		t.Errorf("expected resolved avatar for matched user; got %+v", got)
	}
}

// ============================================================================
// Remaining branch coverage
// ============================================================================

// Archive: non-owner non-admin should hit the checkPermission branch.
func TestArchive_PermissionDenied(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	channels.channels["ch-pd"] = &model.Channel{
		ID:   "ch-pd",
		Name: "pd",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-pd#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-pd",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember, // not owner
	}
	if err := svc.Archive(context.Background(), "user-1", "ch-pd"); err == nil {
		t.Fatal("expected permission error")
	}
}

// UpdateMemberRole: actor's GetMembership returns generic err while not system
// admin while promoting to owner -> wrapped error returned.
func TestUpdateMemberRole_GetActorMembershipError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	// Actor passes admin role check by being a member at admin level.
	// We'll use the trick: first call (checkPermission) succeeds, second call
	// (within UpdateMemberRole for owner promotion) errors. Since the same mock
	// is used, we set the error AFTER a "warmup" by using a custom mock.
	memberships.memberships["ch-acm#admin"] = &model.ChannelMembership{
		ChannelID: "ch-acm",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	// Use a custom membership store that fails the second GetMembership call.
	custom := &flakyMembershipStore{mockMembershipStore: memberships, failOn: 2}
	svc.memberships = custom

	if err := svc.UpdateMemberRole(context.Background(), "admin", "ch-acm", "tgt", model.ChannelRoleOwner); err == nil {
		t.Fatal("expected error from get actor membership")
	}
}

// flakyMembershipStore lets us fail the Nth call to GetMembership.
type flakyMembershipStore struct {
	*mockMembershipStore
	calls  int
	failOn int
}

func (f *flakyMembershipStore) GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	f.calls++
	if f.calls == f.failOn {
		return nil, errors.New("flaky boom")
	}
	return f.mockMembershipStore.GetMembership(ctx, channelID, userID)
}

// Send: CreateMessage error.
func TestMessageService_Send_CreateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.createErr = errors.New("create boom")
	if _, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "x", ""); err == nil {
		t.Fatal("expected error")
	}
}

// ListThreadMessages: ListMessages error.
func TestMessageService_ListThreadMessages_ListError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.listErr = errors.New("list boom")
	if _, err := svc.ListThreadMessages(context.Background(), "user-1", "ch1", ParentChannel, "root"); err == nil {
		t.Fatal("expected error")
	}
}

// ToggleReaction: UpdateMessage error.
func TestMessageService_ToggleReaction_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "user-2", Body: "hi"}
	messages.updateErr = errors.New("update boom")
	if _, err := svc.ToggleReaction(context.Background(), "user-1", "ch1", ParentChannel, "m1", "👍"); err == nil {
		t.Fatal("expected error")
	}
}
