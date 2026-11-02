package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Every client loads the custom emoji catalog, and reloads it on each emoji
// change: they share one cached copy, which keeps the image key (the image
// URLs are signed from it on every read) and is dropped by Create and Delete
// so a change shows at once.
func TestEmojiService_List_SharesOneCatalogRead(t *testing.T) {
	svc, emojis, users, _ := setupEmojiSvc()
	svc.SetCatalogCache(newMockCache())
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{"uploads/u1/fire.png": "https://cdn.example/fire.png"}})
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleAdmin}
	emojis.items["fire"] = &model.CustomEmoji{Name: "fire", ImageKey: "uploads/u1/fire.png", CreatedBy: "u1"}
	ctx := context.Background()

	for range 2 {
		got, err := svc.List(ctx)
		if err != nil || len(got) != 1 || got[0].ImageURL != "https://cdn.example/fire.png" {
			t.Fatalf("catalog = %+v (err %v), want fire with a signed URL", got, err)
		}
	}
	if emojis.listCalls != 1 {
		t.Fatalf("catalog read %d times, want 1", emojis.listCalls)
	}

	if _, err := svc.Create(ctx, "u1", "rocket", "uploads/u1/rocket.png", false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got, err := svc.List(ctx); err != nil || len(got) != 2 {
		t.Fatalf("catalog after Create = %+v (err %v), want 2", got, err)
	}
	if err := svc.Delete(ctx, "u1", "fire"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, err := svc.List(ctx); err != nil || len(got) != 1 || got[0].Name != "rocket" {
		t.Fatalf("catalog after Delete = %+v (err %v), want rocket", got, err)
	}
	if emojis.listCalls != 3 {
		t.Fatalf("catalog read %d times, want a re-read after each write", emojis.listCalls)
	}
}

// Without the cache, or with Redis down, the catalog is read from the store.
func TestEmojiService_List_Uncached(t *testing.T) {
	svc, emojis, _, _ := setupEmojiSvc()
	emojis.items["fire"] = &model.CustomEmoji{Name: "fire"}
	down := newMockCache()
	down.getErr, down.setErr = errors.New("redis down"), errors.New("redis down")
	svc.SetCatalogCache(down)
	for range 2 {
		if got, err := svc.List(context.Background()); err != nil || len(got) != 1 {
			t.Fatalf("catalog = %+v (err %v)", got, err)
		}
	}
	if emojis.listCalls != 2 {
		t.Fatalf("catalog read %d times, want every time with Redis down", emojis.listCalls)
	}
}
