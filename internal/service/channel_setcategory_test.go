package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestChannel_SetCategory_StoreError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	// Membership exists (GetMembership passes) but there's no user-channel
	// row, so the store's SetCategory returns ErrNotFound → wrapped error.
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	if err := svc.SetCategory(context.Background(), "u1", "ch1", "cat1", nil); err == nil {
		t.Fatal("expected set-category store error")
	}
}

func TestConv_GetUserProfile_NilUsers(t *testing.T) {
	// userProfiles nil AND users nil → ErrNotFound branch.
	svc := NewConversationService(newMockConversationStore(), nil, newMockCache(), newMockBroker(), newMockPublisher())
	if _, err := svc.getUserProfile(context.Background(), "u1"); err == nil {
		t.Fatal("expected not-found when no user source is configured")
	}
}
