//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// The read point only moves forward: a stale write (lower seq, or same seq
// with an older message ID) is a silent no-op, so a lagging tab or a reordered
// detached author-read can never pull it back.
func TestSetChannelLastRead_ForwardOnly(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMembershipStore(db)
	seedNotifyMembership(t, db, "ch-rp", "u-1")

	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 5, "01B"); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if _, err := ms.IncrementNotifyCount(ctx, "ch-rp", "u-1"); err != nil {
		t.Fatalf("IncrementNotifyCount: %v", err)
	}
	// Behind on seq → stale no-op, and the alerted badge is NOT cleared by it.
	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 3, "01C"); !errors.Is(err, ErrStaleReadPoint) {
		t.Fatalf("stale seq: want ErrStaleReadPoint, got %v", err)
	}
	// Same seq, older message ID → stale no-op.
	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 5, "01A"); !errors.Is(err, ErrStaleReadPoint) {
		t.Fatalf("stale msg ID: want ErrStaleReadPoint, got %v", err)
	}
	got := userChannelRow(t, db, "u-1", "ch-rp")
	if got.LastReadSeq != 5 || got.LastReadMsgID != "01B" || got.UnreadNotifyCount != 1 {
		t.Fatalf("after stale writes = (%d, %q, notify %d), want (5, 01B, 1)", got.LastReadSeq, got.LastReadMsgID, got.UnreadNotifyCount)
	}
	// A HIGHER seq wins even when its message ID sorts lower (IDs aren't
	// ordered with seqs) — but the stored, newer ID is kept: neither field
	// ever moves backwards.
	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 6, "01A"); err != nil {
		t.Fatalf("higher seq, lower ID: %v", err)
	}
	got = userChannelRow(t, db, "u-1", "ch-rp")
	if got.LastReadSeq != 6 || got.LastReadMsgID != "01B" || got.UnreadNotifyCount != 0 {
		t.Fatalf("after higher-seq/lower-ID = (%d, %q, notify %d), want (6, 01B, 0)", got.LastReadSeq, got.LastReadMsgID, got.UnreadNotifyCount)
	}
	// Same seq, newer ID → the tiebreak moves the watermark forward.
	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 6, "01C"); err != nil {
		t.Fatalf("same seq, newer ID: %v", err)
	}
	// An empty msgID moves only the seq and keeps the stored watermark; an
	// empty-msgID write behind the stored seq is stale.
	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 7, ""); err != nil {
		t.Fatalf("seq-only advance: %v", err)
	}
	if err := ms.SetChannelLastRead(ctx, "ch-rp", "u-1", 4, ""); !errors.Is(err, ErrStaleReadPoint) {
		t.Fatalf("stale seq-only: want ErrStaleReadPoint, got %v", err)
	}
	got = userChannelRow(t, db, "u-1", "ch-rp")
	if got.LastReadSeq != 7 || got.LastReadMsgID != "01C" {
		t.Fatalf("after seq-only advance = (%d, %q), want (7, 01C)", got.LastReadSeq, got.LastReadMsgID)
	}
}

func TestSetConversationLastRead_ForwardOnly(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	conv := &model.Conversation{ID: "conv-rp", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-a", "u-b"}, CreatedAt: time.Now()}
	members := []*model.UserConversation{
		{UserID: "u-a", ConversationID: "conv-rp", JoinedAt: time.Now()},
		{UserID: "u-b", ConversationID: "conv-rp", JoinedAt: time.Now()},
	}
	if err := cs.CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := cs.SetConversationLastRead(ctx, "conv-rp", "u-b", 4, "01D"); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if err := cs.SetConversationLastRead(ctx, "conv-rp", "u-b", 2, "01E"); !errors.Is(err, ErrStaleReadPoint) {
		t.Fatalf("stale write: want ErrStaleReadPoint, got %v", err)
	}
	convs, err := cs.ListUserConversations(ctx, "u-b")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(convs) != 1 || convs[0].LastReadSeq != 4 || convs[0].LastReadMsgID != "01D" {
		t.Fatalf("read point = %+v, want (4, 01D)", convs)
	}
}

// A condition failure is disambiguated by a GetItem: a missing row is
// ErrNotFound, a failing lookup surfaces as an error, and a raw UpdateItem
// failure is wrapped.
func TestSetReadPoint_ErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	seedNotifyMembership(t, db, "ch-rpe", "u-1")
	if err := NewMembershipStore(db).SetChannelLastRead(ctx, "ch-rpe", "u-1", 5, "01B"); err != nil {
		t.Fatalf("seed read point: %v", err)
	}

	if err := NewMembershipStore(db).SetChannelLastRead(ctx, "ch-rpe", "u-none", 1, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-member: want ErrNotFound, got %v", err)
	}
	faultyGet := NewMembershipStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	if err := faultyGet.SetChannelLastRead(ctx, "ch-rpe", "u-1", 1, ""); !errors.Is(err, errInjected) {
		t.Fatalf("stale write + GetItem failure: want errInjected, got %v", err)
	}
	faultyUpdate := NewMembershipStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := faultyUpdate.SetChannelLastRead(ctx, "ch-rpe", "u-1", 9, ""); !errors.Is(err, errInjected) {
		t.Fatalf("UpdateItem failure: want errInjected, got %v", err)
	}
}
