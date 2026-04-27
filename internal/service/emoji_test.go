package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

type mockEmojiStore struct {
	items     map[string]*model.CustomEmoji
	createErr error
	getErr    error
	listErr   error
	deleteErr error
}

func newMockEmojiStore() *mockEmojiStore {
	return &mockEmojiStore{items: make(map[string]*model.CustomEmoji)}
}
func (m *mockEmojiStore) Create(_ context.Context, e *model.CustomEmoji) error {
	if m.createErr != nil {
		return m.createErr
	}
	if _, exists := m.items[e.Name]; exists {
		return store.ErrAlreadyExists
	}
	m.items[e.Name] = e
	return nil
}
func (m *mockEmojiStore) GetByName(_ context.Context, name string) (*model.CustomEmoji, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	e, ok := m.items[name]
	if !ok {
		return nil, store.ErrNotFound
	}
	return e, nil
}
func (m *mockEmojiStore) List(_ context.Context) ([]*model.CustomEmoji, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	out := make([]*model.CustomEmoji, 0, len(m.items))
	for _, e := range m.items {
		out = append(out, e)
	}
	return out, nil
}
func (m *mockEmojiStore) Delete(_ context.Context, name string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.items, name)
	return nil
}

func TestValidateEmojiName(t *testing.T) {
	t.Parallel()

	good := []string{"smile", "thumbs_up", "a", "+1", "test-1", "abcdefghijklmnopqrstuvwxyz12345_"}
	bad := []string{"", "with space", "with.dot", "way_too_long_emoji_name_that_exceeds_the_max_limit", "name!", "MIXEDcase", string(rune(0xFF))}

	for _, n := range good {
		if err := ValidateEmojiName(n); err != nil {
			t.Errorf("ValidateEmojiName(%q) unexpected err: %v", n, err)
		}
	}
	for _, n := range bad {
		if err := ValidateEmojiName(n); err == nil {
			t.Errorf("ValidateEmojiName(%q) expected error, got nil", n)
		}
	}
}

func setupEmojiSvc() (*EmojiService, *mockEmojiStore, *mockUserStore, *mockPublisher) {
	emojis := newMockEmojiStore()
	users := newMockUserStore()
	publisher := newMockPublisher()
	return NewEmojiService(emojis, users, publisher), emojis, users, publisher
}

func TestEmojiService_Create_Member(t *testing.T) {
	svc, _, users, pub := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	e, err := svc.Create(context.Background(), "u1", "fire", "https://example.com/fire.png", "uploads/u1/fire.png")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if e.Name != "fire" {
		t.Errorf("name=%q want fire", e.Name)
	}
	if e.CreatedBy != "u1" {
		t.Errorf("createdBy=%q want u1", e.CreatedBy)
	}

	if len(pub.published) != 1 {
		t.Fatalf("expected 1 publish, got %d", len(pub.published))
	}
	if pub.published[0].channel != pubsub.GlobalEmojiEvents() {
		t.Errorf("publish channel=%q want %q", pub.published[0].channel, pubsub.GlobalEmojiEvents())
	}
	if pub.published[0].event.Type != events.EventEmojiAdded {
		t.Errorf("event type=%q want %q", pub.published[0].event.Type, events.EventEmojiAdded)
	}
}

func TestEmojiService_Create_GuestForbidden(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["g1"] = &model.User{ID: "g1", SystemRole: model.SystemRoleGuest}

	if _, err := svc.Create(context.Background(), "g1", "fire", "https://x/x.png", "k"); err == nil {
		t.Fatal("expected guest error")
	}
}

func TestEmojiService_Create_InvalidName(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	if _, err := svc.Create(context.Background(), "u1", "BAD NAME", "https://x", "k"); err == nil {
		t.Fatal("expected invalid name error")
	}
}

func TestEmojiService_Create_DuplicateName(t *testing.T) {
	svc, store, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	store.items["dupe"] = &model.CustomEmoji{Name: "dupe"}

	if _, err := svc.Create(context.Background(), "u1", "dupe", "https://x", "k"); err == nil {
		t.Fatal("expected duplicate error")
	}
}

func TestEmojiService_Create_EmptyURL(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	if _, err := svc.Create(context.Background(), "u1", "fire", "", "k"); err == nil {
		t.Fatal("expected url error")
	}
}

func TestEmojiService_List(t *testing.T) {
	svc, store, _, _ := setupEmojiSvc()
	store.items["a"] = &model.CustomEmoji{Name: "a"}
	store.items["b"] = &model.CustomEmoji{Name: "b"}

	out, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(out) != 2 {
		t.Errorf("got %d, want 2", len(out))
	}
}

func TestEmojiService_List_StoreError(t *testing.T) {
	svc, store, _, _ := setupEmojiSvc()
	store.listErr = errors.New("boom")

	if _, err := svc.List(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

type fakeEmojiSigner struct {
	urls map[string]string
	err  error
}

func (f *fakeEmojiSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.urls[key], nil
}

func TestEmojiService_List_RefreshesPresignedURLs(t *testing.T) {
	svc, store, _, _ := setupEmojiSvc()
	store.items["fire"] = &model.CustomEmoji{
		Name:     "fire",
		ImageURL: "https://expired.example/fire.png?expired=true",
		ImageKey: "uploads/u1/fire.png",
	}
	signer := &fakeEmojiSigner{urls: map[string]string{
		"uploads/u1/fire.png": "https://fresh.example/fire.png?sig=new",
	}}
	svc.SetSigner(signer)

	out, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d emojis, want 1", len(out))
	}
	if out[0].ImageURL != "https://fresh.example/fire.png?sig=new" {
		t.Errorf("ImageURL=%q, want re-signed url", out[0].ImageURL)
	}
}

func TestEmojiService_List_KeepsLegacyURLWhenKeyMissing(t *testing.T) {
	svc, store, _, _ := setupEmojiSvc()
	store.items["fire"] = &model.CustomEmoji{
		Name:     "fire",
		ImageURL: "https://stored.example/fire.png?sig=old",
	}
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{}})

	out, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if out[0].ImageURL != "https://stored.example/fire.png?sig=old" {
		t.Errorf("ImageURL=%q changed despite missing ImageKey", out[0].ImageURL)
	}
}

func TestEmojiService_List_FallsBackOnSignerError(t *testing.T) {
	svc, store, _, _ := setupEmojiSvc()
	store.items["fire"] = &model.CustomEmoji{
		Name:     "fire",
		ImageURL: "https://stored.example/fire.png?sig=stale",
		ImageKey: "uploads/u1/fire.png",
	}
	svc.SetSigner(&fakeEmojiSigner{err: errors.New("aws down")})

	out, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if out[0].ImageURL != "https://stored.example/fire.png?sig=stale" {
		t.Errorf("ImageURL=%q, expected stored fallback when signer errored", out[0].ImageURL)
	}
}

func TestEmojiService_Delete_Creator(t *testing.T) {
	svc, store, users, pub := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	store.items["fire"] = &model.CustomEmoji{Name: "fire", CreatedBy: "u1"}

	if err := svc.Delete(context.Background(), "u1", "fire"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, exists := store.items["fire"]; exists {
		t.Error("emoji not deleted")
	}
	if len(pub.published) != 1 || pub.published[0].event.Type != events.EventEmojiRemoved {
		t.Errorf("expected emoji.removed event, got %v", pub.published)
	}
}

func TestEmojiService_Delete_Admin(t *testing.T) {
	svc, store, users, _ := setupEmojiSvc()
	users.users["admin"] = &model.User{ID: "admin", SystemRole: model.SystemRoleAdmin}
	store.items["fire"] = &model.CustomEmoji{Name: "fire", CreatedBy: "other"}

	if err := svc.Delete(context.Background(), "admin", "fire"); err != nil {
		t.Fatalf("admin delete: %v", err)
	}
}

func TestEmojiService_Delete_Forbidden(t *testing.T) {
	svc, store, users, _ := setupEmojiSvc()
	users.users["u2"] = &model.User{ID: "u2", SystemRole: model.SystemRoleMember}
	store.items["fire"] = &model.CustomEmoji{Name: "fire", CreatedBy: "u1"}

	if err := svc.Delete(context.Background(), "u2", "fire"); err == nil {
		t.Fatal("expected forbidden error")
	}
}

func TestEmojiService_Delete_NotFound(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	if err := svc.Delete(context.Background(), "u1", "nope"); err == nil {
		t.Fatal("expected not found error")
	}
}
