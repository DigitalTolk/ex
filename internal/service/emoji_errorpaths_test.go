package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

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

// These name the emoji :blob-fire:, which no standard emoji is called: under
// a standard name (:fire:) Create refuses the name first, and a test asserting
// only "an error" then passes without reaching the path it is about. Each one
// asserts its own failure for that reason.

func TestEmoji_Create_GetUserError(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{}})
	boom := errors.New("boom")
	users.getUserErr = boom // valid image, but user lookup fails
	if _, err := svc.Create(context.Background(), "u1", "blob-fire", "uploads/u1/fire.png", false); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the get-user error", err)
	}
}

func TestEmoji_Create_GuestRejected(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{}})
	users.users["g1"] = &model.User{ID: "g1", SystemRole: model.SystemRoleGuest}
	_, err := svc.Create(context.Background(), "g1", "blob-fire", "uploads/g1/fire.png", false)
	if msg, ok := apperr.Message(err, apperr.ErrForbidden); !ok || !strings.Contains(msg, "guests cannot upload") {
		t.Fatalf("err = %v, want the guest rejection", err)
	}
}

func TestEmoji_Create_StoreError(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{
		"uploads/u1/fire.png": "https://fresh.example/fire.png",
	}})
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	boom := errors.New("boom")
	emojis.createErr = boom // generic, non-AlreadyExists
	_, err := svc.Create(context.Background(), "u1", "blob-fire", "uploads/u1/fire.png", false)
	if !errors.Is(err, boom) || errors.Is(err, apperr.ErrAlreadyExists) {
		t.Fatalf("err = %v, want the store's create error", err)
	}
}

func TestEmoji_ValidateImageObject_ReadError(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	readFail := errors.New("read fail")
	svc.SetSigner(&fakeEmojiSigner{readErr: readFail})
	if _, err := svc.Create(context.Background(), "u1", "blob-fire", "uploads/u1/fire.png", false); !errors.Is(err, readFail) {
		t.Fatalf("err = %v, want the read error", err)
	}
}

func TestEmoji_ValidateImageObject_EmptyData(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	svc.SetSigner(&fakeEmojiSigner{emptyBody: true})
	_, err := svc.Create(context.Background(), "u1", "blob-fire", "uploads/u1/fire.png", false)
	if msg, ok := apperr.Message(err, apperr.ErrValidation); !ok || !strings.Contains(msg, "image must be 1-") {
		t.Fatalf("err = %v, want the empty-image rejection", err)
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
	_, err := svc.Create(context.Background(), "u1", "blob-fire", "uploads/u1/fire.png", false)
	if msg, ok := apperr.Message(err, apperr.ErrValidation); !ok || msg != "emoji: invalid image" {
		t.Fatalf("err = %v, want the invalid-image (decode) rejection", err)
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
