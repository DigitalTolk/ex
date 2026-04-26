package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func setupChannelService() (*ChannelService, *mockChannelStore, *mockMembershipStore, *mockBroker, *mockPublisher) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	users.users["user-1"] = &model.User{ID: "user-1", DisplayName: "Test User"}
	messages := newMockMessageStore()
	cache := newMockCache()
	broker := newMockBroker()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, broker, publisher)
	return svc, channels, memberships, broker, publisher
}

// setupChannelServiceWithUsers is the same as setupChannelService but also
// surfaces the mock UserStore so guest-related tests can prepare the actor.
func setupChannelServiceWithUsers() (*ChannelService, *mockChannelStore, *mockMembershipStore, *mockUserStore, *mockBroker, *mockPublisher) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	cache := newMockCache()
	broker := newMockBroker()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, users, messages, cache, broker, publisher)
	return svc, channels, memberships, users, broker, publisher
}

func TestChannelService_Create_GuestRejected(t *testing.T) {
	svc, _, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["g-1"] = &model.User{ID: "g-1", SystemRole: model.SystemRoleGuest}
	if _, err := svc.Create(context.Background(), "g-1", "secret", model.ChannelTypePublic, ""); err == nil {
		t.Fatal("expected guest-create rejection")
	}
}

func TestChannelService_Create_MemberAllowed(t *testing.T) {
	svc, _, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["m-1"] = &model.User{ID: "m-1", SystemRole: model.SystemRoleMember}
	if _, err := svc.Create(context.Background(), "m-1", "team-room", model.ChannelTypePublic, ""); err != nil {
		t.Fatalf("member should be allowed to create a channel: %v", err)
	}
}

func TestChannelService_Join_GuestBlockedOnNonGeneral(t *testing.T) {
	svc, channels, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["g-1"] = &model.User{ID: "g-1", SystemRole: model.SystemRoleGuest}
	channels.channels["random"] = &model.Channel{
		ID: "random", Name: "random", Type: model.ChannelTypePublic,
	}
	if err := svc.Join(context.Background(), "g-1", "random"); err == nil {
		t.Fatal("expected guest to be blocked from joining a non-general channel")
	}
}

func TestChannelService_BrowsePublic_GuestFilteredToInvitedChannels(t *testing.T) {
	svc, channels, memberships, users, _, _ := setupChannelServiceWithUsers()
	users.users["g-1"] = &model.User{ID: "g-1", SystemRole: model.SystemRoleGuest}

	// Three public channels exist in the workspace.
	channels.channels["ch-general"] = &model.Channel{ID: "ch-general", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	channels.channels["ch-invited"] = &model.Channel{ID: "ch-invited", Name: "invited", Slug: "invited", Type: model.ChannelTypePublic}
	channels.channels["ch-private-to-me"] = &model.Channel{ID: "ch-private-to-me", Name: "secret", Slug: "secret", Type: model.ChannelTypePublic}

	// Guest is a member of two of them.
	memberships.userChannels = []*model.UserChannel{
		{UserID: "g-1", ChannelID: "ch-general", ChannelName: "general"},
		{UserID: "g-1", ChannelID: "ch-invited", ChannelName: "invited"},
	}

	got, _, err := svc.BrowsePublic(context.Background(), "g-1", 50, "")
	if err != nil {
		t.Fatalf("BrowsePublic: %v", err)
	}
	gotIDs := map[string]bool{}
	for _, c := range got {
		gotIDs[c.ID] = true
	}
	if !gotIDs["ch-general"] || !gotIDs["ch-invited"] {
		t.Errorf("guest should see invited channels: got %v", gotIDs)
	}
	if gotIDs["ch-private-to-me"] {
		t.Errorf("guest should NOT see channels they aren't a member of: got %v", gotIDs)
	}
}

func TestChannelService_BrowsePublic_MembersSeeAll(t *testing.T) {
	svc, channels, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["m-1"] = &model.User{ID: "m-1", SystemRole: model.SystemRoleMember}
	channels.channels["ch-a"] = &model.Channel{ID: "ch-a", Name: "a", Type: model.ChannelTypePublic}
	channels.channels["ch-b"] = &model.Channel{ID: "ch-b", Name: "b", Type: model.ChannelTypePublic}

	got, _, err := svc.BrowsePublic(context.Background(), "m-1", 50, "")
	if err != nil {
		t.Fatalf("BrowsePublic: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("members should see every public channel; got %d", len(got))
	}
}

func TestChannelService_Join_GuestAllowedOnGeneral(t *testing.T) {
	svc, channels, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["g-1"] = &model.User{ID: "g-1", SystemRole: model.SystemRoleGuest}
	channels.channels[generalChannelID] = &model.Channel{
		ID: generalChannelID, Name: "general", Type: model.ChannelTypePublic,
	}
	if err := svc.Join(context.Background(), "g-1", generalChannelID); err != nil {
		t.Fatalf("guest should be allowed to join #general: %v", err)
	}
}

func TestChannelService_Create(t *testing.T) {
	svc, channels, memberships, broker, _ := setupChannelService()
	ctx := context.Background()

	ch, err := svc.Create(ctx, "user-1", "test-channel", model.ChannelTypePublic, "A test channel")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if ch.Name != "test-channel" {
		t.Errorf("Name = %q, want %q", ch.Name, "test-channel")
	}
	if ch.Type != model.ChannelTypePublic {
		t.Errorf("Type = %q, want %q", ch.Type, model.ChannelTypePublic)
	}
	if ch.CreatedBy != "user-1" {
		t.Errorf("CreatedBy = %q, want %q", ch.CreatedBy, "user-1")
	}

	// Channel should be stored.
	if _, ok := channels.channels[ch.ID]; !ok {
		t.Error("channel not stored")
	}

	// Creator should be an owner.
	key := ch.ID + "#user-1"
	mem, ok := memberships.memberships[key]
	if !ok {
		t.Fatal("owner membership not created")
	}
	if mem.Role != model.ChannelRoleOwner {
		t.Errorf("role = %d, want %d (owner)", mem.Role, model.ChannelRoleOwner)
	}

	// Broker should have been called.
	if len(broker.subscriptions["user-1"]) == 0 {
		t.Error("expected broker subscription for creator")
	}
}

func TestChannelService_GetByID(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch1"] = &model.Channel{
		ID:   "ch1",
		Name: "general",
		Type: model.ChannelTypePublic,
	}

	ch, err := svc.GetByID(ctx, "ch1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if ch.Name != "general" {
		t.Errorf("Name = %q, want %q", ch.Name, "general")
	}
}

func TestChannelService_GetByID_NotFound(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()

	_, err := svc.GetByID(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for non-existent channel")
	}
}

func TestChannelService_Update(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch2"] = &model.Channel{
		ID:   "ch2",
		Name: "old-name",
		Type: model.ChannelTypePublic,
	}
	// Actor is an admin.
	memberships.memberships["ch2#user-1"] = &model.ChannelMembership{
		ChannelID: "ch2",
		UserID:    "user-1",
		Role:      model.ChannelRoleAdmin,
	}

	newName := "new-name"
	newDesc := "new description"
	ch, err := svc.Update(ctx, "user-1", "ch2", &newName, &newDesc)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if ch.Name != "new-name" {
		t.Errorf("Name = %q, want %q", ch.Name, "new-name")
	}
	if ch.Description != "new description" {
		t.Errorf("Description = %q, want %q", ch.Description, "new description")
	}
}

func TestChannelService_Update_Forbidden(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch4"] = &model.Channel{
		ID:   "ch4",
		Name: "locked",
		Type: model.ChannelTypePublic,
	}
	// Actor is only a member (not admin).
	memberships.memberships["ch4#user-1"] = &model.ChannelMembership{
		ChannelID: "ch4",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	newName := "try-rename"
	_, err := svc.Update(ctx, "user-1", "ch4", &newName, nil)
	if err == nil {
		t.Fatal("expected error for insufficient permissions")
	}
}

func TestChannelService_Archive(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch5"] = &model.Channel{
		ID:   "ch5",
		Name: "to-archive",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch5#user-1"] = &model.ChannelMembership{
		ChannelID: "ch5",
		UserID:    "user-1",
		Role:      model.ChannelRoleOwner,
	}

	err := svc.Archive(ctx, "user-1", "ch5")
	if err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if !channels.channels["ch5"].Archived {
		t.Error("expected channel to be archived")
	}
}

func TestChannelService_Join(t *testing.T) {
	svc, channels, memberships, broker, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch6"] = &model.Channel{
		ID:   "ch6",
		Name: "public-chan",
		Type: model.ChannelTypePublic,
	}

	err := svc.Join(ctx, "user-2", "ch6")
	if err != nil {
		t.Fatalf("Join: %v", err)
	}

	key := "ch6#user-2"
	if _, ok := memberships.memberships[key]; !ok {
		t.Error("membership not created after join")
	}
	if len(broker.subscriptions["user-2"]) == 0 {
		t.Error("expected broker subscription after join")
	}
}

func TestChannelService_Join_PrivateChannel(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch7"] = &model.Channel{
		ID:   "ch7",
		Name: "private-chan",
		Type: model.ChannelTypePrivate,
	}

	err := svc.Join(ctx, "user-2", "ch7")
	if err == nil {
		t.Fatal("expected error when joining private channel")
	}
}

func TestChannelService_Join_ArchivedChannel(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch8"] = &model.Channel{
		ID:       "ch8",
		Name:     "archived-chan",
		Type:     model.ChannelTypePublic,
		Archived: true,
	}

	err := svc.Join(ctx, "user-2", "ch8")
	if err == nil {
		t.Fatal("expected error when joining archived channel")
	}
}

func TestChannelService_Leave(t *testing.T) {
	svc, _, memberships, broker, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch9#user-1"] = &model.ChannelMembership{
		ChannelID: "ch9",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	err := svc.Leave(ctx, "user-1", "ch9")
	if err != nil {
		t.Fatalf("Leave: %v", err)
	}

	if _, ok := memberships.memberships["ch9#user-1"]; ok {
		t.Error("membership should be removed after leave")
	}
	if len(broker.unsubscriptions["user-1"]) == 0 {
		t.Error("expected broker unsubscription after leave")
	}
}

func TestChannelService_Leave_GeneralBlocked(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships[generalChannelID+"#user-1"] = &model.ChannelMembership{
		ChannelID: generalChannelID,
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	if err := svc.Leave(ctx, "user-1", generalChannelID); err == nil {
		t.Fatal("expected error when leaving the general channel")
	}
	if _, ok := memberships.memberships[generalChannelID+"#user-1"]; !ok {
		t.Error("membership must remain after blocked leave")
	}
}

func TestChannelService_RemoveMember_GeneralBlocked(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships[generalChannelID+"#admin-1"] = &model.ChannelMembership{
		ChannelID: generalChannelID,
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships[generalChannelID+"#target"] = &model.ChannelMembership{
		ChannelID: generalChannelID,
		UserID:    "target",
		Role:      model.ChannelRoleMember,
	}

	if err := svc.RemoveMember(ctx, "admin-1", generalChannelID, "target"); err == nil {
		t.Fatal("expected error when removing a member from #general")
	}
	if _, ok := memberships.memberships[generalChannelID+"#target"]; !ok {
		t.Error("target membership must remain after blocked removal")
	}
}

func TestChannelService_Leave_OwnerBlocked(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch10#user-1"] = &model.ChannelMembership{
		ChannelID: "ch10",
		UserID:    "user-1",
		Role:      model.ChannelRoleOwner,
	}

	err := svc.Leave(ctx, "user-1", "ch10")
	if err == nil {
		t.Fatal("expected error when owner tries to leave")
	}
}

func TestChannelService_AddMember(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch11"] = &model.Channel{
		ID:   "ch11",
		Name: "add-member-chan",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch11#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch11",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}

	err := svc.AddMember(ctx, "admin-1", "ch11", "user-new", model.ChannelRoleMember)
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if _, ok := memberships.memberships["ch11#user-new"]; !ok {
		t.Error("membership should be created for new user")
	}
}

func TestChannelService_RemoveMember(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch12#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch12",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch12#target"] = &model.ChannelMembership{
		ChannelID: "ch12",
		UserID:    "target",
		Role:      model.ChannelRoleMember,
	}

	err := svc.RemoveMember(ctx, "admin-1", "ch12", "target")
	if err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}

	if _, ok := memberships.memberships["ch12#target"]; ok {
		t.Error("target membership should be removed")
	}
}

func TestChannelService_RemoveMember_OwnerProtected(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch13#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch13",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch13#owner"] = &model.ChannelMembership{
		ChannelID: "ch13",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}

	// Non-system-admin cannot remove an owner.
	err := svc.RemoveMember(ctx, "admin-1", "ch13", "owner")
	if err == nil {
		t.Fatal("expected error removing channel owner without system admin")
	}
}

func TestChannelService_UpdateMemberRole(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch14#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch14",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch14#target"] = &model.ChannelMembership{
		ChannelID: "ch14",
		UserID:    "target",
		Role:      model.ChannelRoleMember,
	}

	err := svc.UpdateMemberRole(ctx, "admin-1", "ch14", "target", model.ChannelRoleAdmin)
	if err != nil {
		t.Fatalf("UpdateMemberRole: %v", err)
	}
}

func TestChannelService_UpdateMemberRole_PromoteToOwner_Requires_Owner(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch15#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch15",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin, // not owner
	}

	err := svc.UpdateMemberRole(ctx, "admin-1", "ch15", "target", model.ChannelRoleOwner)
	if err == nil {
		t.Fatal("expected error: only owners can promote to owner")
	}
}

func TestChannelService_ListMembers(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch16#u1"] = &model.ChannelMembership{
		ChannelID: "ch16",
		UserID:    "u1",
		Role:      model.ChannelRoleMember,
	}
	memberships.memberships["ch16#u2"] = &model.ChannelMembership{
		ChannelID: "ch16",
		UserID:    "u2",
		Role:      model.ChannelRoleAdmin,
	}

	members, err := svc.ListMembers(ctx, "ch16")
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 2 {
		t.Errorf("len(members) = %d, want 2", len(members))
	}
}

func TestChannelService_ListUserChannels(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	ctx := context.Background()

	_, err := svc.ListUserChannels(ctx, "user-1")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
}

func TestChannelService_BrowsePublic(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	ctx := context.Background()

	_, _, err := svc.BrowsePublic(ctx, "", 50, "")
	if err != nil {
		t.Fatalf("BrowsePublic: %v", err)
	}
}

func TestChannelService_CheckPermission_NotMember(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-perm"] = &model.Channel{
		ID:   "ch-perm",
		Name: "perm-test",
		Type: model.ChannelTypePublic,
	}

	// User is not a member.
	_, err := svc.Update(ctx, "stranger", "ch-perm", nil, nil)
	if err == nil {
		t.Fatal("expected error for non-member")
	}
}

func TestChannelService_Create_SetsDisplayName(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	ch, err := svc.Create(ctx, "user-1", "test", model.ChannelTypePublic, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	key := ch.ID + "#user-1"
	mem, ok := memberships.memberships[key]
	if !ok {
		t.Fatal("membership not found")
	}
	if mem.DisplayName == "" {
		t.Error("expected DisplayName to be set on channel creator membership")
	}
}

func TestChannelService_Join_SetsDisplayName(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-join"] = &model.Channel{
		ID:   "ch-join",
		Name: "joinable",
		Type: model.ChannelTypePublic,
	}

	err := svc.Join(ctx, "user-1", "ch-join")
	if err != nil {
		t.Fatalf("Join: %v", err)
	}

	key := "ch-join#user-1"
	mem, ok := memberships.memberships[key]
	if !ok {
		t.Fatal("membership not found")
	}
	if mem.DisplayName == "" {
		t.Error("expected DisplayName to be set on joined membership")
	}
}

func TestChannelService_AddMember_SetsDisplayName(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-add"] = &model.Channel{
		ID:   "ch-add",
		Name: "add-member-display",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-add#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch-add",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}

	// user-1 exists in the mock user store with DisplayName "Test User"
	err := svc.AddMember(ctx, "admin-1", "ch-add", "user-1", model.ChannelRoleMember)
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	key := "ch-add#user-1"
	mem, ok := memberships.memberships[key]
	if !ok {
		t.Fatal("membership not found")
	}
	if mem.DisplayName == "" {
		t.Error("expected DisplayName to be set on added membership")
	}
	if mem.DisplayName != "Test User" {
		t.Errorf("DisplayName = %q, want %q", mem.DisplayName, "Test User")
	}
}

func TestChannelService_Update_EmitsChannelUpdatedEvent(t *testing.T) {
	svc, channels, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-evt"] = &model.Channel{
		ID:          "ch-evt",
		Name:        "event-channel",
		Description: "old desc",
		Type:        model.ChannelTypePublic,
	}
	memberships.memberships["ch-evt#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-evt",
		UserID:    "user-1",
		Role:      model.ChannelRoleAdmin,
	}

	newDesc := "new description"
	_, err := svc.Update(ctx, "user-1", "ch-evt", nil, &newDesc)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}

	// Check that a channel.updated event was published.
	found := false
	for _, e := range publisher.published {
		if e.event.Type == "channel.updated" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected channel.updated event to be published")
	}
}

func TestChannelService_Create_EmitsChannelNewEvent(t *testing.T) {
	svc, _, _, _, publisher := setupChannelService()
	ctx := context.Background()

	_, err := svc.Create(ctx, "user-1", "new-channel", model.ChannelTypePublic, "desc")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Check that a channel.new event was published.
	found := false
	for _, e := range publisher.published {
		if e.event.Type == "channel.new" {
			found = true
			if e.channel != "global:channels" {
				t.Errorf("expected event on 'global:channels', got %q", e.channel)
			}
			break
		}
	}
	if !found {
		t.Error("expected channel.new event to be published")
	}
}

func TestChannelService_GetBySlug(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-slug"] = &model.Channel{
		ID:   "ch-slug",
		Name: "slug-test",
		Slug: "slug-test",
		Type: model.ChannelTypePublic,
	}

	ch, err := svc.GetBySlug(ctx, "slug-test")
	if err != nil {
		t.Fatalf("GetBySlug: %v", err)
	}
	if ch.ID != "ch-slug" {
		t.Errorf("ID = %q, want %q", ch.ID, "ch-slug")
	}
}

func TestChannelService_GetBySlug_NotFound(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	ctx := context.Background()

	_, err := svc.GetBySlug(ctx, "nonexistent-slug")
	if err == nil {
		t.Fatal("expected error for non-existent slug")
	}
}

func TestChannelService_Join_EmitsMembersChangedEvent(t *testing.T) {
	svc, channels, _, _, publisher := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-join-evt"] = &model.Channel{
		ID:   "ch-join-evt",
		Name: "join-event-chan",
		Type: model.ChannelTypePublic,
	}

	err := svc.Join(ctx, "user-1", "ch-join-evt")
	if err != nil {
		t.Fatalf("Join: %v", err)
	}

	found := false
	for _, e := range publisher.published {
		if e.event.Type == "members.changed" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected members.changed event to be published after Join")
	}
}

func TestChannelService_Leave_EmitsMembersChangedEvent(t *testing.T) {
	svc, _, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-leave-evt#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-leave-evt",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	err := svc.Leave(ctx, "user-1", "ch-leave-evt")
	if err != nil {
		t.Fatalf("Leave: %v", err)
	}

	found := false
	for _, e := range publisher.published {
		if e.event.Type == "members.changed" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected members.changed event to be published after Leave")
	}
}

func TestChannelService_CheckPermission_NonMember_Update(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-perm2"] = &model.Channel{
		ID:   "ch-perm2",
		Name: "perm-test-2",
		Type: model.ChannelTypePublic,
	}

	newName := "after"
	_, err := svc.Update(ctx, "non-member", "ch-perm2", &newName, nil)
	if err == nil {
		t.Fatal("expected error for non-member without admin claims")
	}
}

// Bug #7: archiving the well-known #general channel must be rejected even if
// the actor has owner-level permissions.
func TestArchive_RejectsGeneralChannel(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	// Set up #general with user-1 as owner.
	channels.channels[generalChannelID] = &model.Channel{
		ID:   generalChannelID,
		Name: "general",
		Slug: "general",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships[generalChannelID+"#user-1"] = &model.ChannelMembership{
		ChannelID: generalChannelID,
		UserID:    "user-1",
		Role:      model.ChannelRoleOwner,
	}

	err := svc.Archive(ctx, "user-1", generalChannelID)
	if err == nil {
		t.Fatal("expected error archiving #general")
	}
	if channels.channels[generalChannelID].Archived {
		t.Error("#general should not be archived")
	}
}

// Bug #10: ListUserChannels must filter out channels that have been archived,
// since the per-user UserChannel records don't carry the archive flag.
func TestListUserChannels_FiltersArchived(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["active-ch"] = &model.Channel{
		ID:       "active-ch",
		Name:     "active",
		Type:     model.ChannelTypePublic,
		Archived: false,
	}
	channels.channels["archived-ch"] = &model.Channel{
		ID:       "archived-ch",
		Name:     "archived",
		Type:     model.ChannelTypePublic,
		Archived: true,
	}

	// Override mock to return both UserChannel records.
	memberships.userChannels = []*model.UserChannel{
		{UserID: "user-1", ChannelID: "active-ch", ChannelName: "active"},
		{UserID: "user-1", ChannelID: "archived-ch", ChannelName: "archived"},
	}

	result, err := svc.ListUserChannels(ctx, "user-1")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("len(result) = %d, want 1 (archived filtered)", len(result))
	}
	if result[0].ChannelID != "active-ch" {
		t.Errorf("got channel %q, want %q", result[0].ChannelID, "active-ch")
	}
}

// Bug #6: joining a channel must post a system message announcing the join,
// so the chat shows "Alice joined the channel" inline.
func TestJoin_PostsSystemMessage(t *testing.T) {
	svc, channels, _, _, publisher := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-join-sys"] = &model.Channel{
		ID:   "ch-join-sys",
		Name: "joinable",
		Type: model.ChannelTypePublic,
	}

	if err := svc.Join(ctx, "user-1", "ch-join-sys"); err != nil {
		t.Fatalf("Join: %v", err)
	}

	// Find a message.new event that contains a System message.
	found := false
	for _, e := range publisher.published {
		if e.event.Type == "message.new" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected message.new event for system join message")
	}
}

// RemoveMember publishes a channel.removed event to the removed user's
// personal channel so their sidebar drops the channel immediately.
func TestRemoveMember_PublishesUserEvent(t *testing.T) {
	svc, _, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-rm#admin"] = &model.ChannelMembership{
		ChannelID: "ch-rm",
		UserID:    "admin",
		Role:      model.ChannelRoleAdmin,
	}
	memberships.memberships["ch-rm#target"] = &model.ChannelMembership{
		ChannelID:   "ch-rm",
		UserID:      "target",
		Role:        model.ChannelRoleMember,
		DisplayName: "Target",
	}

	if err := svc.RemoveMember(ctx, "admin", "ch-rm", "target"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}

	var personal *publishedEvent
	for i, e := range publisher.published {
		if e.event.Type == "channel.removed" && e.channel == "user:target" {
			personal = &publisher.published[i]
			break
		}
	}
	if personal == nil {
		t.Fatal("expected channel.removed event on user:target")
	}
}

// Archive must remove every membership for the channel — both the channel-
// side row (so the member list of the archived channel comes back empty)
// and the user-side row (so it disappears from owner and member sidebars
// alike). Regression: archive previously only flipped the Archived flag,
// leaving stale memberships behind.
func TestArchive_RemovesAllMemberships(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-arx"] = &model.Channel{
		ID:   "ch-arx",
		Name: "to-archive",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-arx#owner"] = &model.ChannelMembership{
		ChannelID: "ch-arx", UserID: "owner", Role: model.ChannelRoleOwner,
	}
	memberships.memberships["ch-arx#m1"] = &model.ChannelMembership{
		ChannelID: "ch-arx", UserID: "m1", Role: model.ChannelRoleMember,
	}
	memberships.memberships["ch-arx#m2"] = &model.ChannelMembership{
		ChannelID: "ch-arx", UserID: "m2", Role: model.ChannelRoleMember,
	}

	if err := svc.Archive(ctx, "owner", "ch-arx"); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	// Channel is marked archived.
	if !channels.channels["ch-arx"].Archived {
		t.Error("expected channel to be archived")
	}
	// Member-side rows are gone — listing returns nothing.
	if got, _ := memberships.ListMembers(ctx, "ch-arx"); len(got) != 0 {
		t.Errorf("expected zero members after archive; got %d", len(got))
	}
	// And the per-user keys are wiped — none of the three users still has
	// the membership row.
	for _, key := range []string{"ch-arx#owner", "ch-arx#m1", "ch-arx#m2"} {
		if _, ok := memberships.memberships[key]; ok {
			t.Errorf("membership %s persisted after archive", key)
		}
	}
}

// After archive, no user — including the owner — should see the channel
// returned from ListUserChannels. Owner-side persistence was a leftover
// from when archive was reversible; the new behaviour is destructive.
func TestArchive_HidesChannelFromOwnerSidebar(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-arx-2"] = &model.Channel{
		ID:   "ch-arx-2",
		Name: "to-arch-2",
		Type: model.ChannelTypePublic,
	}
	memberships.userChannels = []*model.UserChannel{
		{UserID: "owner-2", ChannelID: "ch-arx-2", ChannelName: "to-arch-2", Role: model.ChannelRoleOwner},
	}
	memberships.memberships["ch-arx-2#owner-2"] = &model.ChannelMembership{
		ChannelID: "ch-arx-2", UserID: "owner-2", Role: model.ChannelRoleOwner,
	}

	if err := svc.Archive(ctx, "owner-2", "ch-arx-2"); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	// Sidebar query must not include the archived channel for the owner.
	out, err := svc.ListUserChannels(ctx, "owner-2")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	for _, uc := range out {
		if uc.ChannelID == "ch-arx-2" {
			t.Error("owner still sees archived channel in sidebar")
		}
	}
}

// Archive publishes channel.archived to the channel topic AND to every
// member's personal channel so all sidebars update.
func TestArchive_PublishesToAllMembers(t *testing.T) {
	svc, channels, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	channels.channels["ch-arch"] = &model.Channel{
		ID:   "ch-arch",
		Name: "to-arch",
		Type: model.ChannelTypePublic,
	}
	memberships.memberships["ch-arch#owner"] = &model.ChannelMembership{
		ChannelID: "ch-arch",
		UserID:    "owner",
		Role:      model.ChannelRoleOwner,
	}
	memberships.memberships["ch-arch#member1"] = &model.ChannelMembership{
		ChannelID: "ch-arch",
		UserID:    "member1",
		Role:      model.ChannelRoleMember,
	}
	memberships.memberships["ch-arch#member2"] = &model.ChannelMembership{
		ChannelID: "ch-arch",
		UserID:    "member2",
		Role:      model.ChannelRoleMember,
	}

	if err := svc.Archive(ctx, "owner", "ch-arch"); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	gotChans := map[string]bool{}
	for _, e := range publisher.published {
		if e.event.Type == "channel.archived" {
			gotChans[e.channel] = true
		}
	}
	for _, want := range []string{"chan:ch-arch", "user:owner", "user:member1", "user:member2"} {
		if !gotChans[want] {
			t.Errorf("expected channel.archived event on %q", want)
		}
	}
}

// Leave publishes channel.removed to the leaving user's personal channel.
func TestLeave_PublishesUserEvent(t *testing.T) {
	svc, _, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-lv#user-1"] = &model.ChannelMembership{
		ChannelID:   "ch-lv",
		UserID:      "user-1",
		Role:        model.ChannelRoleMember,
		DisplayName: "Test User",
	}

	if err := svc.Leave(ctx, "user-1", "ch-lv"); err != nil {
		t.Fatalf("Leave: %v", err)
	}

	found := false
	for _, e := range publisher.published {
		if e.event.Type == "channel.removed" && e.channel == "user:user-1" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected channel.removed event on user:user-1 after leave")
	}
}

// Owner of an archived channel must still see the channel in their list,
// while non-owners do not.
func TestListUserChannels_OwnerSeesArchived(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	ctx := context.Background()

	channels.channels["arch-1"] = &model.Channel{
		ID:       "arch-1",
		Name:     "archived-by-owner",
		Type:     model.ChannelTypePublic,
		Archived: true,
	}
	memberships.userChannels = []*model.UserChannel{
		{UserID: "owner-u", ChannelID: "arch-1", ChannelName: "archived-by-owner", Role: model.ChannelRoleOwner},
		{UserID: "member-u", ChannelID: "arch-1", ChannelName: "archived-by-owner", Role: model.ChannelRoleMember},
	}

	ownerList, err := svc.ListUserChannels(ctx, "owner-u")
	if err != nil {
		t.Fatalf("ListUserChannels owner: %v", err)
	}
	if len(ownerList) != 1 {
		t.Fatalf("owner list len = %d, want 1 (owner sees archived)", len(ownerList))
	}

	memberList, err := svc.ListUserChannels(ctx, "member-u")
	if err != nil {
		t.Fatalf("ListUserChannels member: %v", err)
	}
	if len(memberList) != 0 {
		t.Errorf("member list len = %d, want 0 (member shouldn't see archived)", len(memberList))
	}
}

// Bug #6: leaving a channel must post a system message announcing the leave.
func TestLeave_PostsSystemMessage(t *testing.T) {
	svc, _, memberships, _, publisher := setupChannelService()
	ctx := context.Background()

	memberships.memberships["ch-leave-sys#user-1"] = &model.ChannelMembership{
		ChannelID:   "ch-leave-sys",
		UserID:      "user-1",
		Role:        model.ChannelRoleMember,
		DisplayName: "Test User",
	}

	if err := svc.Leave(ctx, "user-1", "ch-leave-sys"); err != nil {
		t.Fatalf("Leave: %v", err)
	}

	found := false
	for _, e := range publisher.published {
		if e.event.Type == "message.new" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected message.new event for system leave message")
	}
}
