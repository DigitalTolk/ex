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

// DraftConflictError reports a write whose basis generation no longer matches
// the stored draft — the client acted on stale state. Current is the stored
// draft at decision time (nil when the scope has no draft), so callers can
// hand the client the truth to reconcile against. Nothing was written.
type DraftConflictError struct {
	Current *model.MessageDraft
}

func (e *DraftConflictError) Error() string { return "draft: generation conflict" }

// upsertConfig tunes a single Upsert call.
type upsertConfig struct {
	silent bool
}

// UpsertOption configures Upsert behavior.
type UpsertOption func(*upsertConfig)

// WithSilent suppresses the draft.updated broadcast for this upsert when
// silent is true. The draft is still persisted — only the cross-device
// "a draft is available" signal is withheld. Used for keystroke-by-keystroke
// saves while the user is still typing; the composer fires a non-silent
// upsert when it loses focus so the indicator surfaces only then.
func WithSilent(silent bool) UpsertOption {
	return func(c *upsertConfig) { c.silent = silent }
}

// Upsert creates or replaces the draft for a single composer scope; empty
// content clears it (returning a nil draft). basisGen is the generation the
// client acted on ("" = it believes no draft exists): a mismatch means the
// client is stale, nothing is written, and a *DraftConflictError carrying
// the current state is returned — the server decides, the client reconciles.
func (s *DraftService) Upsert(ctx context.Context, userID, parentID, parentType, parentMessageID, body string, attachmentIDs []string, basisGen string, opts ...UpsertOption) (*model.MessageDraft, error) {
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

	id := draftID(userID, parentType, parentID, parentMessageID)
	if body == "" && len(attachmentIDs) == 0 {
		// The composer reports "I'm empty now" unconditionally; whether that
		// clears anything is the store's CAS decision. Clearing an absent
		// draft with the empty basis is an accepted no-op.
		res, err := s.drafts.Delete(ctx, userID, id, basisGen)
		if err != nil {
			return nil, fmt.Errorf("draft: delete empty: %w", err)
		}
		if !res.OK {
			return nil, &DraftConflictError{Current: res.Current}
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
		Gen:             store.NewID(),
	}
	res, err := s.drafts.Upsert(ctx, draft, basisGen)
	if err != nil {
		return nil, fmt.Errorf("draft: upsert: %w", err)
	}
	if !res.OK {
		return nil, &DraftConflictError{Current: res.Current}
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

// Delete removes a draft by ID iff basisGen matches the stored generation —
// an explicit delete (Drafts page) still only applies to the state the user
// was looking at; a mismatch returns *DraftConflictError with the truth.
func (s *DraftService) Delete(ctx context.Context, userID, id, basisGen string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("draft: id required")
	}
	res, err := s.drafts.Delete(ctx, userID, id, basisGen)
	if err != nil {
		return fmt.Errorf("draft: delete: %w", err)
	}
	if !res.OK {
		return &DraftConflictError{Current: res.Current}
	}
	s.publishUpdated(ctx, userID, id)
	return nil
}

// DeleteForScope removes the draft for a composer scope unconditionally. Used
// only by the message-send fold: sending is the authoritative user event for
// the scope, so it always wins — no generation check, no client clock. The id
// is derived from the scope, so the caller never needs the draft id.
func (s *DraftService) DeleteForScope(ctx context.Context, userID, parentID, parentType, parentMessageID string) error {
	id := draftID(userID, parentType, parentID, parentMessageID)
	if err := s.drafts.DeleteUnconditional(ctx, userID, id); err != nil {
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
