//go:build integration

package handler

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// One DynamoDB Local container is shared by every adapter integration test
// in this package. The original setup spun up a fresh container per test —
// fine when there were two of them, but flaky once the suite grew to 8+
// (Docker resource pressure produces "EOF" / "StatusCode: 0" errors mid-
// DescribeTable). Mirroring the pattern in internal/store, each test now
// gets a uniquely-named table inside the shared container.
var (
	adapterEndpoint  string
	adapterAvailable bool
	adapterTableSeq  atomic.Uint64
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	req := testcontainers.ContainerRequest{
		Image:        "amazon/dynamodb-local:latest",
		ExposedPorts: []string{"8000/tcp"},
		WaitingFor:   wait.ForListeningPort("8000/tcp").WithStartupTimeout(60 * time.Second),
		Cmd:          []string{"-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"},
	}
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		log.Printf("adapter integration tests will skip: docker unavailable: %v", err)
		os.Exit(m.Run())
	}

	host, herr := container.Host(ctx)
	if herr == nil {
		port, perr := container.MappedPort(ctx, "8000")
		if perr == nil {
			adapterEndpoint = fmt.Sprintf("http://%s:%s", host, port.Port())
			adapterAvailable = true
		}
	}

	code := m.Run()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

func setupDynamoForAdapters(t *testing.T) *store.DB {
	t.Helper()
	if !adapterAvailable {
		t.Skip("skipping: Docker / DynamoDB Local not available")
	}
	ctx := context.Background()

	// Retry generously — GH Actions occasionally TCP-resets connections
	// to the local container under load and the SDK's default 3-attempt
	// limit is too tight for that environment.
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("dummy", "dummy", "dummy")),
		awsconfig.WithRetryMaxAttempts(10),
	)
	if err != nil {
		t.Fatalf("load aws config: %v", err)
	}

	client := dynamodb.NewFromConfig(awsCfg, func(o *dynamodb.Options) {
		o.BaseEndpoint = aws.String(adapterEndpoint)
	})

	db := &store.DB{
		Client: client,
		Table:  fmt.Sprintf("test-adapters-%d", adapterTableSeq.Add(1)),
	}

	if err := db.EnsureTable(ctx); err != nil {
		t.Fatalf("ensure table: %v", err)
	}

	return db
}

func TestUserStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewUserStore(db)
	adapter := NewUserStoreAdapter(storeImpl)

	now := time.Now().Truncate(time.Millisecond)
	user := &model.User{
		ID:          "u-adapt-1",
		Email:       "adapt1@test.com",
		DisplayName: "Adapter User 1",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	// CreateUser
	if err := adapter.CreateUser(ctx, user); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// Brief pause for DynamoDB Local GSI propagation.
	time.Sleep(500 * time.Millisecond)

	// GetUser
	got, err := adapter.GetUser(ctx, "u-adapt-1")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.Email != "adapt1@test.com" {
		t.Errorf("Email = %q, want %q", got.Email, "adapt1@test.com")
	}

	// GetUserByEmail
	got2, err := adapter.GetUserByEmail(ctx, "adapt1@test.com")
	if err != nil {
		t.Fatalf("GetUserByEmail: %v", err)
	}
	if got2.ID != "u-adapt-1" {
		t.Errorf("ID = %q, want %q", got2.ID, "u-adapt-1")
	}

	// UpdateUser
	user.DisplayName = "Updated"
	if err := adapter.UpdateUser(ctx, user); err != nil {
		t.Fatalf("UpdateUser: %v", err)
	}

	// ListUsers
	users, _, err := adapter.ListUsers(ctx, 10, "")
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) < 1 {
		t.Error("expected at least 1 user")
	}

	// HasUsers
	has, err := adapter.HasUsers(ctx)
	if err != nil {
		t.Fatalf("HasUsers: %v", err)
	}
	if !has {
		t.Error("expected HasUsers=true")
	}
}

func TestChannelStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewChannelStore(db)
	adapter := NewChannelStoreAdapter(storeImpl)

	now := time.Now().Truncate(time.Millisecond)
	ch := &model.Channel{
		ID:        "ch-adapt-1",
		Name:      "adapter-channel",
		Slug:      "adapter-channel",
		Type:      model.ChannelTypePublic,
		CreatedBy: "test",
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := adapter.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	got, err := adapter.GetChannel(ctx, "ch-adapt-1")
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if got.Name != "adapter-channel" {
		t.Errorf("Name = %q, want %q", got.Name, "adapter-channel")
	}

	gotSlug, err := adapter.GetChannelBySlug(ctx, "adapter-channel")
	if err != nil {
		t.Fatalf("GetChannelBySlug: %v", err)
	}
	if gotSlug.ID != "ch-adapt-1" {
		t.Errorf("ID = %q, want %q", gotSlug.ID, "ch-adapt-1")
	}

	ch.Description = "updated"
	if err := adapter.UpdateChannel(ctx, ch); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}

	channels, _, err := adapter.ListPublicChannels(ctx, 10, "")
	if err != nil {
		t.Fatalf("ListPublicChannels: %v", err)
	}
	if len(channels) < 1 {
		t.Error("expected at least 1 public channel")
	}

	all, err := adapter.ListAllChannels(ctx)
	if err != nil {
		t.Fatalf("ListAllChannels: %v", err)
	}
	if len(all) < 1 {
		t.Error("expected ListAllChannels to return at least 1 channel")
	}
}

func TestMembershipStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	chanStore := store.NewChannelStore(db)
	memStore := store.NewMembershipStore(db)
	adapter := NewMembershipStoreAdapter(memStore)

	now := time.Now().Truncate(time.Millisecond)
	ch := &model.Channel{
		ID: "ch-ma-1", Name: "ma-chan", Slug: "ma-chan",
		Type: model.ChannelTypePublic, CreatedBy: "test", CreatedAt: now, UpdatedAt: now,
	}
	if err := chanStore.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}

	mem := &model.ChannelMembership{
		ChannelID: "ch-ma-1", UserID: "u-ma-1", Role: model.ChannelRoleMember,
		DisplayName: "MA1", JoinedAt: now,
	}
	uc := &model.UserChannel{
		UserID: "u-ma-1", ChannelID: "ch-ma-1", ChannelName: "ma-chan",
		ChannelType: model.ChannelTypePublic, Role: model.ChannelRoleMember, JoinedAt: now,
	}

	if err := adapter.AddMember(ctx, mem, uc); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	got, err := adapter.GetMembership(ctx, "ch-ma-1", "u-ma-1")
	if err != nil {
		t.Fatalf("GetMembership: %v", err)
	}
	if got.UserID != "u-ma-1" {
		t.Errorf("UserID = %q, want %q", got.UserID, "u-ma-1")
	}

	members, err := adapter.ListMembers(ctx, "ch-ma-1")
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 1 {
		t.Errorf("expected 1 member, got %d", len(members))
	}

	userChans, err := adapter.ListUserChannels(ctx, "u-ma-1")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if len(userChans) != 1 {
		t.Errorf("expected 1 user channel, got %d", len(userChans))
	}

	if err := adapter.UpdateMemberRole(ctx, "ch-ma-1", "u-ma-1", model.ChannelRoleAdmin); err != nil {
		t.Fatalf("UpdateMemberRole: %v", err)
	}

	if err := adapter.SetMute(ctx, "ch-ma-1", "u-ma-1", true); err != nil {
		t.Fatalf("SetMute: %v", err)
	}

	if err := adapter.SetFavorite(ctx, "ch-ma-1", "u-ma-1", true); err != nil {
		t.Fatalf("SetFavorite: %v", err)
	}
	if err := adapter.SetCategory(ctx, "ch-ma-1", "u-ma-1", "cat-1"); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}

	if err := adapter.RemoveMember(ctx, "ch-ma-1", "u-ma-1"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
}

func TestConversationStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewConversationStore(db)
	adapter := NewConversationStoreAdapter(storeImpl)

	now := time.Now().Truncate(time.Millisecond)
	conv := &model.Conversation{
		ID: "conv-adapt", Type: model.ConversationTypeDM,
		ParticipantIDs: []string{"u-ca1", "u-ca2"}, CreatedBy: "u-ca1",
		CreatedAt: now, UpdatedAt: now,
	}
	members := []*model.UserConversation{
		{UserID: "u-ca1", ConversationID: "conv-adapt", Type: model.ConversationTypeDM, JoinedAt: now},
		{UserID: "u-ca2", ConversationID: "conv-adapt", Type: model.ConversationTypeDM, JoinedAt: now},
	}

	if err := adapter.CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}

	got, err := adapter.GetConversation(ctx, "conv-adapt")
	if err != nil {
		t.Fatalf("GetConversation: %v", err)
	}
	if got.ID != "conv-adapt" {
		t.Errorf("ID = %q, want %q", got.ID, "conv-adapt")
	}

	userConvs, err := adapter.ListUserConversations(ctx, "u-ca1")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(userConvs) != 1 {
		t.Errorf("expected 1 user conversation, got %d", len(userConvs))
	}

	if err := adapter.ActivateConversation(ctx, "conv-adapt", []string{"u-ca1", "u-ca2"}); err != nil {
		t.Fatalf("ActivateConversation: %v", err)
	}

	if err := adapter.SetFavorite(ctx, "conv-adapt", "u-ca1", true); err != nil {
		t.Fatalf("SetFavorite: %v", err)
	}
	if err := adapter.SetCategory(ctx, "conv-adapt", "u-ca1", "cat-conv"); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}

	all, err := adapter.ListAllConversations(ctx)
	if err != nil {
		t.Fatalf("ListAllConversations: %v", err)
	}
	if len(all) < 1 {
		t.Error("expected ListAllConversations to return at least 1 conversation")
	}
}

func TestMessageStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewMessageStore(db)
	adapter := NewMessageStoreAdapter(storeImpl)

	now := time.Now().Truncate(time.Millisecond)
	msg := &model.Message{
		ID: "msg-adapt-1", ParentID: "ch-msgadapt", AuthorID: "u-author",
		Body: "adapter test", CreatedAt: now,
	}

	if err := adapter.CreateMessage(ctx, msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	got, err := adapter.GetMessage(ctx, "ch-msgadapt", "msg-adapt-1")
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if got.Body != "adapter test" {
		t.Errorf("Body = %q, want %q", got.Body, "adapter test")
	}

	editedAt := time.Now().Truncate(time.Millisecond)
	msg.Body = "updated"
	msg.EditedAt = &editedAt
	if err := adapter.UpdateMessage(ctx, msg); err != nil {
		t.Fatalf("UpdateMessage: %v", err)
	}

	messages, _, err := adapter.ListMessages(ctx, "ch-msgadapt", "", 10)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(messages) != 1 {
		t.Errorf("expected 1 message, got %d", len(messages))
	}

	if err := adapter.DeleteMessage(ctx, "ch-msgadapt", "msg-adapt-1"); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
}

// TestMessageStoreAdapter_ListAfter_ListAround exercises the two
// directional list adapters used by the "jump to message" UX. Both are
// thin pass-throughs but they are wired into the production handler so
// a regression-proof test belongs at the adapter layer, not just inside
// the store package.
func TestMessageStoreAdapter_ListAfter_ListAround(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewMessageStore(db)
	adapter := NewMessageStoreAdapter(storeImpl)

	// Seed a small ordered set of messages so before/after windows have
	// something predictable to bracket.
	parent := "ch-msgadapt-window"
	base := time.Now().Truncate(time.Millisecond)
	ids := []string{"m01", "m02", "m03", "m04", "m05"}
	for i, id := range ids {
		msg := &model.Message{
			ID:        id,
			ParentID:  parent,
			AuthorID:  "u-window",
			Body:      fmt.Sprintf("body-%d", i),
			CreatedAt: base.Add(time.Duration(i) * time.Second),
		}
		if err := adapter.CreateMessage(ctx, msg); err != nil {
			t.Fatalf("CreateMessage %s: %v", id, err)
		}
	}

	// ListMessagesAfter: ask for everything strictly newer than m02.
	after, _, err := adapter.ListMessagesAfter(ctx, parent, "m02", 10)
	if err != nil {
		t.Fatalf("ListMessagesAfter: %v", err)
	}
	if len(after) == 0 {
		t.Fatal("expected at least one message after m02")
	}
	for _, m := range after {
		if m.ID <= "m02" {
			t.Errorf("ListMessagesAfter returned %q which is not strictly after m02", m.ID)
		}
	}

	// ListMessagesAround: 1 before + 1 after centred on m03 → [m02, m03, m04].
	around, _, _, err := adapter.ListMessagesAround(ctx, parent, "m03", 1, 1)
	if err != nil {
		t.Fatalf("ListMessagesAround: %v", err)
	}
	if len(around) < 2 {
		t.Fatalf("ListMessagesAround: expected at least 2 surrounding messages, got %d", len(around))
	}
	var sawCenter bool
	for _, m := range around {
		if m.ID == "m03" {
			sawCenter = true
		}
	}
	if !sawCenter {
		t.Error("ListMessagesAround result must include the center message m03")
	}
}

func TestInviteStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewInviteStore(db)
	adapter := NewInviteStoreAdapter(storeImpl)

	now := time.Now().Truncate(time.Millisecond)
	inv := &model.Invite{
		Token: "inv-adapt-1", Email: "inv@test.com", InviterID: "u-inv",
		ExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
	}

	if err := adapter.CreateInvite(ctx, inv); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	got, err := adapter.GetInvite(ctx, "inv-adapt-1")
	if err != nil {
		t.Fatalf("GetInvite: %v", err)
	}
	if got.Email != "inv@test.com" {
		t.Errorf("Email = %q, want %q", got.Email, "inv@test.com")
	}

	if err := adapter.DeleteInvite(ctx, "inv-adapt-1"); err != nil {
		t.Fatalf("DeleteInvite: %v", err)
	}
}

func TestTokenStoreAdapter(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	storeImpl := store.NewTokenStore(db)
	adapter := NewTokenStoreAdapter(storeImpl)

	now := time.Now().Truncate(time.Millisecond)
	rt := &model.RefreshToken{
		TokenHash: "rt-adapt-1", UserID: "u-rt",
		ExpiresAt: now.Add(720 * time.Hour), CreatedAt: now,
	}

	if err := adapter.StoreRefreshToken(ctx, rt); err != nil {
		t.Fatalf("StoreRefreshToken: %v", err)
	}

	got, err := adapter.GetRefreshToken(ctx, "rt-adapt-1")
	if err != nil {
		t.Fatalf("GetRefreshToken: %v", err)
	}
	if got.UserID != "u-rt" {
		t.Errorf("UserID = %q, want %q", got.UserID, "u-rt")
	}

	if err := adapter.DeleteRefreshToken(ctx, "rt-adapt-1"); err != nil {
		t.Fatalf("DeleteRefreshToken: %v", err)
	}

	// Re-store + bulk-delete path covers the deactivation flow that
	// invalidates every outstanding token for a user.
	rt2 := &model.RefreshToken{
		TokenHash: "rt-adapt-2", UserID: "u-rt",
		ExpiresAt: now.Add(720 * time.Hour), CreatedAt: now,
	}
	if err := adapter.StoreRefreshToken(ctx, rt2); err != nil {
		t.Fatalf("StoreRefreshToken (rt2): %v", err)
	}
	if err := adapter.DeleteAllRefreshTokensForUser(ctx, "u-rt"); err != nil {
		t.Fatalf("DeleteAllRefreshTokensForUser: %v", err)
	}
}
