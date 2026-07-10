//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// The alerted-unread badge counter: incremented by the notifier per alerted
// recipient, reset in the SAME write that advances the read watermark.

func seedNotifyMembership(t *testing.T, db *DB, channelID, userID string) {
	t.Helper()
	ms := NewMembershipStore(db)
	ch := &model.Channel{ID: channelID, Name: channelID, Slug: channelID, Type: model.ChannelTypePublic, CreatedAt: time.Now()}
	mem := &model.ChannelMembership{ChannelID: channelID, UserID: userID, Role: model.ChannelRoleMember, JoinedAt: time.Now()}
	uc := &model.UserChannel{UserID: userID, ChannelID: channelID, ChannelName: channelID, JoinedAt: time.Now()}
	if err := ms.AddChannelMember(context.Background(), ch, mem, uc); err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}
}

func userChannelRow(t *testing.T, db *DB, userID, channelID string) *model.UserChannel {
	t.Helper()
	rows, err := NewMembershipStore(db).ListUserChannels(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	for _, uc := range rows {
		if uc.ChannelID == channelID {
			return uc
		}
	}
	t.Fatalf("membership %s/%s not found", channelID, userID)
	return nil
}

func TestMembershipStore_NotifyCountLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMembershipStore(db)
	seedNotifyMembership(t, db, "ch-nc", "u-1")

	// Each alerted message returns the authoritative running count.
	if n, err := ms.IncrementNotifyCount(ctx, "ch-nc", "u-1"); err != nil || n != 1 {
		t.Fatalf("first bump = %d (err=%v), want 1", n, err)
	}
	if n, err := ms.IncrementNotifyCount(ctx, "ch-nc", "u-1"); err != nil || n != 2 {
		t.Fatalf("second bump = %d (err=%v), want 2", n, err)
	}
	if got := userChannelRow(t, db, "u-1", "ch-nc"); got.UnreadNotifyCount != 2 {
		t.Fatalf("persisted count = %d, want 2", got.UnreadNotifyCount)
	}

	// Catching up clears the badge in the SAME write as the watermark.
	if err := ms.SetChannelLastRead(ctx, "ch-nc", "u-1", 7); err != nil {
		t.Fatalf("SetChannelLastRead: %v", err)
	}
	got := userChannelRow(t, db, "u-1", "ch-nc")
	if got.UnreadNotifyCount != 0 || got.LastReadSeq != 7 {
		t.Fatalf("after read: count=%d seq=%d, want 0/7", got.UnreadNotifyCount, got.LastReadSeq)
	}

	// A bump against a non-membership maps to ErrNotFound (no orphan rows).
	if _, err := ms.IncrementNotifyCount(ctx, "ch-nc", "u-stranger"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger bump = %v, want ErrNotFound", err)
	}

	// SDK failure surfaces.
	faulted := NewMembershipStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if _, err := faulted.IncrementNotifyCount(ctx, "ch-nc", "u-1"); !errors.Is(err, errInjected) {
		t.Fatalf("fault = %v, want errInjected", err)
	}

	// A corrupt UPDATED_NEW payload hits the unmarshal arm.
	corrupt := NewMembershipStore(withFault(db, func(f *faultClient) {
		f.transformUpdateItem = func(out *dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput {
			out.Attributes = map[string]types.AttributeValue{
				"unreadNotifyCount": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
			}
			return out
		}
	}))
	_, err := corrupt.IncrementNotifyCount(ctx, "ch-nc", "u-1")
	assertUnmarshalErr(t, err, "membership IncrementNotifyCount")
}

func TestConversationStore_NotifyCountLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)

	conv := &model.Conversation{ID: "conv-nc", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-a", "u-b"}, CreatedAt: time.Now()}
	members := []*model.UserConversation{
		{UserID: "u-a", ConversationID: "conv-nc", JoinedAt: time.Now()},
		{UserID: "u-b", ConversationID: "conv-nc", JoinedAt: time.Now()},
	}
	if err := cs.CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if n, err := cs.IncrementNotifyCount(ctx, "conv-nc", "u-b"); err != nil || n != 1 {
		t.Fatalf("bump = %d (err=%v), want 1", n, err)
	}
	rows, err := cs.ListUserConversations(ctx, "u-b")
	if err != nil || len(rows) != 1 || rows[0].UnreadNotifyCount != 1 {
		t.Fatalf("persisted = %+v (err=%v), want count 1", rows, err)
	}

	if err := cs.SetConversationLastRead(ctx, "conv-nc", "u-b", 3); err != nil {
		t.Fatalf("SetConversationLastRead: %v", err)
	}
	rows, _ = cs.ListUserConversations(ctx, "u-b")
	if rows[0].UnreadNotifyCount != 0 || rows[0].LastReadSeq != 3 {
		t.Fatalf("after read: count=%d seq=%d, want 0/3", rows[0].UnreadNotifyCount, rows[0].LastReadSeq)
	}

	if _, err := cs.IncrementNotifyCount(ctx, "conv-nc", "u-stranger"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger bump = %v, want ErrNotFound", err)
	}
	faulted := NewConversationStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if _, err := faulted.IncrementNotifyCount(ctx, "conv-nc", "u-b"); !errors.Is(err, errInjected) {
		t.Fatalf("fault = %v, want errInjected", err)
	}
	corrupt := NewConversationStore(withFault(db, func(f *faultClient) {
		f.transformUpdateItem = func(out *dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput {
			out.Attributes = map[string]types.AttributeValue{
				"unreadNotifyCount": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
			}
			return out
		}
	}))
	_, err = corrupt.IncrementNotifyCount(ctx, "conv-nc", "u-b")
	assertUnmarshalErr(t, err, "conversation IncrementNotifyCount")
}
