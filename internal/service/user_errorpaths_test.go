package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func newUserSvc() (*UserService, *mockUserStore) {
	users := newMockUserStore()
	return NewUserService(users, newMockCache(), nil, nil), users
}

func TestUser_Update_GetError(t *testing.T) {
	svc, users := newUserSvc()
	users.getUserErr = errors.New("boom")
	name := "New"
	if _, err := svc.Update(context.Background(), "u1", &name, nil, nil); err == nil {
		t.Fatal("expected get error")
	}
}

func TestUser_Update_UpdateError(t *testing.T) {
	svc, users := newUserSvc()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Old", AuthProvider: model.AuthProviderGuest}
	users.updateErr = errors.New("boom")
	name := "New"
	if _, err := svc.Update(context.Background(), "u1", &name, nil, nil); err == nil {
		t.Fatal("expected update error")
	}
}

func TestUser_SetStatus_GetError(t *testing.T) {
	svc, users := newUserSvc()
	users.getUserErr = errors.New("boom")
	if _, err := svc.SetStatus(context.Background(), "u1", true); err == nil {
		t.Fatal("expected get error")
	}
}

func TestUser_SetStatus_NonGuest(t *testing.T) {
	svc, users := newUserSvc()
	users.users["u1"] = &model.User{ID: "u1", AuthProvider: model.AuthProviderGuest}
	users.users["u2"] = &model.User{ID: "u2", AuthProvider: "oidc"}
	if _, err := svc.SetStatus(context.Background(), "u2", true); err == nil {
		t.Fatal("expected only-guest error")
	}
}

func TestUser_SetStatus_UpdateError(t *testing.T) {
	svc, users := newUserSvc()
	users.users["u1"] = &model.User{ID: "u1", AuthProvider: model.AuthProviderGuest}
	users.updateErr = errors.New("boom")
	if _, err := svc.SetStatus(context.Background(), "u1", true); err == nil {
		t.Fatal("expected update error")
	}
}

func TestUser_Search_ListError(t *testing.T) {
	svc, users := newUserSvc()
	users.listErr = errors.New("boom")
	if _, err := svc.Search(context.Background(), "alice", 10); err == nil {
		t.Fatal("expected search list error")
	}
}

func TestUser_ClearExpiredStatuses_ListError(t *testing.T) {
	svc, users := newUserSvc()
	users.listErr = errors.New("boom")
	if _, err := svc.ClearExpiredStatuses(context.Background(), time.Now(), 10); err == nil {
		t.Fatal("expected clear-expired list error")
	}
}
