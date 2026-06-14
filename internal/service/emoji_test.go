package service

import (
	"context"
	"errors"
	"io"
	"strings"
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
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{
		"uploads/u1/fire.png": "https://fresh.example/fire.png?sig=new",
	}})

	e, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if e.Name != "fire" {
		t.Errorf("name=%q want fire", e.Name)
	}
	if e.CreatedBy != "u1" {
		t.Errorf("createdBy=%q want u1", e.CreatedBy)
	}
	if e.ImageURL != "https://fresh.example/fire.png?sig=new" {
		t.Errorf("imageURL=%q want server-signed URL", e.ImageURL)
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

func TestEmojiService_Create_UsesStableMediaURL(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{
		"uploads/u1/fire.png": "https://fresh.example/fire.png?sig=new",
	}})
	svc.SetMediaURLCache(newFakeMediaCache())

	e, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Stable media URLs are token-based proxy URLs, not the raw presigned URL.
	if strings.Contains(e.ImageURL, "sig=new") || e.ImageURL == "" {
		t.Fatalf("ImageURL=%q, want stable media URL", e.ImageURL)
	}
}

func TestEmojiService_Create_PresignError(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	// GetObject succeeds (objectErr nil) so validation passes, but
	// PresignedGetURL fails — exercise resolveCreateImageURL's sign-error path.
	svc.SetSigner(&fakeEmojiSigner{err: errors.New("sign failed")})

	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png"); err == nil {
		t.Fatal("expected presign error")
	}
}

func TestEmojiService_Create_GuestForbidden(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["g1"] = &model.User{ID: "g1", SystemRole: model.SystemRoleGuest}

	if _, err := svc.Create(context.Background(), "g1", "fire", "uploads/g1/fire.png"); err == nil {
		t.Fatal("expected guest error")
	}
}

func TestEmojiService_Create_InvalidName(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	if _, err := svc.Create(context.Background(), "u1", "BAD NAME", "uploads/u1/fire.png"); err == nil {
		t.Fatal("expected invalid name error")
	}
}

func TestEmojiService_Create_DuplicateName(t *testing.T) {
	svc, store, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	store.items["dupe"] = &model.CustomEmoji{Name: "dupe"}
	svc.SetSigner(&fakeEmojiSigner{urls: map[string]string{
		"uploads/u1/fire.png": "https://fresh.example/fire.png?sig=new",
	}})

	if _, err := svc.Create(context.Background(), "u1", "dupe", "uploads/u1/fire.png"); err == nil {
		t.Fatal("expected duplicate error")
	}
}

func TestEmojiService_Create_RejectsMissingOrUnownedImageKey(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	for _, key := range []string{"", "uploads/u2/fire.png"} {
		if _, err := svc.Create(context.Background(), "u1", "fire", key); err == nil {
			t.Fatalf("key %q accepted, want error", key)
		}
	}
}

func TestEmojiService_Create_RequiresServerSigner(t *testing.T) {
	svc, _, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}

	if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png"); err == nil {
		t.Fatal("expected signer error")
	}
}

func TestEmojiService_Create_RejectsInvalidImageObjects(t *testing.T) {
	tests := []struct {
		name   string
		signer *fakeEmojiSigner
	}{
		{name: "missing object", signer: &fakeEmojiSigner{objectErr: errors.New("missing")}},
		{name: "oversize", signer: &fakeEmojiSigner{objectSize: MaxEmojiImageBytes + 1}},
		{name: "svg", signer: &fakeEmojiSigner{contentType: "image/svg+xml", objectData: `<svg xmlns="http://www.w3.org/2000/svg"/>`}},
		{name: "not image", signer: &fakeEmojiSigner{contentType: "image/png", objectData: "not an image"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, _, users, _ := setupEmojiSvc()
			users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
			svc.SetSigner(tt.signer)
			if _, err := svc.Create(context.Background(), "u1", "fire", "uploads/u1/fire.png"); err == nil {
				t.Fatal("expected invalid image object to be rejected")
			}
		})
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
	urls        map[string]string
	err         error
	objectData  string
	contentType string
	objectSize  int64
	objectErr   error
	readErr     error // when set, the returned body errors on Read
	emptyBody   bool  // when set, the returned body yields zero bytes
}

// errReadCloser fails on Read to exercise the ReadAll error branch.
type errReadCloser struct{ err error }

func (e errReadCloser) Read([]byte) (int, error) { return 0, e.err }
func (e errReadCloser) Close() error             { return nil }

func (f *fakeEmojiSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.urls[key], nil
}

func (f *fakeEmojiSigner) GetObject(_ context.Context, _ string) (io.ReadCloser, string, int64, time.Time, error) {
	if f.objectErr != nil {
		return nil, "", 0, time.Time{}, f.objectErr
	}
	if f.readErr != nil {
		size := f.objectSize
		if size == 0 {
			size = 10
		}
		return errReadCloser{err: f.readErr}, "image/png", size, time.Now(), nil
	}
	if f.emptyBody {
		size := f.objectSize
		if size == 0 {
			size = 10
		}
		return io.NopCloser(strings.NewReader("")), "image/png", size, time.Now(), nil
	}
	data := f.objectData
	if data == "" {
		data = "GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
	}
	contentType := f.contentType
	if contentType == "" {
		contentType = "image/gif"
	}
	size := f.objectSize
	if size == 0 {
		size = int64(len(data))
	}
	return io.NopCloser(strings.NewReader(data)), contentType, size, time.Now(), nil
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

func TestEmojiService_List_UsesStableMediaURLWhenConfigured(t *testing.T) {
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
	svc.SetMediaURLCache(newFakeMediaCache())

	out, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d emojis, want 1", len(out))
	}
	if !strings.HasPrefix(out[0].ImageURL, "/api/v1/media/") {
		t.Fatalf("ImageURL = %q, want stable media URL", out[0].ImageURL)
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
