//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func seedSidebarChannel(t *testing.T, db *DB, userID, channelID string) {
	t.Helper()
	cs := NewChannelStore(db)
	ms := NewMembershipStore(db)
	ctx := context.Background()
	ch := makeChannel(channelID, channelID, channelID+"-slug", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}
	now := time.Now().Truncate(time.Millisecond)
	member := &model.ChannelMembership{ChannelID: channelID, UserID: userID, Role: model.ChannelRoleMember, JoinedAt: now}
	userChan := &model.UserChannel{UserID: userID, ChannelID: channelID, Role: model.ChannelRoleMember, JoinedAt: now}
	if err := ms.AddChannelMember(ctx, ch, member, userChan); err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}
}

func seedSidebarConversation(t *testing.T, db *DB, userID, convID string) {
	t.Helper()
	cs := NewConversationStore(db)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)
	conv := &model.Conversation{ID: convID, Type: model.ConversationTypeDM, ParticipantIDs: []string{userID, "u-other"}, CreatedAt: now}
	members := []*model.UserConversation{
		{UserID: userID, ConversationID: convID, Type: model.ConversationTypeDM},
		{UserID: "u-other", ConversationID: convID, Type: model.ConversationTypeDM},
	}
	if err := cs.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create conversation: %v", err)
	}
}

func TestSidebarOrderStore_ApplyOrderMixedRows(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSidebarOrderStore(db)
	ms := NewMembershipStore(db)
	cs := NewConversationStore(db)
	ctx := context.Background()

	seedSidebarChannel(t, db, "u-ord", "ch-ord-1")
	seedSidebarConversation(t, db, "u-ord", "cv-ord-1")

	cat := "cat-ord"
	fav := true
	err := s.ApplyOrder(ctx, "u-ord", []SidebarRowUpdate{
		{ItemType: SidebarItemChannel, ItemID: "ch-ord-1", Position: 1024, CategoryID: &cat},
		{ItemType: SidebarItemConversation, ItemID: "cv-ord-1", Position: 2048, Favorite: &fav},
	})
	if err != nil {
		t.Fatalf("ApplyOrder: %v", err)
	}

	chans, err := ms.ListUserChannels(ctx, "u-ord")
	if err != nil || len(chans) != 1 {
		t.Fatalf("ListUserChannels = %v, err=%v", chans, err)
	}
	if chans[0].SidebarPosition != 1024 || chans[0].CategoryID != "cat-ord" {
		t.Fatalf("channel row = %+v, want position 1024 + category", chans[0])
	}
	convs, err := cs.ListUserConversations(ctx, "u-ord")
	if err != nil || len(convs) != 1 {
		t.Fatalf("ListUserConversations = %v, err=%v", convs, err)
	}
	if convs[0].SidebarPosition != 2048 || !convs[0].Favorite {
		t.Fatalf("conversation row = %+v, want position 2048 + favorite", convs[0])
	}

	// Position-only update leaves the other attributes untouched.
	if err := s.ApplyOrder(ctx, "u-ord", []SidebarRowUpdate{
		{ItemType: SidebarItemChannel, ItemID: "ch-ord-1", Position: 512},
	}); err != nil {
		t.Fatalf("ApplyOrder reposition: %v", err)
	}
	chans, _ = ms.ListUserChannels(ctx, "u-ord")
	if chans[0].SidebarPosition != 512 || chans[0].CategoryID != "cat-ord" {
		t.Fatalf("channel row after reposition = %+v", chans[0])
	}
}

func TestSidebarOrderStore_MissingRowFailsWholeBatch(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSidebarOrderStore(db)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	seedSidebarChannel(t, db, "u-atomic", "ch-atomic")

	// One real row + one the user was never a member of: the transaction
	// refuses BOTH — no orphan rows, no partial reorder.
	err := s.ApplyOrder(ctx, "u-atomic", []SidebarRowUpdate{
		{ItemType: SidebarItemChannel, ItemID: "ch-atomic", Position: 4096},
		{ItemType: SidebarItemChannel, ItemID: "ch-never-joined", Position: 8192},
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	chans, _ := ms.ListUserChannels(ctx, "u-atomic")
	if len(chans) != 1 || chans[0].SidebarPosition == 4096 {
		t.Fatalf("partial write leaked: %+v", chans)
	}
}

func TestSidebarOrderStore_ClientError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSidebarOrderStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.ApplyOrder(context.Background(), "u-err", []SidebarRowUpdate{
		{ItemType: SidebarItemChannel, ItemID: "ch-x", Position: 1},
	})
	if err == nil {
		t.Fatal("expected injected transact error")
	}
}

func TestCategoryStore_SetPositions(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	for _, c := range []*model.UserChannelCategory{
		{UserID: "u-cat", ID: "cat-1", Name: "One", Position: 1, CreatedAt: time.Now()},
		{UserID: "u-cat", ID: "cat-2", Name: "Two", Position: 2, CreatedAt: time.Now()},
	} {
		if err := s.Create(ctx, c); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	// Empty input is a no-op, not an error (a drop that changed nothing).
	if err := s.SetPositions(ctx, "u-cat", nil); err != nil {
		t.Fatalf("empty SetPositions: %v", err)
	}

	if err := s.SetPositions(ctx, "u-cat", map[string]int{"cat-1": 2048, "cat-2": 1024}); err != nil {
		t.Fatalf("SetPositions: %v", err)
	}
	cats, err := s.List(ctx, "u-cat")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := map[string]int{}
	for _, c := range cats {
		got[c.ID] = c.Position
	}
	if got["cat-1"] != 2048 || got["cat-2"] != 1024 {
		t.Fatalf("positions = %v", got)
	}

	// A category the user does not own fails the whole transaction.
	if err := s.SetPositions(ctx, "u-cat", map[string]int{"cat-1": 1, "cat-ghost": 2}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ghost err = %v, want ErrNotFound", err)
	}
	cats, _ = s.List(ctx, "u-cat")
	for _, c := range cats {
		if c.ID == "cat-1" && c.Position == 1 {
			t.Fatal("partial category write leaked")
		}
	}

	// Beyond the transact limit is refused loudly, not silently truncated.
	big := map[string]int{}
	for i := 0; i < dynamoTransactLimit+1; i++ {
		big[NewID()] = i
	}
	if err := s.SetPositions(ctx, "u-cat", big); err == nil {
		t.Fatal("expected too-many-categories error")
	}

	faulty := NewCategoryStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	if err := faulty.SetPositions(ctx, "u-cat", map[string]int{"cat-1": 5}); err == nil {
		t.Fatal("expected injected transact error")
	}
}
