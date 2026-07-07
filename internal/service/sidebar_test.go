package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type mockSidebarOrderStore struct {
	applied [][]store.SidebarRowUpdate
	err     error
}

func (m *mockSidebarOrderStore) ApplyOrder(_ context.Context, _ string, updates []store.SidebarRowUpdate) error {
	if m.err != nil {
		return m.err
	}
	m.applied = append(m.applied, updates)
	return nil
}

func newSidebarTestService() (*SidebarService, *mockMembershipStore, *mockConversationStore, *stubCategoryStore, *mockSidebarOrderStore, *mockPublisher) {
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	categories := newStubCategoryStore()
	order := &mockSidebarOrderStore{}
	publisher := newMockPublisher()
	svc := NewSidebarService(memberships, conversations, categories, order, publisher)
	return svc, memberships, conversations, categories, order, publisher
}

func uch(id, name string, pos int, favorite bool, categoryID string) *model.UserChannel {
	return &model.UserChannel{UserID: "u1", ChannelID: id, ChannelName: name, SidebarPosition: pos, Favorite: favorite, CategoryID: categoryID}
}

func ucv(id string, pos int, favorite bool, categoryID string) *model.UserConversation {
	return &model.UserConversation{UserID: "u1", ConversationID: id, SidebarPosition: pos, Favorite: favorite, CategoryID: categoryID}
}

func channelMove(itemID, section, categoryID, afterType, afterID string) SidebarMove {
	return SidebarMove{ItemType: store.SidebarItemChannel, ItemID: itemID, Section: section, CategoryID: categoryID, AfterType: afterType, AfterID: afterID}
}

func TestSidebarMove_MidpointBetweenNeighbors(t *testing.T) {
	svc, memberships, _, _, order, publisher := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{
		uch("ch-a", "alpha", 1024, false, ""),
		uch("ch-b", "beta", 2048, false, ""),
		uch("ch-c", "gamma", 3072, false, ""),
	}

	// Drop ch-c right after ch-a: the gap (1024..2048) has room — ONE write.
	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-c", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-a"))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if len(updates) != 1 || updates[0].ItemID != "ch-c" || updates[0].Position != 1024+512 {
		t.Fatalf("updates = %+v, want single midpoint write for ch-c at 1536", updates)
	}
	if updates[0].Favorite == nil || *updates[0].Favorite || updates[0].CategoryID == nil || *updates[0].CategoryID != "" {
		t.Fatalf("moved row must carry the section attrs, got %+v", updates[0])
	}
	if len(order.applied) != 1 {
		t.Fatalf("ApplyOrder calls = %d, want 1", len(order.applied))
	}
	// The reorder announces itself so other devices refetch.
	if len(publisher.published) != 1 || publisher.published[0].event.Type != events.EventSidebarUpdated {
		t.Fatalf("published = %+v, want one sidebar.updated", publisher.published)
	}
}

func TestSidebarMove_TopAndEndPlacement(t *testing.T) {
	svc, memberships, _, _, _, _ := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{
		uch("ch-a", "alpha", 1024, false, ""),
		uch("ch-b", "beta", 2048, false, ""),
		uch("ch-c", "gamma", 3072, false, ""),
	}

	// Empty anchor = the very top: midpoint between the sentinel 0 and 1024.
	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-c", SidebarSectionChannels, "", "", ""))
	if err != nil {
		t.Fatalf("Move top: %v", err)
	}
	if len(updates) != 1 || updates[0].Position != 512 {
		t.Fatalf("top insert = %+v, want position 512", updates)
	}

	// Anchor = last item: append past the tail.
	updates, err = svc.Move(context.Background(), "u1", channelMove("ch-a", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-c"))
	if err != nil {
		t.Fatalf("Move end: %v", err)
	}
	if len(updates) != 1 || updates[0].Position != 3072+sidebarPositionStep {
		t.Fatalf("end insert = %+v, want position %d", updates, 3072+sidebarPositionStep)
	}
}

func TestSidebarMove_RebalancesWhenGapExhausted(t *testing.T) {
	svc, memberships, _, _, _, _ := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{
		uch("ch-a", "alpha", 10, false, ""),
		uch("ch-b", "beta", 11, false, ""), // adjacent to ch-a: no gap
		uch("ch-c", "gamma", 12, false, ""),
	}

	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-c", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-a"))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	// Dense renumber: a=1024, c=2048, b=3072 — every row changed.
	want := map[string]int{"ch-a": 1024, "ch-c": 2048, "ch-b": 3072}
	if len(updates) != len(want) {
		t.Fatalf("updates = %+v, want full renumber", updates)
	}
	for _, u := range updates {
		if want[u.ItemID] != u.Position {
			t.Fatalf("row %s at %d, want %d", u.ItemID, u.Position, want[u.ItemID])
		}
	}
}

func TestSidebarMove_RebalanceSkipsRowsAlreadyInSlot(t *testing.T) {
	svc, memberships, _, _, _, _ := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{
		uch("ch-a", "alpha", 1024, false, ""), // already at its dense slot
		uch("ch-b", "beta", 0, false, ""),     // legacy unset → forces the renumber
		uch("ch-z", "omega", 2048, false, ""),
	}

	// Insert ch-z after ch-a; ch-b's unset position forces the dense path.
	// (Canonical order: positioned a,z first, unset b last → a, z, b.)
	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-z", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-a"))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	// a keeps 1024 (skipped), z takes 2048 (its own dense slot — but it is the
	// moved row, so it is always written), b gets 3072.
	byID := map[string]int{}
	for _, u := range updates {
		byID[u.ItemID] = u.Position
	}
	if _, ok := byID["ch-a"]; ok {
		t.Fatalf("ch-a already sits at its dense slot and must be skipped, got %+v", updates)
	}
	if byID["ch-z"] != 2048 || byID["ch-b"] != 3072 {
		t.Fatalf("updates = %+v, want z=2048 b=3072", updates)
	}
}

func TestSidebarMove_FavoritesMixesChannelsAndConversations(t *testing.T) {
	svc, memberships, conversations, _, _, _ := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{
		uch("ch-f", "fav-chan", 1024, true, "keep-cat"),
		uch("ch-x", "not-fav", 0, false, ""),
	}
	conversations.userConvs["u1"] = []*model.UserConversation{
		ucv("cv-f", 2048, true, ""),
	}

	// Move the conversation after the favorited channel, inside Favorites.
	mv := SidebarMove{ItemType: store.SidebarItemConversation, ItemID: "cv-f", Section: SidebarSectionFavorites, AfterType: store.SidebarItemChannel, AfterID: "ch-f"}
	updates, err := svc.Move(context.Background(), "u1", mv)
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if len(updates) != 1 || updates[0].ItemType != store.SidebarItemConversation || updates[0].Position != 1024+sidebarPositionStep {
		t.Fatalf("updates = %+v", updates)
	}
	// Favorites keeps the category assignment: only the favorite flag rides.
	if updates[0].CategoryID != nil || updates[0].Favorite == nil || !*updates[0].Favorite {
		t.Fatalf("favorites move must set favorite and leave category untouched, got %+v", updates[0])
	}
}

func TestSidebarMove_IntoCategorySetsAttrs(t *testing.T) {
	svc, memberships, _, categories, _, _ := newSidebarTestService()
	categories.rows["u1#cat-1"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-1", Name: "Work", Position: 1}
	memberships.userChannels = []*model.UserChannel{
		uch("ch-a", "alpha", 1024, false, "cat-1"),
		uch("ch-new", "newbie", 0, true, ""), // favorited elsewhere, dragged in
	}

	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-new", SidebarSectionCategory, "cat-1", store.SidebarItemChannel, "ch-a"))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	var moved *store.SidebarRowUpdate
	for i := range updates {
		if updates[i].ItemID == "ch-new" {
			moved = &updates[i]
		}
	}
	if moved == nil || moved.CategoryID == nil || *moved.CategoryID != "cat-1" || moved.Favorite == nil || *moved.Favorite {
		t.Fatalf("moved row must adopt the category and drop favorite, got %+v", updates)
	}
}

func TestSidebarMove_DeletedCategoryRowsFallThroughToDefault(t *testing.T) {
	svc, memberships, _, _, _, _ := newSidebarTestService()
	// ch-ghost points at a category that no longer exists → it belongs to the
	// default channels section, so it can anchor a move there.
	memberships.userChannels = []*model.UserChannel{
		uch("ch-ghost", "ghost", 1024, false, "deleted-cat"),
		uch("ch-a", "alpha", 2048, false, ""),
	}

	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-a", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-ghost"))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if len(updates) != 1 || updates[0].Position != 1024+sidebarPositionStep {
		t.Fatalf("updates = %+v", updates)
	}
}

func TestSidebarMove_StaleAnchorConflicts(t *testing.T) {
	svc, memberships, _, _, _, publisher := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{
		uch("ch-a", "alpha", 1024, false, ""),
		uch("ch-gone", "gone", 2048, false, "elsewhere-not-known"), // NOT in the default section? it is (unknown cat falls through)…
		uch("ch-fav", "fav", 3072, true, ""),                       // …but a favorite is not.
	}

	// Anchoring on a row that lives in ANOTHER section (a favorite) means the
	// client's layout was stale: conflict, nothing written, nothing published.
	_, err := svc.Move(context.Background(), "u1", channelMove("ch-a", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-fav"))
	if !errors.Is(err, ErrSidebarConflict) {
		t.Fatalf("err = %v, want ErrSidebarConflict", err)
	}
	if len(publisher.published) != 0 {
		t.Fatal("a refused move must not publish")
	}
}

func TestSidebarMove_ValidationAndLookupErrors(t *testing.T) {
	svc, memberships, conversations, categories, order, _ := newSidebarTestService()
	memberships.userChannels = []*model.UserChannel{uch("ch-a", "alpha", 1024, false, "")}
	ctx := context.Background()

	cases := []struct {
		name string
		mv   SidebarMove
		want error
	}{
		{"unknown item type", SidebarMove{ItemType: "bogus", ItemID: "x", Section: SidebarSectionFavorites}, ErrSidebarInvalid},
		{"missing item id", channelMove("", SidebarSectionFavorites, "", "", ""), ErrSidebarInvalid},
		{"conversation into channels section", SidebarMove{ItemType: store.SidebarItemConversation, ItemID: "cv", Section: SidebarSectionChannels}, ErrSidebarInvalid},
		{"unknown section", channelMove("ch-a", "bogus", "", "", ""), ErrSidebarInvalid},
		{"category without id", channelMove("ch-a", SidebarSectionCategory, "", "", ""), ErrSidebarInvalid},
		{"anchor id without type", SidebarMove{ItemType: store.SidebarItemChannel, ItemID: "ch-a", Section: SidebarSectionChannels, AfterID: "ch-b"}, ErrSidebarInvalid},
		{"unknown anchor type", SidebarMove{ItemType: store.SidebarItemChannel, ItemID: "ch-a", Section: SidebarSectionChannels, AfterType: "bogus", AfterID: "ch-b"}, ErrSidebarInvalid},
		{"unknown category", channelMove("ch-a", SidebarSectionCategory, "nope", "", ""), ErrSidebarInvalid},
		{"item not found", channelMove("ch-missing", SidebarSectionChannels, "", "", ""), store.ErrNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.Move(ctx, "u1", tc.mv); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}

	memberships.listChannelsErr = errors.New("dynamo down")
	if _, err := svc.Move(ctx, "u1", channelMove("ch-a", SidebarSectionChannels, "", "", "")); err == nil {
		t.Fatal("expected channel list error")
	}
	memberships.listChannelsErr = nil

	conversations.listErr = errors.New("dynamo down")
	if _, err := svc.Move(ctx, "u1", channelMove("ch-a", SidebarSectionChannels, "", "", "")); err == nil {
		t.Fatal("expected conversation list error")
	}
	conversations.listErr = nil

	categories.listErr = errors.New("dynamo down")
	if _, err := svc.Move(ctx, "u1", channelMove("ch-a", SidebarSectionChannels, "", "", "")); err == nil {
		t.Fatal("expected category list error")
	}
	categories.listErr = nil

	order.err = errors.New("transact failed")
	if _, err := svc.Move(ctx, "u1", channelMove("ch-a", SidebarSectionChannels, "", "", "")); err == nil {
		t.Fatal("expected apply error")
	}
}

func TestSidebarMove_CanonicalOrderTiebreaks(t *testing.T) {
	svc, memberships, _, _, _, _ := newSidebarTestService()
	// Equal positions fall back to name, then ID — the same order the client
	// renders, so the anchor slot matches what the user saw.
	memberships.userChannels = []*model.UserChannel{
		uch("ch-2", "Bravo", 1024, false, ""),
		uch("ch-1", "alpha", 1024, false, ""),
		uch("ch-4", "same", 0, false, ""),
		uch("ch-3", "same", 0, false, ""),
		uch("ch-m", "mover", 4096, false, ""),
	}

	// After "Bravo" (which sorts after "alpha" case-insensitively): the gap to
	// the unset block has no next position → rebalance orders a,B,m,same(3),same(4).
	updates, err := svc.Move(context.Background(), "u1", channelMove("ch-m", SidebarSectionChannels, "", store.SidebarItemChannel, "ch-2"))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	byID := map[string]int{}
	for _, u := range updates {
		byID[u.ItemID] = u.Position
	}
	if byID["ch-m"] != 3*sidebarPositionStep {
		t.Fatalf("mover position = %d, want %d (slot 3 of a,B,m,…)", byID["ch-m"], 3*sidebarPositionStep)
	}
	if byID["ch-3"] != 4*sidebarPositionStep || byID["ch-4"] != 5*sidebarPositionStep {
		t.Fatalf("unset rows must land after positioned ones, ID-tiebroken: %+v", byID)
	}
}
