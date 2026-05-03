package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// publishConversationNew is a small wrapper so the activation pathway is the
// single place that broadcasts conversation.new events.
func publishConversationNew(ctx context.Context, p Publisher, channels []string, payload map[string]any) {
	events.PublishMany(ctx, p, channels, events.EventConversationNew, payload)
}

// ConversationService manages direct messages and group conversations.
type ConversationService struct {
	conversations ConversationStore
	users         UserStore
	cache         Cache
	broker        Broker
	publisher     Publisher
}

// NewConversationService creates a ConversationService with the given dependencies.
func NewConversationService(conversations ConversationStore, users UserStore, cache Cache, broker Broker, publisher Publisher) *ConversationService {
	return &ConversationService{
		conversations: conversations,
		users:         users,
		cache:         cache,
		broker:        broker,
		publisher:     publisher,
	}
}

// GetOrCreateDM returns the existing DM conversation between two users, or
// creates one using a deterministic ID derived from the sorted user IDs.
// Self-DMs (userA == userB) are allowed — they act as a personal notepad.
func (s *ConversationService) GetOrCreateDM(ctx context.Context, userA, userB string) (*model.Conversation, error) {
	id := dmConversationID(userA, userB)

	conv, err := s.conversations.GetConversation(ctx, id)
	if err == nil {
		return conv, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("conversation: get dm: %w", err)
	}

	uA, err := s.users.GetUser(ctx, userA)
	if err != nil {
		return nil, fmt.Errorf("conversation: get user A: %w", err)
	}
	uB, err := s.users.GetUser(ctx, userB)
	if err != nil {
		return nil, fmt.Errorf("conversation: get user B: %w", err)
	}

	now := time.Now()
	participants := []string{userA, userB}
	if userA == userB {
		participants = []string{userA}
	}
	conv = &model.Conversation{
		ID:             id,
		Type:           model.ConversationTypeDM,
		ParticipantIDs: participants,
		CreatedBy:      userA,
		Activated:      false,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	displayForA := uB.DisplayName
	if userA == userB {
		displayForA = uA.DisplayName
	}
	userConvs := []*model.UserConversation{
		{
			UserID:         userA,
			ConversationID: id,
			Type:           model.ConversationTypeDM,
			DisplayName:    displayForA,
			ParticipantIDs: participants,
			CreatedBy:      userA,
			Activated:      false,
			JoinedAt:       now,
			UpdatedAt:      now,
		},
	}
	if userA != userB {
		userConvs = append(userConvs, &model.UserConversation{
			UserID:         userB,
			ConversationID: id,
			Type:           model.ConversationTypeDM,
			DisplayName:    uA.DisplayName,
			ParticipantIDs: participants,
			CreatedBy:      userA,
			Activated:      false,
			JoinedAt:       now,
			UpdatedAt:      now,
		})
	}

	if err := s.conversations.CreateConversation(ctx, conv, userConvs); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return s.conversations.GetConversation(ctx, id)
		}
		return nil, fmt.Errorf("conversation: create dm: %w", err)
	}

	if s.broker != nil {
		s.broker.Subscribe(userA, pubsub.ConversationName(id))
		if userA != userB {
			s.broker.Subscribe(userB, pubsub.ConversationName(id))
		}
	}

	// NOTE: EventConversationNew is intentionally NOT published here. It is
	// emitted by MessageService.Send on the first message so non-creator
	// participants only see the conversation appear in their sidebar after
	// activity exists.

	return conv, nil
}

// normalizeParticipantSet dedupes the supplied participant IDs (dropping
// empties), guarantees the creator appears in the result, and preserves
// caller-supplied order with the creator appended last when they weren't
// already in the input. Shared by CreateGroup and GetOrCreateGroup so
// both paths agree on the canonical set.
func normalizeParticipantSet(creatorID string, ids []string) []string {
	seen := make(map[string]bool, len(ids)+1)
	out := make([]string, 0, len(ids)+1)
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if !seen[creatorID] {
		out = append(out, creatorID)
	}
	return out
}

// GetOrCreateGroup returns an existing group whose participant set is the
// same constellation (creator + the supplied others), or creates a new
// one if none matches. Re-messaging the same set of people forwards
// into the prior group instead of spawning duplicates. Group name is
// ignored when matching — constellation is the identity.
//
// The lookup is a single GetItem keyed by a deterministic group ID
// derived from the sorted participant set (groupConversationID), so
// the cost is constant regardless of how many groups the creator is in.
func (s *ConversationService) GetOrCreateGroup(ctx context.Context, creatorID string, participantIDs []string, name string) (*model.Conversation, error) {
	canonical := normalizeParticipantSet(creatorID, participantIDs)
	id := groupConversationID(canonical)

	if conv, err := s.conversations.GetConversation(ctx, id); err == nil && conv != nil {
		return conv, nil
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("conversation: get group: %w", err)
	}

	return s.CreateGroup(ctx, creatorID, participantIDs, name)
}

// CreateGroup creates a new group conversation with the given participants.
// A group requires the creator plus at least one other unique participant.
func (s *ConversationService) CreateGroup(ctx context.Context, creatorID string, participantIDs []string, name string) (*model.Conversation, error) {
	participantIDs = normalizeParticipantSet(creatorID, participantIDs)

	otherCount := 0
	for _, id := range participantIDs {
		if id != creatorID {
			otherCount++
		}
	}
	if otherCount < 1 {
		return nil, errors.New("conversation: group requires at least 1 other participant")
	}

	// Validate participants exist and collect display names in parallel
	// so a 10-participant group doesn't sit through 10 sequential
	// DynamoDB GetItems before the user sees their group appear.
	participantNames, err := s.fetchParticipantNames(ctx, participantIDs)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	// Deterministic ID derived from the sorted participant set so two
	// concurrent calls with the same constellation collide on the
	// store's attribute_not_exists guard rather than spawning duplicate
	// groups, and GetOrCreateGroup can find this row with one GetItem.
	convID := groupConversationID(participantIDs)
	conv := &model.Conversation{
		ID:             convID,
		Type:           model.ConversationTypeGroup,
		Name:           name,
		ParticipantIDs: participantIDs,
		CreatedBy:      creatorID,
		Activated:      false,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	userConvs := make([]*model.UserConversation, 0, len(participantIDs))
	for _, id := range participantIDs {
		displayName := name
		if displayName == "" {
			others := make([]string, 0, len(participantIDs)-1)
			for _, otherID := range participantIDs {
				if otherID == id {
					continue
				}
				if n := participantNames[otherID]; n != "" {
					others = append(others, n)
				}
			}
			displayName = strings.Join(others, ", ")
		}
		userConvs = append(userConvs, &model.UserConversation{
			UserID:         id,
			ConversationID: convID,
			Type:           model.ConversationTypeGroup,
			DisplayName:    displayName,
			ParticipantIDs: participantIDs,
			CreatedBy:      creatorID,
			Activated:      false,
			JoinedAt:       now,
			UpdatedAt:      now,
		})
	}

	if err := s.conversations.CreateConversation(ctx, conv, userConvs); err != nil {
		// Concurrent GetOrCreateGroup calls may race here — return the
		// existing row instead of erroring.
		if errors.Is(err, store.ErrAlreadyExists) {
			return s.conversations.GetConversation(ctx, convID)
		}
		return nil, fmt.Errorf("conversation: create group: %w", err)
	}

	if s.broker != nil {
		for _, id := range participantIDs {
			s.broker.Subscribe(id, pubsub.ConversationName(convID))
		}
	}

	// NOTE: EventConversationNew is deferred until the first message is sent
	// so the group only appears in non-creator sidebars once it has activity.

	return conv, nil
}

// ListUserConversations returns all conversations the user participates in,
// hiding non-activated conversations from non-creator participants. A
// conversation becomes activated once its first message is sent.
func (s *ConversationService) ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error) {
	convs, err := s.conversations.ListUserConversations(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("conversation: list: %w", err)
	}
	out := make([]*model.UserConversation, 0, len(convs))
	for _, c := range convs {
		if !c.Activated && c.CreatedBy != "" && c.CreatedBy != userID {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

// Activate marks the conversation as activated and broadcasts EventConversationNew
// to all participants. Idempotent: subsequent calls return nil without
// republishing. Called by MessageService when the first message is sent.
func (s *ConversationService) Activate(ctx context.Context, convID string) error {
	conv, err := s.conversations.GetConversation(ctx, convID)
	if err != nil {
		return fmt.Errorf("conversation: get for activate: %w", err)
	}
	if conv.Activated {
		return nil
	}
	if err := s.conversations.ActivateConversation(ctx, convID, conv.ParticipantIDs); err != nil {
		return fmt.Errorf("conversation: activate: %w", err)
	}

	channels := make([]string, len(conv.ParticipantIDs))
	for i, id := range conv.ParticipantIDs {
		channels[i] = pubsub.UserChannel(id)
	}
	payload := map[string]any{
		"conversationID": conv.ID,
		"type":           string(conv.Type),
		"participantIDs": conv.ParticipantIDs,
	}
	publishConversationNew(ctx, s.publisher, channels, payload)
	return nil
}

// IsParticipant reports whether the user appears in the conversation's
// participant list. Used by the WebSocket handler to gate inbound
// ephemeral events (typing indicator).
func (s *ConversationService) IsParticipant(ctx context.Context, userID, convID string) bool {
	if userID == "" || convID == "" {
		return false
	}
	conv, err := s.conversations.GetConversation(ctx, convID)
	if err != nil || conv == nil {
		return false
	}
	for _, id := range conv.ParticipantIDs {
		if id == userID {
			return true
		}
	}
	return false
}

// SetFavorite pins the DM/group to the user's "Favorites" sidebar
// section. Caller must be a participant — pinning a conversation you
// can't see would create an orphan user-side row.
func (s *ConversationService) SetFavorite(ctx context.Context, userID, convID string, favorite bool) error {
	if !s.IsParticipant(ctx, userID, convID) {
		return errors.New("conversation: not a participant")
	}
	if err := s.conversations.SetFavorite(ctx, convID, userID, favorite); err != nil {
		return fmt.Errorf("conversation: set favorite: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"conversationID": convID,
		"userID":         userID,
		"favorite":       favorite,
	})
	return nil
}

// SetCategory assigns the DM/group to one of the user's sidebar
// categories (or clears it when categoryID is empty). Validation that
// the categoryID belongs to the user is the handler's responsibility.
func (s *ConversationService) SetCategory(ctx context.Context, userID, convID, categoryID string, sidebarPosition *int) error {
	if !s.IsParticipant(ctx, userID, convID) {
		return errors.New("conversation: not a participant")
	}
	if err := s.conversations.SetCategory(ctx, convID, userID, categoryID, sidebarPosition); err != nil {
		return fmt.Errorf("conversation: set category: %w", err)
	}
	payload := map[string]any{
		"conversationID": convID,
		"userID":         userID,
		"categoryID":     categoryID,
	}
	if sidebarPosition != nil {
		payload["sidebarPosition"] = *sidebarPosition
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, payload)
	return nil
}

// GetByID returns a conversation if the requesting user is a participant.
func (s *ConversationService) GetByID(ctx context.Context, userID, convID string) (*model.Conversation, error) {
	conv, err := s.conversations.GetConversation(ctx, convID)
	if err != nil {
		return nil, fmt.Errorf("conversation: get: %w", err)
	}

	for _, id := range conv.ParticipantIDs {
		if id == userID {
			return conv, nil
		}
	}
	return nil, fmt.Errorf("conversation: not a participant: %w", ErrForbidden)
}

// dmConversationID deterministically derives a ULID-formatted conversation ID
// from two user IDs so all entity IDs share the same format.
func dmConversationID(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return store.DeriveID(a + ":" + b)
}

// groupConversationID derives a deterministic group ID from its
// participant set so two attempts to chat with the same constellation
// land on the same conversation. participants must already be the
// canonical set (creator included, deduped) — see normalizeParticipantSet.
// The hash is order-independent: we sort before joining.
func groupConversationID(participants []string) string {
	sorted := make([]string, len(participants))
	copy(sorted, participants)
	sort.Strings(sorted)
	return store.DeriveID("group:" + strings.Join(sorted, ":"))
}

// fetchParticipantNames concurrently resolves the supplied user IDs to
// their display names. Returns ErrNotFound-wrapped errors if any
// participant doesn't exist, mirroring the previous serial behaviour.
func (s *ConversationService) fetchParticipantNames(ctx context.Context, ids []string) (map[string]string, error) {
	type result struct {
		id   string
		name string
		err  error
	}
	results := make(chan result, len(ids))
	var wg sync.WaitGroup
	wg.Add(len(ids))
	for _, id := range ids {
		go func(id string) {
			defer wg.Done()
			u, err := s.users.GetUser(ctx, id)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					results <- result{id: id, err: fmt.Errorf("conversation: participant %s not found", id)}
					return
				}
				results <- result{id: id, err: fmt.Errorf("conversation: validate participant: %w", err)}
				return
			}
			name := ""
			if u != nil {
				name = u.DisplayName
			}
			results <- result{id: id, name: name}
		}(id)
	}
	wg.Wait()
	close(results)

	out := make(map[string]string, len(ids))
	for r := range results {
		if r.err != nil {
			return nil, r.err
		}
		out[r.id] = r.name
	}
	return out, nil
}
