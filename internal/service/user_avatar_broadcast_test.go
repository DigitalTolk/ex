package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// TestUpdate_PublishesUserUpdatedEvent verifies that profile updates fan out
// a user.updated event so connected clients refresh stale avatar URLs.
func TestUpdate_PublishesUserUpdatedEvent(t *testing.T) {
	users := newMockUserStore()
	cache := &mockCache{}
	pub := newMockPublisher()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Old", AvatarKey: ""}

	svc := NewUserService(users, cache, fakeAvatarSigner{}, pub)

	newName := "New"
	if _, err := svc.Update(context.Background(), "u1", &newName, nil); err != nil {
		t.Fatalf("update: %v", err)
	}

	found := false
	for _, p := range pub.published {
		if p.event.Type == events.EventUserUpdated && p.channel == pubsub.UserEvents() {
			found = true
		}
	}
	if !found {
		t.Errorf("expected user.updated published to %q, got %+v", pubsub.UserEvents(), pub.published)
	}
}

// TestUpdate_NoPublisherDoesNotPanic verifies that without a publisher we
// silently skip the event broadcast.
func TestUpdate_NoPublisherDoesNotPanic(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Old"}

	svc := NewUserService(users, nil, nil, nil)
	newName := "New"
	if _, err := svc.Update(context.Background(), "u1", &newName, nil); err != nil {
		t.Fatalf("update: %v", err)
	}
}
