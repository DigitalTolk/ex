package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// DraftService manages server-side composer drafts.
type DraftService struct {
	drafts        DraftStore
	messages      MessageStore
	memberships   MembershipStore
	conversations ConversationStore
	publisher     Publisher
}

// NewDraftService creates a DraftService.
func NewDraftService(drafts DraftStore, messages MessageStore, memberships MembershipStore, conversations ConversationStore, publisher Publisher) *DraftService {
	return &DraftService{
		drafts:        drafts,
		messages:      messages,
		memberships:   memberships,
		conversations: conversations,
		publisher:     publisher,
	}
}

// upsertConfig tunes a single Upsert call.
type upsertConfig struct {
	silent bool
	ts     int64 // client edit time (epoch ms) for LWW; 0 → server now
}

// UpsertOption configures Upsert behavior.
type UpsertOption func(*upsertConfig)

// WithClientTs sets the client edit time (epoch ms) used for last-write-wins
// ordering. The store keeps a save only if its ts is newer than the stored
// value's, so a delayed keystroke can't supersede a later send. Defaults to
// server time when unset (0).
func WithClientTs(ts int64) UpsertOption {
	return func(c *upsertConfig) { c.ts = ts }
}

// WithSilent suppresses the draft.updated broadcast for this upsert when
// silent is true. The draft is still persisted — only the cross-device
// "a draft is available" signal is withheld. Used for keystroke-by-keystroke
// saves while the user is still typing; the composer fires a non-silent
// upsert when it loses focus so the indicator surfaces only then.
func WithSilent(silent bool) UpsertOption {
	return func(c *upsertConfig) { c.silent = silent }
}

// Upsert creates or replaces the draft for a single composer scope. Empty
// content deletes that scope's draft and returns nil.
func (s *DraftService) Upsert(ctx context.Context, userID, parentID, parentType, parentMessageID, body string, attachmentIDs []string, opts ...UpsertOption) (*model.MessageDraft, error) {
	var cfg upsertConfig
	for _, opt := range opts {
		opt(&cfg)
	}
	if strings.TrimSpace(userID) == "" {
		return nil, errors.New("draft: user required")
	}
	parentID = strings.TrimSpace(parentID)
	parentType = strings.TrimSpace(parentType)
	parentMessageID = strings.TrimSpace(parentMessageID)
	if parentID == "" {
		return nil, errors.New("draft: parent required")
	}
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	if parentMessageID != "" {
		if err := s.checkThreadRoot(ctx, parentID, parentMessageID); err != nil {
			return nil, err
		}
	}
	if err := ValidateMessageBody(body); err != nil {
		return nil, err
	}
	attachmentIDs = cleanIDs(attachmentIDs)
	if err := ValidateAttachmentCount(len(attachmentIDs)); err != nil {
		return nil, err
	}

	now := time.Now()
	ts := tsOrNow(cfg.ts)

	id := draftID(userID, parentType, parentID, parentMessageID)
	if body == "" && len(attachmentIDs) == 0 {
		if err := s.drafts.Delete(ctx, userID, id, ts); err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("draft: delete empty: %w", err)
		}
		if !cfg.silent {
			s.publishUpdated(ctx, userID, id)
		}
		return nil, nil
	}

	createdAt := now
	if existing, err := s.drafts.Get(ctx, userID, id); err == nil && existing != nil {
		createdAt = existing.CreatedAt
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("draft: get existing: %w", err)
	}

	draft := &model.MessageDraft{
		ID:              id,
		UserID:          userID,
		ParentID:        parentID,
		ParentType:      parentType,
		ParentMessageID: parentMessageID,
		Body:            body,
		AttachmentIDs:   attachmentIDs,
		CreatedAt:       createdAt,
		UpdatedAt:       now,
		Ts:              ts,
	}
	if err := s.drafts.Upsert(ctx, draft); err != nil {
		return nil, fmt.Errorf("draft: upsert: %w", err)
	}
	if !cfg.silent {
		s.publishUpdated(ctx, userID, id)
	}
	return draft, nil
}

// List returns all drafts for the user, newest first.
func (s *DraftService) List(ctx context.Context, userID string) ([]*model.MessageDraft, error) {
	drafts, err := s.drafts.List(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("draft: list: %w", err)
	}
	sort.SliceStable(drafts, func(i, j int) bool {
		return drafts[i].UpdatedAt.After(drafts[j].UpdatedAt)
	})
	return drafts, nil
}

// Delete removes a draft by ID at client ts (epoch ms; 0 → server now).
func (s *DraftService) Delete(ctx context.Context, userID, id string, ts int64) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("draft: id required")
	}
	if err := s.drafts.Delete(ctx, userID, id, tsOrNow(ts)); err != nil {
		return fmt.Errorf("draft: delete: %w", err)
	}
	s.publishUpdated(ctx, userID, id)
	return nil
}

// DeleteForScope removes the draft for a composer scope at client ts (epoch ms;
// 0 → server now). Used by the message-send path to clear the scope's draft as
// the message is created — the id is derived from the scope, so it works without
// the caller knowing the draft id.
func (s *DraftService) DeleteForScope(ctx context.Context, userID, parentID, parentType, parentMessageID string, ts int64) error {
	id := draftID(userID, parentType, parentID, parentMessageID)
	if err := s.drafts.Delete(ctx, userID, id, tsOrNow(ts)); err != nil {
		return fmt.Errorf("draft: delete for scope: %w", err)
	}
	s.publishUpdated(ctx, userID, id)
	return nil
}

func (s *DraftService) checkAccess(ctx context.Context, userID, parentID, parentType string) error {
	switch parentType {
	case ParentChannel:
		_, err := s.memberships.GetMembership(ctx, parentID, userID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return errors.New("draft: not a channel member")
			}
			return fmt.Errorf("draft: check channel membership: %w", err)
		}
	case ParentConversation:
		conv, err := s.conversations.GetConversation(ctx, parentID)
		if err != nil {
			return fmt.Errorf("draft: get conversation: %w", err)
		}
		for _, id := range conv.ParticipantIDs {
			if id == userID {
				return nil
			}
		}
		return errors.New("draft: not a conversation participant")
	default:
		return fmt.Errorf("draft: unknown parent type %q", parentType)
	}
	return nil
}

func (s *DraftService) checkThreadRoot(ctx context.Context, parentID, parentMessageID string) error {
	msg, err := s.messages.GetMessage(ctx, parentID, parentMessageID)
	if err != nil {
		return fmt.Errorf("draft: get thread root: %w", err)
	}
	if msg.Deleted {
		return errors.New("draft: thread root deleted")
	}
	return nil
}

func (s *DraftService) publishUpdated(ctx context.Context, userID, draftID string) {
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventDraftUpdated, map[string]string{
		"id": draftID,
	})
}

// tsOrNow defaults a missing client timestamp (0) to server time, in epoch ms.
// It's the single home for the last-write-wins clock fallback.
func tsOrNow(ts int64) int64 {
	if ts == 0 {
		return time.Now().UnixMilli()
	}
	return ts
}

func draftID(userID, parentType, parentID, parentMessageID string) string {
	return store.DeriveID("draft:" + userID + ":" + parentType + ":" + parentID + ":" + parentMessageID)
}

func cleanIDs(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	cleaned := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			cleaned = append(cleaned, id)
		}
	}
	return cleaned
}
