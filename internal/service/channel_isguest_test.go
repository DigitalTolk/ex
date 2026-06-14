package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestChannel_IsGuest(t *testing.T) {
	svc, _, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["guest"] = &model.User{ID: "guest", SystemRole: model.SystemRoleGuest}
	users.users["member"] = &model.User{ID: "member", SystemRole: model.SystemRoleMember}

	if !svc.isGuest(context.Background(), "guest") {
		t.Error("guest user should be guest")
	}
	if svc.isGuest(context.Background(), "member") {
		t.Error("member should not be guest")
	}
	if svc.isGuest(context.Background(), "") {
		t.Error("empty user id should not be guest")
	}
}

func TestChannel_IsGuest_GetUserError(t *testing.T) {
	svc, _, _, users, _, _ := setupChannelServiceWithUsers()
	users.getUserErr = errors.New("boom")
	if svc.isGuest(context.Background(), "u1") {
		t.Error("get-user error should yield not-guest")
	}
}

func TestChannel_SetCategory_GetMembershipError(t *testing.T) {
	svc, _, memberships, _, _, _ := setupChannelServiceWithUsers()
	memberships.getErr = errors.New("boom")
	if err := svc.SetCategory(context.Background(), "u1", "ch1", "cat1", nil); err == nil {
		t.Fatal("expected get-membership error")
	}
}

func TestCategory_PublishUpdated_NilPublisher(t *testing.T) {
	store := newStubCategoryStore()
	store.rows["u1#cat1"] = &model.UserChannelCategory{ID: "cat1", Name: "X"}
	svc := NewCategoryService(store, nil) // nil publisher → publishUpdated early-returns
	if err := svc.Delete(context.Background(), "u1", "cat1"); err != nil {
		t.Fatalf("Delete with nil publisher should succeed, got %v", err)
	}
}
