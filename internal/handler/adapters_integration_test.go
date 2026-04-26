//go:build integration

package handler

import (
	"context"
	"fmt"
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

func setupDynamoForAdapters(t *testing.T) *store.DB {
	t.Helper()
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
		t.Skipf("skipping: Docker not available: %v", err)
	}
	t.Cleanup(func() { container.Terminate(ctx) })

	host, _ := container.Host(ctx)
	port, _ := container.MappedPort(ctx, "8000")
	endpoint := fmt.Sprintf("http://%s:%s", host, port.Port())

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("dummy", "dummy", "dummy")),
	)
	if err != nil {
		t.Fatalf("load aws config: %v", err)
	}

	client := dynamodb.NewFromConfig(awsCfg, func(o *dynamodb.Options) {
		o.BaseEndpoint = aws.String(endpoint)
	})

	db := &store.DB{
		Client: client,
		Table:  "test-adapters",
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
}
