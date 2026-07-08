//go:build integration

package handler

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// Capability arms of the batch/participation adapter methods against the real
// DynamoDB impls (the fallback arms run in perf_batch_adapters_test.go).

func TestChannelStoreAdapter_GetChannelsByIDs(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	adapter := NewChannelStoreAdapter(store.NewChannelStore(db))

	now := time.Now().Truncate(time.Millisecond)
	for _, ch := range []*model.Channel{
		{ID: "ch-bg-a", Name: "bg a", Slug: "bg-a", Type: model.ChannelTypePublic, CreatedBy: "t", CreatedAt: now, UpdatedAt: now},
		{ID: "ch-bg-b", Name: "bg b", Slug: "bg-b", Type: model.ChannelTypePublic, CreatedBy: "t", CreatedAt: now, UpdatedAt: now},
	} {
		if err := adapter.CreateChannel(ctx, ch); err != nil {
			t.Fatalf("CreateChannel %s: %v", ch.ID, err)
		}
	}
	got, err := adapter.GetChannelsByIDs(ctx, []string{"ch-bg-a", "ch-bg-missing", "ch-bg-b"})
	if err != nil {
		t.Fatalf("GetChannelsByIDs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d channels, want 2", len(got))
	}
}

func TestMessageStoreAdapter_GetMessagesByIDs_BatchArm(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	adapter := NewMessageStoreAdapter(store.NewMessageStore(db))

	now := time.Now().Truncate(time.Millisecond)
	for _, m := range []*model.Message{
		{ID: "m-bg-a", ParentID: "ch-bg", AuthorID: "u", Body: "a", CreatedAt: now},
		{ID: "m-bg-b", ParentID: "ch-bg", AuthorID: "u", Body: "b", CreatedAt: now},
	} {
		if err := adapter.CreateMessage(ctx, m); err != nil {
			t.Fatalf("CreateMessage %s: %v", m.ID, err)
		}
	}
	got, err := adapter.GetMessagesByIDs(ctx, "ch-bg", []string{"m-bg-a", "m-bg-missing", "m-bg-b"})
	if err != nil {
		t.Fatalf("GetMessagesByIDs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2 (batch arm, miss skipped)", len(got))
	}
}

func TestThreadFollowStoreAdapter_ParticipationCapabilityArm(t *testing.T) {
	db := setupDynamoForAdapters(t)
	ctx := context.Background()
	adapter := NewThreadFollowStoreAdapter(store.NewThreadFollowStore(db))

	// Conditional write goes through the store's SetIfAbsent…
	follow := &model.ThreadFollow{
		UserID: "u-cap", ParentID: "ch-cap", ParentType: service.ParentChannel,
		ThreadRootID: "root-1", Following: true, UpdatedAt: time.Now().Truncate(time.Millisecond),
	}
	if err := adapter.SetThreadFollowIfAbsent(ctx, follow); err != nil {
		t.Fatalf("SetThreadFollowIfAbsent: %v", err)
	}
	got, err := adapter.GetThreadFollow(ctx, "u-cap", "ch-cap", "root-1")
	if err != nil || !got.Following {
		t.Fatalf("follow = %+v (err=%v), want Following=true", got, err)
	}

	// …and the seed marker round-trips through the real marker row.
	seeded, err := adapter.IsThreadIndexSeeded(ctx, "u-cap")
	if err != nil || seeded {
		t.Fatalf("IsThreadIndexSeeded before mark = %v (err=%v), want false", seeded, err)
	}
	if err := adapter.MarkThreadIndexSeeded(ctx, "u-cap"); err != nil {
		t.Fatalf("MarkThreadIndexSeeded: %v", err)
	}
	seeded, err = adapter.IsThreadIndexSeeded(ctx, "u-cap")
	if err != nil || !seeded {
		t.Fatalf("IsThreadIndexSeeded after mark = %v (err=%v), want true", seeded, err)
	}
}
