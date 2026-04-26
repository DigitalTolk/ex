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

// CategoryStore is the slice of store.CategoryStore CategoryService
// needs. Defined here as an interface so tests can stub it.
type CategoryStore interface {
	Create(ctx context.Context, c *model.UserChannelCategory) error
	Get(ctx context.Context, userID, categoryID string) (*model.UserChannelCategory, error)
	List(ctx context.Context, userID string) ([]*model.UserChannelCategory, error)
	Update(ctx context.Context, c *model.UserChannelCategory) error
	Delete(ctx context.Context, userID, categoryID string) error
}

// CategoryService manages a user's sidebar categories. The categories
// are purely a UI grouping — they don't affect membership or visibility.
type CategoryService struct {
	store     CategoryStore
	publisher Publisher
}

// NewCategoryService creates a CategoryService.
func NewCategoryService(s CategoryStore, p Publisher) *CategoryService {
	return &CategoryService{store: s, publisher: p}
}

// Create adds a new category for the user with the given name. Position
// defaults to "end of list" — categories are always appended.
func (s *CategoryService) Create(ctx context.Context, userID, name string) (*model.UserChannelCategory, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("category: name is required")
	}
	existing, err := s.store.List(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("category: list: %w", err)
	}
	maxPos := 0
	for _, c := range existing {
		if c.Position > maxPos {
			maxPos = c.Position
		}
	}
	c := &model.UserChannelCategory{
		UserID:    userID,
		ID:        store.NewID(),
		Name:      name,
		Position:  maxPos + 1,
		CreatedAt: time.Now(),
	}
	if err := s.store.Create(ctx, c); err != nil {
		return nil, fmt.Errorf("category: create: %w", err)
	}
	s.publishUpdated(ctx, userID)
	return c, nil
}

// List returns the user's categories, ordered by position.
func (s *CategoryService) List(ctx context.Context, userID string) ([]*model.UserChannelCategory, error) {
	cats, err := s.store.List(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("category: list: %w", err)
	}
	if cats == nil {
		cats = []*model.UserChannelCategory{}
	}
	return cats, nil
}

// Update applies a partial change: name and/or position. The caller
// passes the new desired values (zero values are kept; a non-zero
// position changes the row's position). The category must already
// belong to the user — store-side condition guards a stranger from
// flipping someone else's row.
func (s *CategoryService) Update(ctx context.Context, userID, categoryID string, name *string, position *int) (*model.UserChannelCategory, error) {
	cat, err := s.store.Get(ctx, userID, categoryID)
	if err != nil {
		return nil, fmt.Errorf("category: get: %w", err)
	}
	if name != nil {
		trimmed := strings.TrimSpace(*name)
		if trimmed == "" {
			return nil, errors.New("category: name is required")
		}
		cat.Name = trimmed
	}
	if position != nil {
		cat.Position = *position
	}
	if err := s.store.Update(ctx, cat); err != nil {
		return nil, fmt.Errorf("category: update: %w", err)
	}
	s.publishUpdated(ctx, userID)
	return cat, nil
}

// Delete removes a category. Channels assigned to it become uncategorised
// (the frontend renders them under the default "Other" section).
// Reassigning the channels server-side would require a scan; instead we
// rely on the frontend's lookup-by-ID falling through gracefully when
// the category is gone.
func (s *CategoryService) Delete(ctx context.Context, userID, categoryID string) error {
	if err := s.store.Delete(ctx, userID, categoryID); err != nil {
		return fmt.Errorf("category: delete: %w", err)
	}
	s.publishUpdated(ctx, userID)
	return nil
}

func (s *CategoryService) publishUpdated(ctx context.Context, userID string) {
	if s.publisher == nil {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"userID":     userID,
		"categories": true,
	})
}
