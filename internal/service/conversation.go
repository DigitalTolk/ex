package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

// CreateGroup creates a new group conversation with the given participants.
// A group requires the creator plus at least one other unique participant.
func (s *ConversationService) CreateGroup(ctx context.Context, creatorID string, participantIDs []string, name string) (*model.Conversation, error) {
	seen := make(map[string]bool, len(participantIDs)+1)
	deduped := make([]string, 0, len(participantIDs)+1)
	for _, id := range participantIDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		deduped = append(deduped, id)
	}
	if !seen[creatorID] {
		seen[creatorID] = true
		deduped = append(deduped, creatorID)
	}
	participantIDs = deduped

	otherCount := 0
	for _, id := range participantIDs {
		if id != creatorID {
			otherCount++
		}
	}
	if otherCount < 1 {
		return nil, errors.New("conversation: group requires at least 1 other participant")
	}

	// Single pass: validate participants exist AND collect display names so we
	// can derive a per-recipient label when the user didn't supply a name.
	participantNames := make(map[string]string, len(participantIDs))
	for _, id := range participantIDs {
		u, err := s.users.GetUser(ctx, id)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil, fmt.Errorf("conversation: participant %s not found", id)
			}
			return nil, fmt.Errorf("conversation: validate participant: %w", err)
		}
		if u != nil {
			participantNames[id] = u.DisplayName
		}
	}

	now := time.Now()
	convID := store.NewID()
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
		})
	}

	if err := s.conversations.CreateConversation(ctx, conv, userConvs); err != nil {
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
func (s *ConversationService) SetCategory(ctx context.Context, userID, convID, categoryID string) error {
	if !s.IsParticipant(ctx, userID, convID) {
		return errors.New("conversation: not a participant")
	}
	if err := s.conversations.SetCategory(ctx, convID, userID, categoryID); err != nil {
		return fmt.Errorf("conversation: set category: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"conversationID": convID,
		"userID":         userID,
		"categoryID":     categoryID,
	})
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
	return nil, errors.New("conversation: not a participant")
}

// dmConversationID deterministically derives a ULID-formatted conversation ID
// from two user IDs so all entity IDs share the same format.
func dmConversationID(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return store.DeriveID(a + ":" + b)
}
