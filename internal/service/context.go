package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ErrContextFull signals the per-parent item cap (plan-v2 §8 governance).
var ErrContextFull = errors.New("shared context is full for this channel")

// ContextItemStore is the store surface ContextService needs.
type ContextItemStore interface {
	PutContextItem(ctx context.Context, it *model.ContextItem) error
	GetContextItem(ctx context.Context, parentType, parentID, itemID string) (*model.ContextItem, error)
	ListContextItems(ctx context.Context, parentType, parentID string) ([]*model.ContextItem, error)
	DeleteContextItem(ctx context.Context, parentType, parentID, itemID string) error
}

// contextAccessChecker is the slice of MessageService the context service
// uses for visibility: shared context is readable/writable by exactly the
// people who can read the channel/conversation it belongs to.
type contextAccessChecker interface {
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// ContextService owns the shared-context items (CTX#, plan-v2 §8): the
// curated facts/briefs/decisions every agent run in a parent reads. Humans
// manage them over REST; agents append via write_shared_context.
type ContextService struct {
	items  ContextItemStore
	access contextAccessChecker
	newID  func() string
	now    func() time.Time
}

// NewContextService wires the service.
func NewContextService(items ContextItemStore, access contextAccessChecker) *ContextService {
	return &ContextService{items: items, access: access, newID: store.NewID, now: time.Now}
}

// List returns a parent's items, checked against the accessor.
func (s *ContextService) List(ctx context.Context, accessorID, parentID, parentType string) ([]*model.ContextItem, error) {
	if err := s.access.CheckAccess(ctx, accessorID, parentID, parentType); err != nil {
		return nil, err
	}
	return s.items.ListContextItems(ctx, parentType, parentID)
}

// Write appends one item. authorID is who the item is attributed to (a human,
// or a shared agent — then invokerID says whose run); accessorID is whose
// permissions gate the write. For humans the two are the same; for agent runs
// the accessor is the INVOKER (plan-v2 §3 — an agent can never write where
// the invoker can't).
func (s *ContextService) Write(ctx context.Context, authorID, invokerID, accessorID, parentID, parentType, body string, pinned bool) (*model.ContextItem, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return nil, fmt.Errorf("context: body required: %w", ErrValidation)
	}
	if len(body) > model.ContextItemMaxBytes {
		return nil, fmt.Errorf("context: body exceeds %d bytes: %w", model.ContextItemMaxBytes, ErrValidation)
	}
	if err := s.access.CheckAccess(ctx, accessorID, parentID, parentType); err != nil {
		return nil, err
	}
	existing, err := s.items.ListContextItems(ctx, parentType, parentID)
	if err != nil {
		return nil, err
	}
	if len(existing) >= model.ContextItemsPerScope {
		return nil, ErrContextFull
	}
	now := s.now()
	it := &model.ContextItem{
		ID:         s.newID(),
		ParentID:   parentID,
		ParentType: parentType,
		AuthorID:   authorID,
		InvokerID:  invokerID,
		Body:       body,
		Pinned:     pinned,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := s.items.PutContextItem(ctx, it); err != nil {
		return nil, err
	}
	return it, nil
}

// SetPinned toggles an item's trim priority. Same edit rights as Delete.
func (s *ContextService) SetPinned(ctx context.Context, accessorID, parentID, parentType, itemID string, pinned bool) (*model.ContextItem, error) {
	it, err := s.editable(ctx, accessorID, parentID, parentType, itemID)
	if err != nil {
		return nil, err
	}
	it.Pinned = pinned
	it.UpdatedAt = s.now()
	if err := s.items.PutContextItem(ctx, it); err != nil {
		return nil, err
	}
	return it, nil
}

// Delete removes an item. Allowed for its author, the invoker of the run
// that wrote it, or anyone with access when the author was an agent — humans
// curate what agents accumulate.
func (s *ContextService) Delete(ctx context.Context, accessorID, parentID, parentType, itemID string) error {
	if _, err := s.editable(ctx, accessorID, parentID, parentType, itemID); err != nil {
		return err
	}
	return s.items.DeleteContextItem(ctx, parentType, parentID, itemID)
}

func (s *ContextService) editable(ctx context.Context, accessorID, parentID, parentType, itemID string) (*model.ContextItem, error) {
	if err := s.access.CheckAccess(ctx, accessorID, parentID, parentType); err != nil {
		return nil, err
	}
	it, err := s.items.GetContextItem(ctx, parentType, parentID, itemID)
	if err != nil {
		return nil, err
	}
	if it.AuthorID != accessorID && it.InvokerID != accessorID && it.InvokerID == "" {
		// Human-authored items are the author's; agent-authored items
		// (InvokerID set) are curatable by any member with access.
		return nil, fmt.Errorf("context: not the item author: %w", ErrForbidden)
	}
	return it, nil
}
