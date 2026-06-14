package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestEmoji_ResolveCreateImageURL_NoSigner(t *testing.T) {
	svc, _, _, _ := setupEmojiSvc() // no signer/mediaCache wired
	if _, err := svc.resolveCreateImageURL(context.Background(), "smile", "key"); err == nil {
		t.Fatal("expected signer-not-configured error")
	}
}

func TestEmoji_Delete_GetUserError(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.getUserErr = errors.New("boom")
	if err := svc.Delete(context.Background(), "u1", "smile"); err == nil {
		t.Fatal("expected get-user error")
	}
}

func TestEmoji_Delete_NotFound(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleAdmin}
	if err := svc.Delete(context.Background(), "u1", "missing"); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestEmoji_Delete_NotAuthorized(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	emojis.items["smile"] = &model.CustomEmoji{Name: "smile", CreatedBy: "other"}
	if err := svc.Delete(context.Background(), "u1", "smile"); err == nil {
		t.Fatal("expected not-authorized error")
	}
}

func TestEmoji_Delete_DeleteError(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleAdmin}
	emojis.items["smile"] = &model.CustomEmoji{Name: "smile", CreatedBy: "u1"}
	emojis.deleteErr = errors.New("boom")
	if err := svc.Delete(context.Background(), "u1", "smile"); err == nil {
		t.Fatal("expected delete error")
	}
}

func TestCategory_List_Error(t *testing.T) {
	store := newStubCategoryStore()
	store.listErr = errors.New("boom")
	svc := NewCategoryService(store, newMockPublisher())
	if _, err := svc.List(context.Background(), "u1"); err == nil {
		t.Fatal("expected list error")
	}
}
