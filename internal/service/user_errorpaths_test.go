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

func TestUser_Update_EmojiSkinTone(t *testing.T) {
	svc, users := newUserSvc()
	users.users["u1"] = &model.User{ID: "u1", AuthProvider: model.AuthProviderGuest}
	tone := "medium_dark"
	got, err := svc.Update(context.Background(), "u1", nil, nil, &tone)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got.EmojiSkinTone != "medium_dark" {
		t.Errorf("EmojiSkinTone = %q, want medium_dark", got.EmojiSkinTone)
	}
}

func TestUser_Update_InvalidEmojiSkinTone(t *testing.T) {
	svc, users := newUserSvc()
	users.users["u1"] = &model.User{ID: "u1", AuthProvider: model.AuthProviderGuest}
	tone := "neon"
	if _, err := svc.Update(context.Background(), "u1", nil, nil, &tone); err == nil {
		t.Fatal("expected invalid emoji skin tone error")
	}
}

func TestUser_SetStatus_DeactivateSuccess(t *testing.T) {
	svc, users := newUserSvc()
	users.users["u1"] = &model.User{ID: "u1", AuthProvider: model.AuthProviderGuest, Status: "active"}
	got, err := svc.SetStatus(context.Background(), "u1", true)
	if err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if got.Status != "deactivated" {
		t.Errorf("Status = %q, want deactivated", got.Status)
	}
}

// fakeUserSearcher returns a fixed id list for Search tests.
type fakeUserSearcher struct {
	ids []string
	err error
}

func (f fakeUserSearcher) Users(_ context.Context, _ string, _ int) ([]string, error) {
	return f.ids, f.err
}

func TestUser_Search_SkipsMissingUsers(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice", AuthProvider: model.AuthProviderGuest}
	svc := NewUserService(users, newMockCache(), nil, nil)
	svc.SetSearcher(fakeUserSearcher{ids: []string{"u1", "missing"}})
	out, err := svc.Search(context.Background(), "a", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(out) != 1 || out[0].ID != "u1" {
		t.Fatalf("expected only the resolvable user, got %v", out)
	}
}

// paginatingUserStore returns two pages from ListUsers so the sweeper's
// cursor-advance branch executes.
type paginatingUserStore struct {
	*mockUserStore
	pages [][]*model.User
	call  int
}

func (p *paginatingUserStore) ListUsers(_ context.Context, _ int, _ string) ([]*model.User, string, error) {
	if p.call >= len(p.pages) {
		return nil, "", nil
	}
	page := p.pages[p.call]
	p.call++
	next := ""
	if p.call < len(p.pages) {
		next = "cursor"
	}
	return page, next, nil
}

func TestUser_ClearExpiredStatuses_Paginates(t *testing.T) {
	inner := newMockUserStore()
	// Page-1 user looks expired in the list, but GetUser returns a fresh
	// status → the continue at line 327 fires. Page-2 advances the cursor.
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	inner.users["u1"] = &model.User{ID: "u1", UserStatus: &model.UserStatus{ClearAt: &future}}
	store := &paginatingUserStore{
		mockUserStore: inner,
		pages: [][]*model.User{
			{{ID: "u1", UserStatus: &model.UserStatus{ClearAt: &past}}},
			{},
		},
	}
	svc := NewUserService(store, newMockCache(), nil, nil)
	if _, err := svc.ClearExpiredStatuses(context.Background(), time.Now(), 10); err != nil {
		t.Fatalf("ClearExpiredStatuses: %v", err)
	}
	if store.call != 2 {
		t.Errorf("expected 2 list pages, got %d", store.call)
	}
}
