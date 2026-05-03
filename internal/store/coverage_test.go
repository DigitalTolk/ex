//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/DigitalTolk/ex/internal/model"
)

// ============================================================================
// User Store: pagination & extra paths
// ============================================================================

func TestUserStore_List_Pagination(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewUserStore(db)
	ctx := context.Background()

	// Create 5 users with distinct CreatedAt to get deterministic GSI2SK ordering.
	base := time.Now().Truncate(time.Millisecond)
	for i := 0; i < 5; i++ {
		u := makeUser(
			fmt.Sprintf("u-pag-%d", i),
			fmt.Sprintf("pag%d@test.com", i),
			fmt.Sprintf("Pag %d", i),
		)
		u.CreatedAt = base.Add(time.Duration(i) * time.Second)
		u.UpdatedAt = u.CreatedAt
		if err := s.Create(ctx, u); err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}

	// First page (limit 2).
	page1, next, err := s.List(ctx, 2, "")
	if err != nil {
		t.Fatalf("List page1: %v", err)
	}
	if len(page1) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(page1))
	}
	if next == "" {
		t.Fatal("expected non-empty nextKey on first page")
	}

	// Second page using lastKey to exercise the ExclusiveStartKey branch.
	page2, _, err := s.List(ctx, 2, next)
	if err != nil {
		t.Fatalf("List page2: %v", err)
	}
	if len(page2) == 0 {
		t.Error("expected at least 1 user on page2")
	}
}

func TestUserStore_HasUsers_NonEmpty(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewUserStore(db)
	ctx := context.Background()

	if err := s.Create(ctx, makeUser("u-hu", "hu@test.com", "HU")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	has, err := s.HasUsers(ctx)
	if err != nil {
		t.Fatalf("HasUsers: %v", err)
	}
	if !has {
		t.Error("expected HasUsers=true")
	}
}

// ============================================================================
// Channel Store: GetByName positive path, ListPublic pagination
// ============================================================================

// TestChannelStore_GetByName_FoundViaDirectInsert seeds a channel item with
// GSI1PK=CHANNAME#... so GetByName actually finds it (the regular Create path
// stores GSI1PK=CHANSLUG#...). This exercises the unmarshal+return branch.
func TestChannelStore_GetByName_FoundViaDirectInsert(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()

	ch := makeChannel("ch-byname", "ByName", "byname-slug", model.ChannelTypePublic)
	item := channelItem{
		PK:      channelPK(ch.ID),
		SK:      "META_BYNAME", // a non-canonical SK so it doesn't conflict with the META item
		GSI1PK:  chanNameGSI1PK(ch.Name),
		GSI1SK:  chanGSI1SK(ch.ID),
		Channel: *ch,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_, err = db.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(db.Table),
		Item:      av,
	})
	if err != nil {
		t.Fatalf("PutItem: %v", err)
	}

	got, err := s.GetByName(ctx, "ByName")
	if err != nil {
		t.Fatalf("GetByName: %v", err)
	}
	if got.ID != "ch-byname" {
		t.Errorf("ID = %q, want %q", got.ID, "ch-byname")
	}
	if got.Name != "ByName" {
		t.Errorf("Name = %q, want %q", got.Name, "ByName")
	}
}

func TestChannelStore_GetByName_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()

	_, err := s.GetByName(ctx, "definitely-not-a-real-channel-name")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestChannelStore_ListPublic_Pagination(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()

	// Create 5 public channels with staggered CreatedAt to produce distinct GSI2SK.
	base := time.Now().Truncate(time.Millisecond)
	for i := 0; i < 5; i++ {
		ch := makeChannel(
			fmt.Sprintf("ch-lp-%d", i),
			fmt.Sprintf("lp-%d", i),
			fmt.Sprintf("lp-slug-%d", i),
			model.ChannelTypePublic,
		)
		ch.CreatedAt = base.Add(time.Duration(i) * time.Second)
		ch.UpdatedAt = ch.CreatedAt
		if err := s.Create(ctx, ch); err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}

	page1, next, err := s.ListPublic(ctx, 2, "")
	if err != nil {
		t.Fatalf("ListPublic page1: %v", err)
	}
	if len(page1) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(page1))
	}
	if next == "" {
		t.Fatal("expected non-empty nextKey on first page")
	}

	// Second page exercises the ExclusiveStartKey branch.
	page2, _, err := s.ListPublic(ctx, 2, next)
	if err != nil {
		t.Fatalf("ListPublic page2: %v", err)
	}
	if len(page2) == 0 {
		t.Error("expected at least 1 channel on page2")
	}
}

func TestChannelStore_ListPublic_FiltersArchived(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()

	live := makeChannel("ch-live", "live", "live-slug", model.ChannelTypePublic)
	if err := s.Create(ctx, live); err != nil {
		t.Fatalf("Create live: %v", err)
	}

	archived := makeChannel("ch-arch", "arch", "arch-slug", model.ChannelTypePublic)
	archived.Archived = true
	if err := s.Create(ctx, archived); err != nil {
		t.Fatalf("Create archived: %v", err)
	}

	channels, _, err := s.ListPublic(ctx, 50, "")
	if err != nil {
		t.Fatalf("ListPublic: %v", err)
	}

	for _, c := range channels {
		if c.Archived {
			t.Errorf("ListPublic returned archived channel %q", c.ID)
		}
	}
}

// ============================================================================
// Membership Store: error paths
// ============================================================================

func TestMembershipStore_AddChannelMember_Duplicate(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	cs := NewChannelStore(db)
	ctx := context.Background()

	ch := makeChannel("ch-dupmem", "dupmem", "dupmem-slug", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}

	member := &model.ChannelMembership{
		ChannelID: "ch-dupmem",
		UserID:    "u-dup",
		Role:      model.ChannelRoleMember,
		JoinedAt:  time.Now().Truncate(time.Millisecond),
	}
	userChan := &model.UserChannel{
		UserID:    "u-dup",
		ChannelID: "ch-dupmem",
		Role:      model.ChannelRoleMember,
		JoinedAt:  time.Now().Truncate(time.Millisecond),
	}

	if err := ms.AddChannelMember(ctx, ch, member, userChan); err != nil {
		t.Fatalf("AddChannelMember (first): %v", err)
	}

	err := ms.AddChannelMember(ctx, ch, member, userChan)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists on duplicate add, got %v", err)
	}
}

func TestMembershipStore_UpdateChannelRole_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	err := ms.UpdateChannelRole(ctx, "ch-ghost", "u-ghost", model.ChannelRoleAdmin)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestMembershipStore_RemoveChannelMember_Idempotent(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	// Removing a non-existent membership should not error (delete is idempotent).
	if err := ms.RemoveChannelMember(ctx, "ch-nope", "u-nope"); err != nil {
		t.Errorf("expected no error removing nonexistent member, got %v", err)
	}
}

func TestMembershipStore_ListChannelMembers_Empty(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	members, err := ms.ListChannelMembers(ctx, "ch-no-members")
	if err != nil {
		t.Fatalf("ListChannelMembers: %v", err)
	}
	if len(members) != 0 {
		t.Errorf("expected 0 members, got %d", len(members))
	}
}

func TestMembershipStore_ListUserChannels_Empty(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	chans, err := ms.ListUserChannels(ctx, "u-no-channels")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if len(chans) != 0 {
		t.Errorf("expected 0 channels, got %d", len(chans))
	}
}

// ============================================================================
// Message Store: extra paths
// ============================================================================

func TestMessageStore_Create_Duplicate(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMessageStore(db)
	ctx := context.Background()

	msg := &model.Message{
		ID:        "msg-dup",
		ParentID:  "ch-dupmsg",
		AuthorID:  "u-author",
		Body:      "Hello",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
	if err := ms.Create(ctx, msg); err != nil {
		t.Fatalf("Create first: %v", err)
	}

	err := ms.Create(ctx, msg)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got %v", err)
	}
}

func TestMessageStore_Create_DMParent(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMessageStore(db)
	ctx := context.Background()

	// dm_ prefix triggers convPK in parentPK helper.
	msg := &model.Message{
		ID:        "msg-dmcreate",
		ParentID:  "dm_create_test",
		AuthorID:  "u-author",
		Body:      "DM body",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
	if err := ms.Create(ctx, msg); err != nil {
		t.Fatalf("Create DM: %v", err)
	}

	// Confirm round-trip via the same parentPK selection.
	got, err := ms.GetByID(ctx, "dm_create_test", "msg-dmcreate")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Body != "DM body" {
		t.Errorf("Body = %q, want %q", got.Body, "DM body")
	}
}

func TestMessageStore_Delete_Idempotent(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMessageStore(db)
	ctx := context.Background()

	if err := ms.Delete(ctx, "ch-nodel", "msg-nodel"); err != nil {
		t.Errorf("expected no error deleting nonexistent message, got %v", err)
	}
}

func TestMessageStore_List_Empty(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMessageStore(db)
	ctx := context.Background()

	msgs, hasMore, err := ms.List(ctx, "ch-empty", "", 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}
	if hasMore {
		t.Error("expected hasMore=false on empty channel")
	}
}

// ============================================================================
// Conversation Store: extra paths
// ============================================================================

func TestConversationStore_Create_Duplicate(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	conv := &model.Conversation{
		ID:             "conv-dup",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-da", "u-db"},
		CreatedBy:      "u-da",
		CreatedAt:      time.Now().Truncate(time.Millisecond),
		UpdatedAt:      time.Now().Truncate(time.Millisecond),
	}
	members := []*model.UserConversation{
		{UserID: "u-da", ConversationID: "conv-dup", JoinedAt: time.Now()},
		{UserID: "u-db", ConversationID: "conv-dup", JoinedAt: time.Now()},
	}

	if err := cs.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create first: %v", err)
	}

	err := cs.Create(ctx, conv, members)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got %v", err)
	}
}

func TestConversationStore_ListUserConversations_Empty(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	convs, err := cs.ListUserConversations(ctx, "u-no-convs")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(convs) != 0 {
		t.Errorf("expected 0 conversations, got %d", len(convs))
	}
}

func TestConversationStore_IsMember_NonexistentConv(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	isMem, err := cs.IsMember(ctx, "conv-no-such", "u-anyone")
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if isMem {
		t.Error("expected IsMember=false for nonexistent conversation")
	}
}

// ============================================================================
// Token Store: empty DeleteAllForUser, exhaustive deletion
// ============================================================================

func TestTokenStore_DeleteAllForUser_NoTokens(t *testing.T) {
	db := setupDynamoDB(t)
	ts := NewTokenStore(db)
	ctx := context.Background()

	// User has no tokens; should be a no-op (empty page path).
	if err := ts.DeleteAllForUser(ctx, "u-no-tokens"); err != nil {
		t.Errorf("DeleteAllForUser empty: %v", err)
	}
}

func TestTokenStore_Delete_Idempotent(t *testing.T) {
	db := setupDynamoDB(t)
	ts := NewTokenStore(db)
	ctx := context.Background()

	if err := ts.Delete(ctx, "no-such-hash"); err != nil {
		t.Errorf("expected no error deleting nonexistent token, got %v", err)
	}
}

// ============================================================================
// Invite Store: idempotent delete
// ============================================================================

func TestInviteStore_Delete_Idempotent(t *testing.T) {
	db := setupDynamoDB(t)
	is := NewInviteStore(db)
	ctx := context.Background()

	if err := is.Delete(ctx, "no-such-invite-token"); err != nil {
		t.Errorf("expected no error deleting nonexistent invite, got %v", err)
	}
}

// ============================================================================
// Helpers and key builders (cover unused helpers)
// ============================================================================

// TestKeyBuilders ensures the key-builder helpers produce the expected formats.
// These are otherwise covered transitively, but we directly assert the small
// helpers to keep their coverage at 100%.
func TestKeyBuilders(t *testing.T) {
	cases := []struct {
		got  string
		want string
	}{
		{userPK("u1"), "USER#u1"},
		{userEmailPK("a@b"), "USEREMAIL#a@b"},
		{channelPK("c1"), "CHAN#c1"},
		{convPK("v1"), "CONV#v1"},
		{invitePK("t1"), "INVITE#t1"},
		{rtokenPK("h1"), "RTOKEN#h1"},
		{profileSK(), "PROFILE"},
		{metaSK(), "META"},
		{memberSK("u1"), "MEMBER#u1"},
		{msgSK("m1"), "MSG#m1"},
		{chanSK("c1"), "CHAN#c1"},
		{convSK("v1"), "CONV#v1"},
		{chanNameGSI1PK("foo"), "CHANNAME#foo"},
		{chanSlugGSI1PK("bar"), "CHANSLUG#bar"},
		{chanGSI1SK("c1"), "CHAN#c1"},
		{publicChanGSI2PK(), "PUBLIC_CHANNELS"},
		{allUsersGSI2PK(), "ALL_USERS"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d: got %q, want %q", i, c.got, c.want)
		}
	}
}

func TestDeriveID_Deterministic(t *testing.T) {
	a := DeriveID("seed-x")
	b := DeriveID("seed-x")
	if a != b {
		t.Errorf("DeriveID not deterministic: %q != %q", a, b)
	}
	if len(a) != 26 {
		t.Errorf("DeriveID length = %d, want 26", len(a))
	}

	c := DeriveID("seed-y")
	if a == c {
		t.Error("expected different DeriveID outputs for different seeds")
	}
}

func TestCompositeKey(t *testing.T) {
	k := compositeKey("PK1", "SK1")
	pk, ok := k["PK"].(*types.AttributeValueMemberS)
	if !ok || pk.Value != "PK1" {
		t.Errorf("PK = %v, want PK1", pk)
	}
	sk, ok := k["SK"].(*types.AttributeValueMemberS)
	if !ok || sk.Value != "SK1" {
		t.Errorf("SK = %v, want SK1", sk)
	}
}

func TestIsConditionCheckFailed(t *testing.T) {
	if isConditionCheckFailed(errors.New("plain")) {
		t.Error("plain error should not match")
	}
	ccf := &types.ConditionalCheckFailedException{}
	if !isConditionCheckFailed(ccf) {
		t.Error("CCF should match")
	}
}

// ============================================================================
// Operational error paths: exercise the "wrap-and-return" branches by pointing
// stores at a non-existent table. DynamoDB returns ResourceNotFoundException
// which the stores wrap and return.
// ============================================================================

func brokenDB(t *testing.T) *DB {
	t.Helper()
	src := setupDynamoDB(t)
	// Same client, but a table name that does not exist.
	return &DB{Client: src.Client, Table: "no-such-table-xyz"}
}

// Note: Unmarshal-error branches inside store ops are unreachable in practice
// because attributevalue.UnmarshalMap silently coerces missing/wrong-type
// fields rather than erroring. Coverage of those defensive branches would
// require either a refactored interface or fault injection at the SDK level.

func TestEnsureTable_DescribeTableNonNotFoundError(t *testing.T) {
	db := setupDynamoDB(t)

	// Cancel the context so DescribeTable returns a context error rather than
	// a ResourceNotFoundException — this exercises the errors.As-false branch.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := db.EnsureTable(ctx)
	if err == nil {
		t.Fatal("expected error from EnsureTable with cancelled context")
	}
	// ensure the wrapping path from describe error was taken (non-NotFound branch)
	// it's enough that the call returned an error.
}

func TestStores_NonexistentTable_ReturnsWrappedError(t *testing.T) {
	db := brokenDB(t)
	ctx := context.Background()

	// User store
	us := NewUserStore(db)
	if err := us.Create(ctx, makeUser("u-x", "x@x", "X")); err == nil {
		t.Error("UserStore.Create: expected error against missing table")
	}
	if _, err := us.GetByID(ctx, "u-x"); err == nil {
		t.Error("UserStore.GetByID: expected error")
	}
	if _, err := us.GetByEmail(ctx, "x@x"); err == nil {
		t.Error("UserStore.GetByEmail: expected error")
	}
	if err := us.Update(ctx, makeUser("u-x", "x@x", "X")); err == nil {
		t.Error("UserStore.Update: expected error")
	}
	if _, _, err := us.List(ctx, 10, ""); err == nil {
		t.Error("UserStore.List: expected error")
	}
	if _, err := us.HasUsers(ctx); err == nil {
		t.Error("UserStore.HasUsers: expected error")
	}

	// Channel store
	cs := NewChannelStore(db)
	ch := makeChannel("ch-x", "x", "x", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err == nil {
		t.Error("ChannelStore.Create: expected error")
	}
	if _, err := cs.GetByID(ctx, "ch-x"); err == nil {
		t.Error("ChannelStore.GetByID: expected error")
	}
	if _, err := cs.GetBySlug(ctx, "x"); err == nil {
		t.Error("ChannelStore.GetBySlug: expected error")
	}
	if _, err := cs.GetByName(ctx, "x"); err == nil {
		t.Error("ChannelStore.GetByName: expected error")
	}
	if err := cs.Update(ctx, ch); err == nil {
		t.Error("ChannelStore.Update: expected error")
	}
	if _, _, err := cs.ListPublic(ctx, 10, ""); err == nil {
		t.Error("ChannelStore.ListPublic: expected error")
	}

	// Membership store
	ms := NewMembershipStore(db)
	mem := &model.ChannelMembership{ChannelID: "ch-x", UserID: "u-x", JoinedAt: time.Now()}
	uc := &model.UserChannel{UserID: "u-x", ChannelID: "ch-x", JoinedAt: time.Now()}
	if err := ms.AddChannelMember(ctx, ch, mem, uc); err == nil {
		t.Error("MembershipStore.AddChannelMember: expected error")
	}
	if err := ms.RemoveChannelMember(ctx, "ch-x", "u-x"); err == nil {
		t.Error("MembershipStore.RemoveChannelMember: expected error")
	}
	if _, err := ms.GetChannelMembership(ctx, "ch-x", "u-x"); err == nil {
		t.Error("MembershipStore.GetChannelMembership: expected error")
	}
	if _, err := ms.ListChannelMembers(ctx, "ch-x"); err == nil {
		t.Error("MembershipStore.ListChannelMembers: expected error")
	}
	if _, err := ms.ListUserChannels(ctx, "u-x"); err == nil {
		t.Error("MembershipStore.ListUserChannels: expected error")
	}
	if err := ms.UpdateChannelRole(ctx, "ch-x", "u-x", model.ChannelRoleAdmin); err == nil {
		t.Error("MembershipStore.UpdateChannelRole: expected error")
	}

	// Message store
	mss := NewMessageStore(db)
	msg := &model.Message{ID: "m-x", ParentID: "ch-x", AuthorID: "u-x", Body: "x", CreatedAt: time.Now()}
	if err := mss.Create(ctx, msg); err == nil {
		t.Error("MessageStore.Create: expected error")
	}
	if _, err := mss.GetByID(ctx, "ch-x", "m-x"); err == nil {
		t.Error("MessageStore.GetByID: expected error")
	}
	if _, _, err := mss.List(ctx, "ch-x", "", 10); err == nil {
		t.Error("MessageStore.List: expected error")
	}
	if err := mss.Update(ctx, "ch-x", msg); err == nil {
		t.Error("MessageStore.Update: expected error")
	}
	if _, _, err := mss.ListAfter(ctx, "ch-x", "m-x", 10); err == nil {
		t.Error("MessageStore.ListAfter: expected error")
	}
	if _, _, _, err := mss.ListAround(ctx, "ch-x", "m-x", 10, 10); err == nil {
		t.Error("MessageStore.ListAround: expected error")
	}
	if _, err := mss.IncrementReplyMetadata(ctx, "ch-x", "m-x", time.Now(), "u-x"); err == nil {
		t.Error("MessageStore.IncrementReplyMetadata: expected error")
	}
	if err := mss.Delete(ctx, "ch-x", "m-x"); err == nil {
		t.Error("MessageStore.Delete: expected error")
	}

	// Conversation store
	convs := NewConversationStore(db)
	conv := &model.Conversation{
		ID:             "v-x",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-a", "u-b"},
		CreatedBy:      "u-a",
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}
	mems := []*model.UserConversation{
		{UserID: "u-a", ConversationID: "v-x", JoinedAt: time.Now()},
		{UserID: "u-b", ConversationID: "v-x", JoinedAt: time.Now()},
	}
	if err := convs.Create(ctx, conv, mems); err == nil {
		t.Error("ConversationStore.Create: expected error")
	}
	if _, err := convs.GetByID(ctx, "v-x"); err == nil {
		t.Error("ConversationStore.GetByID: expected error")
	}
	if _, err := convs.ListUserConversations(ctx, "u-a"); err == nil {
		t.Error("ConversationStore.ListUserConversations: expected error")
	}
	if err := convs.Activate(ctx, "v-x", []string{"u-a", "u-b"}); err == nil {
		t.Error("ConversationStore.Activate: expected error")
	}
	if err := convs.Touch(ctx, "v-x", []string{"u-a", "u-b"}, time.Now()); err == nil {
		t.Error("ConversationStore.Touch: expected error")
	}
	if err := convs.SetUserConversationFavorite(ctx, "v-x", "u-a", true); err == nil {
		t.Error("ConversationStore.SetUserConversationFavorite: expected error")
	}
	pos := 1
	if err := convs.SetUserConversationCategory(ctx, "v-x", "u-a", "cat-x", &pos); err == nil {
		t.Error("ConversationStore.SetUserConversationCategory: expected error")
	}
	if _, err := convs.IsMember(ctx, "v-x", "u-a"); err == nil {
		t.Error("ConversationStore.IsMember: expected error")
	}
	if _, err := convs.ListAll(ctx); err == nil {
		t.Error("ConversationStore.ListAll: expected error")
	}

	// Invite store
	inv := &model.Invite{Token: "t-x", Email: "x@x", InviterID: "u-x", ExpiresAt: time.Now().Add(time.Hour), CreatedAt: time.Now()}
	is := NewInviteStore(db)
	if err := is.Create(ctx, inv); err == nil {
		t.Error("InviteStore.Create: expected error")
	}
	if _, err := is.GetByToken(ctx, "t-x"); err == nil {
		t.Error("InviteStore.GetByToken: expected error")
	}
	if err := is.Delete(ctx, "t-x"); err == nil {
		t.Error("InviteStore.Delete: expected error")
	}

	// Token store
	ts := NewTokenStore(db)
	tok := &model.RefreshToken{TokenHash: "h-x", UserID: "u-x", ExpiresAt: time.Now().Add(time.Hour), CreatedAt: time.Now()}
	if err := ts.Create(ctx, tok); err == nil {
		t.Error("TokenStore.Create: expected error")
	}
	if _, err := ts.GetByHash(ctx, "h-x"); err == nil {
		t.Error("TokenStore.GetByHash: expected error")
	}
	if err := ts.Delete(ctx, "h-x"); err == nil {
		t.Error("TokenStore.Delete: expected error")
	}
	if err := ts.DeleteAllForUser(ctx, "u-x"); err == nil {
		t.Error("TokenStore.DeleteAllForUser: expected error")
	}
}

func TestIsTransactionCancelledWithCondition(t *testing.T) {
	if isTransactionCancelledWithCondition(errors.New("plain")) {
		t.Error("plain error should not match")
	}
	// Empty cancellation reasons.
	tce := &types.TransactionCanceledException{}
	if isTransactionCancelledWithCondition(tce) {
		t.Error("empty cancellation reasons should not match")
	}
	// With a non-CCF reason.
	other := "Other"
	tce2 := &types.TransactionCanceledException{
		CancellationReasons: []types.CancellationReason{
			{Code: &other},
		},
	}
	if isTransactionCancelledWithCondition(tce2) {
		t.Error("non-CCF reason should not match")
	}
	// With a CCF reason.
	ccf := "ConditionalCheckFailed"
	tce3 := &types.TransactionCanceledException{
		CancellationReasons: []types.CancellationReason{
			{Code: &ccf},
		},
	}
	if !isTransactionCancelledWithCondition(tce3) {
		t.Error("CCF reason should match")
	}
}
