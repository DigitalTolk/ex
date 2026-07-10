package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// Sidebar section kinds a move can target. The default DM section is absent
// on purpose: it is recency/alphabetically sorted, never position-ordered.
const (
	SidebarSectionFavorites = "favorites"
	SidebarSectionCategory  = "category"
	SidebarSectionChannels  = "channels"
)

// sidebarPositionStep is the gap between dense position slots. Midpoint
// inserts consume the gap; when it runs out the whole section is renumbered.
const sidebarPositionStep = 1024

// ErrSidebarConflict reports a move whose anchor no longer exists where the
// client saw it — the sidebar changed under them (another device moved or
// removed rows). Nothing was written; the client refetches the truth and the
// user drops again against current state.
var ErrSidebarConflict = errors.New("sidebar: layout changed since it was read")

// ErrSidebarInvalid marks a malformed move request (unknown section/type,
// missing fields). Handlers map it to 400.
var ErrSidebarInvalid = errors.New("invalid sidebar move")

// SidebarMove is the EVENT a client reports: "I dropped item X into section S
// right after item A" (empty anchor = at the top). The server decides what
// that means for stored positions — clients never compute or send position
// numbers.
type SidebarMove struct {
	ItemType string // store.SidebarItemChannel | store.SidebarItemConversation
	ItemID   string
	Section  string // SidebarSectionFavorites | SidebarSectionCategory | SidebarSectionChannels
	// CategoryID qualifies Section == SidebarSectionCategory.
	CategoryID string
	// AfterType/AfterID anchor the drop: the item the moved row lands
	// directly after, in the section's canonical order. Empty = first.
	AfterType string
	AfterID   string
}

// SidebarOrderStore applies server-computed ordering writes.
type SidebarOrderStore interface {
	ApplyOrder(ctx context.Context, userID string, updates []store.SidebarRowUpdate) error
}

// SidebarService owns sidebar ordering: it resolves client move events into
// canonical positions and persists them atomically.
type SidebarService struct {
	memberships   MembershipStore
	conversations ConversationStore
	categories    CategoryStore
	order         SidebarOrderStore
	publisher     Publisher
}

// NewSidebarService creates a SidebarService.
func NewSidebarService(memberships MembershipStore, conversations ConversationStore, categories CategoryStore, order SidebarOrderStore, publisher Publisher) *SidebarService {
	return &SidebarService{
		memberships:   memberships,
		conversations: conversations,
		categories:    categories,
		order:         order,
		publisher:     publisher,
	}
}

// sidebarRow is the section-agnostic view of a user-side row the ordering
// algorithm works on.
type sidebarRow struct {
	itemType string
	itemID   string
	position int
	favorite bool
	category string
	label    string // channel name; empty for conversations (names are client-derived)
}

// Move applies a client's drop event. It loads the target section in its
// canonical order, inserts the moved item after the anchor, computes the
// position server-side (midpoint into the gap, or a dense renumber of the
// whole section when the gap is exhausted or legacy unset positions are
// involved), and persists the result transactionally. Returns the applied
// row updates so the acting client can patch its cache with the exact truth.
func (s *SidebarService) Move(ctx context.Context, userID string, mv SidebarMove) ([]store.SidebarRowUpdate, error) {
	if err := validateSidebarMove(mv); err != nil {
		return nil, err
	}

	channels, err := s.memberships.ListUserChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("sidebar: list channels: %w", err)
	}
	convs, err := s.conversations.ListUserConversations(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("sidebar: list conversations: %w", err)
	}
	cats, err := s.categories.List(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("sidebar: list categories: %w", err)
	}
	known := make(map[string]bool, len(cats))
	for _, c := range cats {
		known[c.ID] = true
	}
	if mv.Section == SidebarSectionCategory && !known[mv.CategoryID] {
		return nil, fmt.Errorf("%w: unknown category", ErrSidebarInvalid)
	}

	rows := collectSidebarRows(channels, convs)
	if _, ok := findSidebarRow(rows, mv.ItemType, mv.ItemID); !ok {
		return nil, store.ErrNotFound
	}

	// The target section in canonical order, without the moved row.
	section := make([]sidebarRow, 0, len(rows))
	for _, r := range rows {
		if r.itemType == mv.ItemType && r.itemID == mv.ItemID {
			continue
		}
		if rowInSection(r, mv, known) {
			section = append(section, r)
		}
	}
	sortSidebarRows(section)

	insertAt := 0
	if mv.AfterID != "" {
		idx := -1
		for i, r := range section {
			if r.itemType == mv.AfterType && r.itemID == mv.AfterID {
				idx = i
				break
			}
		}
		if idx < 0 {
			// The anchor is not (or no longer) in the target section: the
			// client acted on a stale layout. Refuse rather than guess.
			return nil, ErrSidebarConflict
		}
		insertAt = idx + 1
	}

	// The moved row's section attributes. Favorites keeps the category
	// assignment (leaving Favorites returns the item to it); the other
	// sections own it.
	movedUpdate := store.SidebarRowUpdate{ItemType: mv.ItemType, ItemID: mv.ItemID}
	switch mv.Section {
	case SidebarSectionFavorites:
		movedUpdate.Favorite = boolPtr(true)
	case SidebarSectionCategory:
		movedUpdate.Favorite = boolPtr(false)
		movedUpdate.CategoryID = strPtr(mv.CategoryID)
	case SidebarSectionChannels:
		movedUpdate.Favorite = boolPtr(false)
		movedUpdate.CategoryID = strPtr("")
	}

	updates := planSidebarPositions(section, insertAt, movedUpdate)
	if err := s.order.ApplyOrder(ctx, userID, updates); err != nil {
		return nil, fmt.Errorf("sidebar: apply order: %w", err)
	}

	// One event, both directions: other devices refetch their lists; the
	// acting client suppresses its own echo and patches from the response.
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventSidebarUpdated, map[string]any{
		"userID": userID,
	})
	return updates, nil
}

func validateSidebarMove(mv SidebarMove) error {
	if mv.ItemType != store.SidebarItemChannel && mv.ItemType != store.SidebarItemConversation {
		return fmt.Errorf("%w: unknown item type", ErrSidebarInvalid)
	}
	if strings.TrimSpace(mv.ItemID) == "" {
		return fmt.Errorf("%w: item required", ErrSidebarInvalid)
	}
	switch mv.Section {
	case SidebarSectionFavorites, SidebarSectionCategory:
	case SidebarSectionChannels:
		if mv.ItemType != store.SidebarItemChannel {
			return fmt.Errorf("%w: only channels can join the default channels section", ErrSidebarInvalid)
		}
	default:
		return fmt.Errorf("%w: unknown section", ErrSidebarInvalid)
	}
	if mv.Section == SidebarSectionCategory && strings.TrimSpace(mv.CategoryID) == "" {
		return fmt.Errorf("%w: category required", ErrSidebarInvalid)
	}
	if (mv.AfterID == "") != (mv.AfterType == "") {
		return fmt.Errorf("%w: anchor requires both type and id", ErrSidebarInvalid)
	}
	if mv.AfterID != "" && mv.AfterType != store.SidebarItemChannel && mv.AfterType != store.SidebarItemConversation {
		return fmt.Errorf("%w: unknown anchor type", ErrSidebarInvalid)
	}
	return nil
}

func collectSidebarRows(channels []*model.UserChannel, convs []*model.UserConversation) []sidebarRow {
	rows := make([]sidebarRow, 0, len(channels)+len(convs))
	for _, c := range channels {
		rows = append(rows, sidebarRow{
			itemType: store.SidebarItemChannel,
			itemID:   c.ChannelID,
			position: c.SidebarPosition,
			favorite: c.Favorite,
			category: c.CategoryID,
			label:    c.ChannelName,
		})
	}
	for _, c := range convs {
		rows = append(rows, sidebarRow{
			itemType: store.SidebarItemConversation,
			itemID:   c.ConversationID,
			position: c.SidebarPosition,
			favorite: c.Favorite,
			category: c.CategoryID,
		})
	}
	return rows
}

func findSidebarRow(rows []sidebarRow, itemType, itemID string) (sidebarRow, bool) {
	for _, r := range rows {
		if r.itemType == itemType && r.itemID == itemID {
			return r, true
		}
	}
	return sidebarRow{}, false
}

// rowInSection reports whether a row belongs to the move's target section.
// Rows pointing at a deleted category fall through to the default sections,
// mirroring the client's grouping rules.
func rowInSection(r sidebarRow, mv SidebarMove, knownCategories map[string]bool) bool {
	switch mv.Section {
	case SidebarSectionFavorites:
		return r.favorite
	case SidebarSectionCategory:
		return !r.favorite && r.category == mv.CategoryID
	default: // SidebarSectionChannels
		return r.itemType == store.SidebarItemChannel && !r.favorite &&
			(r.category == "" || !knownCategories[r.category])
	}
}

// sortSidebarRows orders a section canonically: positioned rows ascending,
// legacy unset (0) rows after them. Ties break on the channel name (matching
// the client's label tiebreak) and finally the ID for stability — conversation
// display names are derived client-side, so never-positioned mixed rows may
// order slightly differently until their first move densifies the section.
func sortSidebarRows(rows []sidebarRow) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		aSet, bSet := a.position != 0, b.position != 0
		if aSet != bSet {
			return aSet
		}
		if aSet && a.position != b.position {
			return a.position < b.position
		}
		al, bl := strings.ToLower(a.label), strings.ToLower(b.label)
		if al != bl {
			return al < bl
		}
		return a.itemID < b.itemID
	})
}

// planSidebarPositions decides the writes for inserting the moved row at
// insertAt within the section (which no longer contains it). The common case
// slots into the gap between neighbors — one write. When the gap is exhausted
// or a neighbor still has a legacy unset position, the whole section is
// renumbered densely instead, writing only the rows whose position changes.
func planSidebarPositions(section []sidebarRow, insertAt int, moved store.SidebarRowUpdate) []store.SidebarRowUpdate {
	prev := 0 // sentinel: no lower bound
	if insertAt > 0 {
		prev = section[insertAt-1].position
	}
	next := 0 // sentinel: no upper bound
	hasNext := insertAt < len(section)
	if hasNext {
		next = section[insertAt].position
	}

	// A neighbor with an unset (0) position, or an exhausted gap, forces the
	// dense renumber. (prev == 0 at the very top is the no-lower-bound
	// sentinel, not an unset neighbor.)
	prevUnset := insertAt > 0 && prev == 0
	nextUnset := hasNext && next == 0
	switch {
	case !prevUnset && !nextUnset && !hasNext:
		moved.Position = prev + sidebarPositionStep
		return []store.SidebarRowUpdate{moved}
	case !prevUnset && !nextUnset && next-prev >= 2:
		moved.Position = prev + (next-prev)/2
		return []store.SidebarRowUpdate{moved}
	}

	// Dense renumber: the final order with the moved row in place, each slot
	// (i+1)*step. Neighbors that already sit at their dense slot are skipped.
	final := make([]sidebarRow, 0, len(section)+1)
	final = append(final, section[:insertAt]...)
	final = append(final, sidebarRow{itemType: moved.ItemType, itemID: moved.ItemID})
	final = append(final, section[insertAt:]...)

	updates := make([]store.SidebarRowUpdate, 0, len(final))
	for i, r := range final {
		pos := (i + 1) * sidebarPositionStep
		if r.itemType == moved.ItemType && r.itemID == moved.ItemID {
			moved.Position = pos
			updates = append(updates, moved)
			continue
		}
		if r.position == pos {
			continue
		}
		updates = append(updates, store.SidebarRowUpdate{ItemType: r.itemType, ItemID: r.itemID, Position: pos})
	}
	return updates
}

func boolPtr(b bool) *bool    { return &b }
func strPtr(s string) *string { return &s }
