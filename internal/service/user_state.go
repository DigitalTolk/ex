package service

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

type UserStateService struct {
	store     UserStateStore
	publisher Publisher
}

func NewUserStateService(store UserStateStore, publisher Publisher) *UserStateService {
	return &UserStateService{store: store, publisher: publisher}
}

func (s *UserStateService) List(ctx context.Context, userID string) (*model.UserState, error) {
	state := &model.UserState{
		ThreadNotifications: []string{},
		ThreadSeen:          map[string]string{},
		HiddenConversations: []string{},
		HiddenSkills:        []string{},
	}
	if s.store == nil || userID == "" {
		return state, nil
	}
	items, err := s.store.ListUserState(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("user state: list: %w", err)
	}
	for _, item := range items {
		switch item.Kind {
		case model.UserStateThreadNotification:
			state.ThreadNotifications = append(state.ThreadNotifications, item.TargetID)
		case model.UserStateThreadSeen:
			if item.SeenAt != nil {
				state.ThreadSeen[item.TargetID] = item.SeenAt.Format(time.RFC3339Nano)
			}
		case model.UserStateHiddenConversation:
			state.HiddenConversations = append(state.HiddenConversations, item.TargetID)
		case model.UserStateHiddenSkill:
			state.HiddenSkills = append(state.HiddenSkills, item.TargetID)
		}
	}
	sort.Strings(state.ThreadNotifications)
	sort.Strings(state.HiddenConversations)
	sort.Strings(state.HiddenSkills)
	return state, nil
}

func (s *UserStateService) MarkThreadNotificationUnread(ctx context.Context, userID, parentID, parentType, threadRootID string) error {
	return s.set(ctx, &model.UserStateItem{
		UserID:       userID,
		Kind:         model.UserStateThreadNotification,
		TargetID:     threadRootID,
		ParentID:     parentID,
		ParentType:   parentType,
		ThreadRootID: threadRootID,
		UpdatedAt:    time.Now(),
	})
}

func (s *UserStateService) MarkThreadSeen(ctx context.Context, userID, parentID, parentType, threadRootID string) error {
	now := time.Now()
	if err := s.set(ctx, &model.UserStateItem{
		UserID:       userID,
		Kind:         model.UserStateThreadSeen,
		TargetID:     threadRootID,
		ParentID:     parentID,
		ParentType:   parentType,
		ThreadRootID: threadRootID,
		SeenAt:       &now,
		UpdatedAt:    now,
	}); err != nil {
		return err
	}
	return s.delete(ctx, userID, model.UserStateThreadNotification, threadRootID)
}

func (s *UserStateService) HideConversation(ctx context.Context, userID, convID string) error {
	return s.set(ctx, &model.UserStateItem{
		UserID:    userID,
		Kind:      model.UserStateHiddenConversation,
		TargetID:  convID,
		UpdatedAt: time.Now(),
	})
}

func (s *UserStateService) UnhideConversation(ctx context.Context, userID, convID string) error {
	return s.delete(ctx, userID, model.UserStateHiddenConversation, convID)
}

// HideSkill removes one skill from the discovery index of this user's agent
// runs; UnhideSkill restores it. Hiding never blocks an explicit /skill pick.
func (s *UserStateService) HideSkill(ctx context.Context, userID, skillID string) error {
	return s.set(ctx, &model.UserStateItem{
		UserID:    userID,
		Kind:      model.UserStateHiddenSkill,
		TargetID:  skillID,
		UpdatedAt: time.Now(),
	})
}

func (s *UserStateService) UnhideSkill(ctx context.Context, userID, skillID string) error {
	return s.delete(ctx, userID, model.UserStateHiddenSkill, skillID)
}

// HiddenSkillSet is the orchestrator's view: the set of skill ids userID has
// removed from their agents' discovery index.
func (s *UserStateService) HiddenSkillSet(ctx context.Context, userID string) (map[string]bool, error) {
	out := map[string]bool{}
	if s.store == nil || userID == "" {
		return out, nil
	}
	items, err := s.store.ListUserState(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("user state: list: %w", err)
	}
	for _, item := range items {
		if item.Kind == model.UserStateHiddenSkill {
			out[item.TargetID] = true
		}
	}
	return out, nil
}

func (s *UserStateService) set(ctx context.Context, item *model.UserStateItem) error {
	if s.store == nil || item.UserID == "" || item.TargetID == "" {
		return nil
	}
	if err := s.store.SetUserState(ctx, item); err != nil {
		return fmt.Errorf("user state: set %s: %w", item.Kind, err)
	}
	s.publishChanged(ctx, item.UserID)
	return nil
}

func (s *UserStateService) delete(ctx context.Context, userID string, kind model.UserStateKind, targetID string) error {
	if s.store == nil || userID == "" || targetID == "" {
		return nil
	}
	if err := s.store.DeleteUserState(ctx, userID, kind, targetID); err != nil {
		return fmt.Errorf("user state: delete %s: %w", kind, err)
	}
	s.publishChanged(ctx, userID)
	return nil
}

func (s *UserStateService) publishChanged(ctx context.Context, userID string) {
	if s.publisher == nil || userID == "" {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"userState": true,
	})
}
