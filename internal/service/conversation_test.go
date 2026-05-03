package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func setupConversationService() (*ConversationService, *mockConversationStore, *mockUserStore, *mockBroker, *mockPublisher) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	cache := newMockCache()
	broker := newMockBroker()
	publisher := newMockPublisher()
	svc := NewConversationService(convs, users, cache, broker, publisher)
	return svc, convs, users, broker, publisher
}

func TestConversationService_SetFavorite(t *testing.T) {
	svc, conversations, _, _, publisher := setupConversationService()
	ctx := context.Background()

	conversations.conversations["c-fav"] = &model.Conversation{
		ID:             "c-fav",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-1", "u-2"},
	}
	conversations.userConvs["u-1"] = []*model.UserConversation{
		{UserID: "u-1", ConversationID: "c-fav"},
	}

	if err := svc.SetFavorite(ctx, "u-1", "c-fav", true); err != nil {
		t.Fatalf("SetFavorite: %v", err)
	}
	if !conversations.userConvs["u-1"][0].Favorite {
		t.Error("expected user-side favorite=true")
	}
	if len(publisher.published) != 1 || publisher.published[0].event.Type != "userchannel.updated" {
		t.Errorf("expected userchannel.updated; got %+v", publisher.published)
	}
}

func TestConversationService_SetFavorite_RejectsNonParticipant(t *testing.T) {
	svc, conversations, _, _, _ := setupConversationService()
	ctx := context.Background()
	conversations.conversations["c-fav"] = &model.Conversation{
		ID:             "c-fav",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-1"},
	}
	if err := svc.SetFavorite(ctx, "u-stranger", "c-fav", true); err == nil {
		t.Fatal("expected non-participant rejection")
	}
}

func TestConversationService_SetCategory(t *testing.T) {
	svc, conversations, _, _, _ := setupConversationService()
	ctx := context.Background()
	conversations.conversations["c-cat"] = &model.Conversation{
		ID:             "c-cat",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-1", "u-2"},
	}
	conversations.userConvs["u-1"] = []*model.UserConversation{
		{UserID: "u-1", ConversationID: "c-cat"},
	}
	if err := svc.SetCategory(ctx, "u-1", "c-cat", "cat-eng", nil); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}
	if conversations.userConvs["u-1"][0].CategoryID != "cat-eng" {
		t.Errorf("CategoryID = %q, want cat-eng", conversations.userConvs["u-1"][0].CategoryID)
	}
}

func TestConversationService_SetCategory_RejectsNonParticipant(t *testing.T) {
	svc, conversations, _, _, _ := setupConversationService()
	ctx := context.Background()
	conversations.conversations["c-cat"] = &model.Conversation{
		ID:             "c-cat",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-1"},
	}
	if err := svc.SetCategory(ctx, "u-stranger", "c-cat", "cat", nil); err == nil {
		t.Fatal("expected non-participant rejection")
	}
}

func TestConversationService_IsParticipant(t *testing.T) {
	svc, conversations, _, _, _ := setupConversationService()
	ctx := context.Background()

	conversations.conversations["c-ip"] = &model.Conversation{
		ID:             "c-ip",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-a", "u-b"},
	}

	if !svc.IsParticipant(ctx, "u-a", "c-ip") {
		t.Error("expected participant to be reported")
	}
	if svc.IsParticipant(ctx, "u-c", "c-ip") {
		t.Error("non-participant must not be reported")
	}
	if svc.IsParticipant(ctx, "u-a", "missing") {
		t.Error("missing conversation must report false")
	}
	if svc.IsParticipant(ctx, "", "c-ip") || svc.IsParticipant(ctx, "u-a", "") {
		t.Error("blank inputs must short-circuit to false")
	}
}

func TestConversationService_GetOrCreateDM(t *testing.T) {
	svc, _, users, broker, _ := setupConversationService()
	ctx := context.Background()

	users.users["userA"] = &model.User{ID: "userA", Email: "a@test.com", DisplayName: "User A"}
	users.users["userB"] = &model.User{ID: "userB", Email: "b@test.com", DisplayName: "User B"}

	conv, err := svc.GetOrCreateDM(ctx, "userA", "userB")
	if err != nil {
		t.Fatalf("GetOrCreateDM: %v", err)
	}

	if conv.Type != model.ConversationTypeDM {
		t.Errorf("Type = %q, want %q", conv.Type, model.ConversationTypeDM)
	}
	if len(conv.ParticipantIDs) != 2 {
		t.Errorf("ParticipantIDs len = %d, want 2", len(conv.ParticipantIDs))
	}

	// Broker should have subscriptions for both users.
	if len(broker.subscriptions["userA"]) == 0 {
		t.Error("expected broker subscription for userA")
	}
	if len(broker.subscriptions["userB"]) == 0 {
		t.Error("expected broker subscription for userB")
	}
}

func TestConversationService_GetOrCreateDM_Existing(t *testing.T) {
	svc, convs, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["userA"] = &model.User{ID: "userA", Email: "a@test.com", DisplayName: "User A"}
	users.users["userB"] = &model.User{ID: "userB", Email: "b@test.com", DisplayName: "User B"}

	// Create a DM first.
	conv1, _ := svc.GetOrCreateDM(ctx, "userA", "userB")

	// Second call should return the same conversation.
	conv2, err := svc.GetOrCreateDM(ctx, "userA", "userB")
	if err != nil {
		t.Fatalf("GetOrCreateDM (existing): %v", err)
	}
	if conv2.ID != conv1.ID {
		t.Errorf("ID = %q, want %q (same DM)", conv2.ID, conv1.ID)
	}

	// Order shouldn't matter.
	conv3, err := svc.GetOrCreateDM(ctx, "userB", "userA")
	if err != nil {
		t.Fatalf("GetOrCreateDM (reversed): %v", err)
	}
	if conv3.ID != conv1.ID {
		t.Errorf("ID = %q, want %q (reversed order should get same DM)", conv3.ID, conv1.ID)
	}

	// Only one conversation should exist.
	if len(convs.conversations) != 1 {
		t.Errorf("expected 1 conversation, got %d", len(convs.conversations))
	}
}

func TestConversationService_GetOrCreateDM_SelfDM(t *testing.T) {
	svc, convs, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["userA"] = &model.User{ID: "userA", Email: "a@test.com", DisplayName: "User A"}

	conv, err := svc.GetOrCreateDM(ctx, "userA", "userA")
	if err != nil {
		t.Fatalf("self-DM should be allowed (notepad use case): %v", err)
	}
	if conv == nil {
		t.Fatal("expected non-nil conversation for self-DM")
	}
	if len(conv.ParticipantIDs) != 1 || conv.ParticipantIDs[0] != "userA" {
		t.Errorf("expected single participant userA, got %v", conv.ParticipantIDs)
	}
	// Only one userConv should be created.
	if got := len(convs.userConvs["userA"]); got != 1 {
		t.Errorf("expected 1 userConv entry for self-DM, got %d", got)
	}
}

func TestConversationService_CreateGroup(t *testing.T) {
	svc, _, users, broker, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "User 1"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "User 2"}
	users.users["u3"] = &model.User{ID: "u3", DisplayName: "User 3"}

	conv, err := svc.CreateGroup(ctx, "u1", []string{"u2", "u3"}, "Test Group")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	if conv.Type != model.ConversationTypeGroup {
		t.Errorf("Type = %q, want %q", conv.Type, model.ConversationTypeGroup)
	}
	if conv.Name != "Test Group" {
		t.Errorf("Name = %q, want %q", conv.Name, "Test Group")
	}
	// Creator should be added to participants.
	if len(conv.ParticipantIDs) != 3 {
		t.Errorf("ParticipantIDs len = %d, want 3", len(conv.ParticipantIDs))
	}

	// All participants should be subscribed.
	for _, uid := range []string{"u1", "u2", "u3"} {
		if len(broker.subscriptions[uid]) == 0 {
			t.Errorf("expected broker subscription for %s", uid)
		}
	}
}

// Bug #3: when no group name is provided, each participant's UserConversation
// must derive a sensible DisplayName from the *other* participants so the
// sidebar doesn't show an empty title.
func TestCreateGroup_DerivesNameFromParticipants(t *testing.T) {
	svc, convStore, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob"}
	users.users["u3"] = &model.User{ID: "u3", DisplayName: "Carol"}

	if _, err := svc.CreateGroup(ctx, "u1", []string{"u2", "u3"}, ""); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Each user should see the other two participants' names.
	for _, uid := range []string{"u1", "u2", "u3"} {
		ucs := convStore.userConvs[uid]
		if len(ucs) != 1 {
			t.Fatalf("user %s: expected 1 user-conv, got %d", uid, len(ucs))
		}
		if ucs[0].DisplayName == "" {
			t.Errorf("user %s: expected derived DisplayName, got empty string", uid)
		}
		// Should not include the user's own name in their own display.
		// Iteration order matches participantIDs (u1 is appended last
		// because it's the creator), so each list reflects that order.
		switch uid {
		case "u1":
			if ucs[0].DisplayName != "Bob, Carol" {
				t.Errorf("u1 DisplayName = %q, want %q", ucs[0].DisplayName, "Bob, Carol")
			}
		case "u2":
			if ucs[0].DisplayName != "Carol, Alice" {
				t.Errorf("u2 DisplayName = %q, want %q", ucs[0].DisplayName, "Carol, Alice")
			}
		case "u3":
			if ucs[0].DisplayName != "Bob, Alice" {
				t.Errorf("u3 DisplayName = %q, want %q", ucs[0].DisplayName, "Bob, Alice")
			}
		}
	}
}

// CreateGroup must derive its ID deterministically from the participant
// set so concurrent calls collide rather than spawning duplicates. The
// ID is order-independent — Alice→Bob→Carol must hash the same as
// Carol→Alice→Bob.
func TestConversationService_CreateGroup_DeterministicID(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob"}
	users.users["u3"] = &model.User{ID: "u3", DisplayName: "Carol"}

	first, err := svc.CreateGroup(ctx, "u1", []string{"u2", "u3"}, "")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Same constellation submitted in a different order — deterministic
	// ID matches, store rejects with ErrAlreadyExists, and CreateGroup
	// resolves to the existing row.
	second, err := svc.CreateGroup(ctx, "u3", []string{"u1", "u2"}, "")
	if err != nil {
		t.Fatalf("CreateGroup (reordered): %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("reordered CreateGroup got %q, want %q", second.ID, first.ID)
	}
}

// GetOrCreateGroup must forward into an existing group whose participant
// constellation matches, ignoring the supplied group name. This is what
// keeps the "New conversation" flow from spawning a duplicate group when
// the user re-messages the same set of people.
func TestConversationService_GetOrCreateGroup_ReusesExistingConstellation(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob"}
	users.users["u3"] = &model.User{ID: "u3", DisplayName: "Carol"}

	first, err := svc.CreateGroup(ctx, "u1", []string{"u2", "u3"}, "First")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Same constellation, different (or no) name: must return the same
	// conversation, not create a new one.
	second, err := svc.GetOrCreateGroup(ctx, "u1", []string{"u2", "u3"}, "Different name")
	if err != nil {
		t.Fatalf("GetOrCreateGroup: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("GetOrCreateGroup returned a new group %q, want existing %q", second.ID, first.ID)
	}

	// Order independence: caller-supplied participant order shouldn't
	// matter — sets are equality.
	third, err := svc.GetOrCreateGroup(ctx, "u1", []string{"u3", "u2"}, "")
	if err != nil {
		t.Fatalf("GetOrCreateGroup (reordered): %v", err)
	}
	if third.ID != first.ID {
		t.Errorf("reordered GetOrCreateGroup returned %q, want existing %q", third.ID, first.ID)
	}
}

func TestConversationService_GetOrCreateGroup_CreatesNewWhenNoMatch(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob"}
	users.users["u3"] = &model.User{ID: "u3", DisplayName: "Carol"}
	users.users["u4"] = &model.User{ID: "u4", DisplayName: "Dan"}

	first, err := svc.CreateGroup(ctx, "u1", []string{"u2", "u3"}, "")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// A different constellation (extra participant) must spawn a fresh
	// group rather than reusing the smaller one.
	second, err := svc.GetOrCreateGroup(ctx, "u1", []string{"u2", "u3", "u4"}, "")
	if err != nil {
		t.Fatalf("GetOrCreateGroup: %v", err)
	}
	if second.ID == first.ID {
		t.Errorf("GetOrCreateGroup reused %q for a different constellation", first.ID)
	}
}

// A subset constellation (fewer participants than the existing group) is
// NOT a match — the smaller group is its own thing.
func TestConversationService_GetOrCreateGroup_DoesNotMatchSubset(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob"}
	users.users["u3"] = &model.User{ID: "u3", DisplayName: "Carol"}

	big, err := svc.CreateGroup(ctx, "u1", []string{"u2", "u3"}, "")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	small, err := svc.GetOrCreateGroup(ctx, "u1", []string{"u2"}, "")
	// Note: a single-other "group" is normally routed to a DM in the
	// handler, but the service-level call accepts it as a group. The
	// invariant we care about: it is NOT the same as the bigger group.
	if err != nil {
		t.Fatalf("GetOrCreateGroup: %v", err)
	}
	if small.ID == big.ID {
		t.Errorf("GetOrCreateGroup reused %q for a subset constellation", big.ID)
	}
}

func TestConversationService_CreateGroup_CreatorAlreadyIncluded(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "User 1"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "User 2"}

	conv, err := svc.CreateGroup(ctx, "u1", []string{"u1", "u2"}, "With Creator")
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	// Creator is already in the list, should not be duplicated.
	if len(conv.ParticipantIDs) != 2 {
		t.Errorf("ParticipantIDs len = %d, want 2", len(conv.ParticipantIDs))
	}
}

func TestConversationService_CreateGroup_TooFew(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "User 1"}

	// Only the creator (auto-added), which makes just 1 participant.
	_, err := svc.CreateGroup(ctx, "u1", []string{}, "Solo Group")
	if err == nil {
		t.Fatal("expected error for group with fewer than 2 participants")
	}
}

func TestConversationService_CreateGroup_ParticipantNotFound(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	ctx := context.Background()

	users.users["u1"] = &model.User{ID: "u1", DisplayName: "User 1"}

	_, err := svc.CreateGroup(ctx, "u1", []string{"u1", "nonexistent"}, "Bad Group")
	if err == nil {
		t.Fatal("expected error for non-existent participant")
	}
}

func TestConversationService_ListUserConversations(t *testing.T) {
	svc, _, _, _, _ := setupConversationService()
	ctx := context.Background()

	convs, err := svc.ListUserConversations(ctx, "user-1")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(convs) != 0 {
		t.Errorf("expected empty list, got %d", len(convs))
	}
}

func TestConversationService_GetByID(t *testing.T) {
	svc, convStore, _, _, _ := setupConversationService()
	ctx := context.Background()

	convStore.conversations["conv-1"] = &model.Conversation{
		ID:             "conv-1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u1", "u2"},
	}

	conv, err := svc.GetByID(ctx, "u1", "conv-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if conv.ID != "conv-1" {
		t.Errorf("ID = %q, want %q", conv.ID, "conv-1")
	}
}

func TestConversationService_GetByID_NotParticipant(t *testing.T) {
	svc, convStore, _, _, _ := setupConversationService()
	ctx := context.Background()

	convStore.conversations["conv-2"] = &model.Conversation{
		ID:             "conv-2",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u1", "u2"},
	}

	_, err := svc.GetByID(ctx, "stranger", "conv-2")
	if err == nil {
		t.Fatal("expected error for non-participant")
	}
}

func TestConversationService_GetByID_NotFound(t *testing.T) {
	svc, _, _, _, _ := setupConversationService()
	ctx := context.Background()

	_, err := svc.GetByID(ctx, "u1", "nonexistent")
	if err == nil {
		t.Fatal("expected error for non-existent conversation")
	}
}

func TestDMConversationID(t *testing.T) {
	// Deterministic.
	id1 := dmConversationID("a", "b")
	id2 := dmConversationID("a", "b")
	if id1 != id2 {
		t.Error("dmConversationID should be deterministic")
	}

	// Order-independent.
	id3 := dmConversationID("b", "a")
	if id1 != id3 {
		t.Error("dmConversationID should be order-independent")
	}

	// Different pairs produce different IDs.
	id4 := dmConversationID("a", "c")
	if id1 == id4 {
		t.Error("different pairs should produce different IDs")
	}

	// Should be a valid ULID (26 alphanumeric chars).
	if len(id1) != 26 {
		t.Errorf("expected 26-char ULID, got %q (len=%d)", id1, len(id1))
	}
}
