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

func TestEmoji_Create_GetUserError(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{}})
	users.getUserErr = errors.New("boom") // valid image, but user lookup fails
	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png", false); err == nil {
		t.Fatal("expected get-user error")
	}
}

func TestEmoji_Create_GuestRejected(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{}})
	users.users["g1"] = &model.User{ID: "g1", SystemRole: model.SystemRoleGuest}
	if _, err := svc.Create(context.Background(), "g1", "fire", "uploads/g1/fire.png", false); err == nil {
		t.Fatal("expected guest rejection")
	}
}

func TestEmoji_Create_StoreError(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{
		"uploads/u1/fire.png": "https://fresh.example/fire.png",
	}})
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	emojis.createErr = errors.New("boom") // generic, non-AlreadyExists
	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png", false); err == nil {
		t.Fatal("expected create error")
	}
}

func TestEmoji_ValidateImageObject_ReadError(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	svc.SetSigner(&fakeEmojiSigner{readErr: errors.New("read fail")})
	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png", false); err == nil {
		t.Fatal("expected read error")
	}
}

func TestEmoji_ValidateImageObject_EmptyData(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	svc.SetSigner(&fakeEmojiSigner{emptyBody: true})
	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png", false); err == nil {
		t.Fatal("expected empty-image rejection")
	}
}

func TestEmoji_ValidateImageObject_InvalidDecode(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	// Valid PNG signature so both declared and detected are image/png, but
	// the truncated body fails image.DecodeConfig.
	svc.SetSigner(&fakeEmojiSigner{
		contentType: "image/png",
		objectData:  "\x89PNG\r\n\x1a\n\x00\x00\x00\x00truncated",
	})
	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png", false); err == nil {
		t.Fatal("expected invalid-image (decode) rejection")
	}
}

func TestEmoji_Delete_GetByNameError(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleAdmin}
	emojis.getErr = errors.New("boom") // generic, non-NotFound
	if err := svc.Delete(context.Background(), "u1", "smile"); err == nil {
		t.Fatal("expected lookup error")
	}
}

func TestEmoji_Delete_InvalidatesCachedKey(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleAdmin}
	emojis.items["smile"] = &model.CustomEmoji{Name: "smile", CreatedBy: "u1", ImageKey: "uploads/u1/smile.png"}
	if err := svc.Delete(context.Background(), "u1", "smile"); err != nil {
		t.Fatalf("delete: %v", err)
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
