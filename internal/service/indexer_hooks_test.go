package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// stubMessageIndexer records every IndexMessage / DeleteMessage call.
// The hook dispatches on a goroutine, so callers wait via waitForCalls.
type stubMessageIndexer struct {
	mu        sync.Mutex
	indexed   []indexedMsg
	deleted   []string
	indexErr  error
	deleteErr error
	signal    chan struct{}
}

type indexedMsg struct {
	id         string
	parentType string
}

func newStubMessageIndexer() *stubMessageIndexer {
	return &stubMessageIndexer{signal: make(chan struct{}, 16)}
}

func (s *stubMessageIndexer) IndexMessage(_ context.Context, m *model.Message, parentType string) error {
	s.mu.Lock()
	s.indexed = append(s.indexed, indexedMsg{id: m.ID, parentType: parentType})
	s.mu.Unlock()
	s.signal <- struct{}{}
	return s.indexErr
}

func (s *stubMessageIndexer) DeleteMessage(_ context.Context, id string) error {
	s.mu.Lock()
	s.deleted = append(s.deleted, id)
	s.mu.Unlock()
	s.signal <- struct{}{}
	return s.deleteErr
}

func (s *stubMessageIndexer) waitForCalls(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-s.signal:
		case <-time.After(time.Second):
			t.Fatalf("indexer call %d/%d did not fire within 1s", i+1, n)
		}
	}
}

func TestMessageService_Send_FiresIndexer(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	idx := newStubMessageIndexer()
	svc.SetIndexer(idx)
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}

	msg, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hello", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	idx.waitForCalls(t, 1)
	if len(idx.indexed) != 1 || idx.indexed[0].id != msg.ID || idx.indexed[0].parentType != ParentChannel {
		t.Fatalf("expected IndexMessage(%s, channel) — got %+v", msg.ID, idx.indexed)
	}
}

func TestMessageService_Send_IndexErrorIsSwallowed(t *testing.T) {
	// A failure from the indexer must never propagate up to the caller —
	// the message is already persisted and the admin reindex is the
	// intended recovery path.
	svc, _, memberships, _, _ := setupMessageService()
	idx := newStubMessageIndexer()
	idx.indexErr = errors.New("opensearch is down")
	svc.SetIndexer(idx)
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}

	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", ""); err != nil {
		t.Fatalf("Send must not surface index errors, got: %v", err)
	}
	idx.waitForCalls(t, 1)
}

func TestMessageService_Edit_FiresIndexer(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	idx := newStubMessageIndexer()
	svc.SetIndexer(idx)
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}

	pre, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "first", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if _, ok := messages.messages["ch1#"+pre.ID]; !ok {
		t.Fatal("expected message to be stored")
	}
	idx.waitForCalls(t, 1)
	idx.indexed = nil

	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, pre.ID, "edited", nil); err != nil {
		t.Fatalf("Edit: %v", err)
	}
	idx.waitForCalls(t, 1)
	if len(idx.indexed) != 1 || idx.indexed[0].id != pre.ID {
		t.Fatalf("expected IndexMessage on Edit — got %+v", idx.indexed)
	}
}

func TestMessageService_Delete_FiresIndexer(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	idx := newStubMessageIndexer()
	svc.SetIndexer(idx)
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}

	pre, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "delete me", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	idx.waitForCalls(t, 1)
	if err := svc.Delete(context.Background(), "u1", "ch1", ParentChannel, pre.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	idx.waitForCalls(t, 1)
	if len(idx.deleted) != 1 || idx.deleted[0] != pre.ID {
		t.Fatalf("expected DeleteMessage(%s) — got %+v", pre.ID, idx.deleted)
	}
}

// stubChannelIndexer records IndexChannel / DeleteChannel calls.
type stubChannelIndexer struct {
	mu      sync.Mutex
	indexed []string
	deleted []string
}

func (s *stubChannelIndexer) IndexChannel(_ context.Context, ch *model.Channel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.indexed = append(s.indexed, ch.ID)
	return nil
}

func (s *stubChannelIndexer) DeleteChannel(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, id)
	return nil
}

func TestChannelService_Create_FiresIndexer(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	idx := &stubChannelIndexer{}
	svc.SetIndexer(idx)

	ch, err := svc.Create(context.Background(), "user-1", "general-2", model.ChannelTypePublic, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(idx.indexed) != 1 || idx.indexed[0] != ch.ID {
		t.Fatalf("expected IndexChannel(%s) — got %+v", ch.ID, idx.indexed)
	}
}

func TestChannelService_Update_FiresIndexer(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	idx := &stubChannelIndexer{}
	svc.SetIndexer(idx)
	channels.channels["c1"] = &model.Channel{ID: "c1", Name: "old", Type: model.ChannelTypePublic}
	memberships.memberships["c1#user-1"] = &model.ChannelMembership{ChannelID: "c1", UserID: "user-1", Role: model.ChannelRoleAdmin}

	newName := "new"
	if _, err := svc.Update(context.Background(), "user-1", "c1", &newName, nil); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(idx.indexed) != 1 || idx.indexed[0] != "c1" {
		t.Fatalf("expected IndexChannel on Update — got %+v", idx.indexed)
	}
}

// stubUserIndexer records IndexUser / DeleteUser calls.
type stubUserIndexer struct {
	mu      sync.Mutex
	indexed []string
	deleted []string
}

func (s *stubUserIndexer) IndexUser(_ context.Context, u *model.User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.indexed = append(s.indexed, u.ID)
	return nil
}

func (s *stubUserIndexer) DeleteUser(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, id)
	return nil
}

func TestUserService_Update_FiresIndexer(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{
		ID:           "u1",
		Email:        "a@example.com",
		DisplayName:  "Old",
		AuthProvider: model.AuthProviderGuest,
	}
	svc := NewUserService(users, nil, nil, nil)
	idx := &stubUserIndexer{}
	svc.SetIndexer(idx)

	newName := "New"
	if _, err := svc.Update(context.Background(), "u1", &newName, nil); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(idx.indexed) != 1 || idx.indexed[0] != "u1" {
		t.Fatalf("expected IndexUser on Update — got %+v", idx.indexed)
	}
}

type stubUserSearcher struct {
	ids []string
	err error
}

func (s *stubUserSearcher) Users(_ context.Context, _ string, _ int) ([]string, error) {
	return s.ids, s.err
}

func TestUserService_Search_RoutesThroughSearcherWhenSet(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice", Email: "a@x.com"}
	users.users["u2"] = &model.User{ID: "u2", DisplayName: "Bob", Email: "b@x.com"}
	svc := NewUserService(users, nil, nil, nil)
	svc.SetSearcher(&stubUserSearcher{ids: []string{"u2"}})

	got, err := svc.Search(context.Background(), "doesn't matter — searcher decides", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 || got[0].ID != "u2" {
		t.Fatalf("expected [u2] from searcher, got %+v", got)
	}
}

func TestUserService_Search_FallsBackOnSearcherError(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice", Email: "alice@x.com"}
	svc := NewUserService(users, nil, nil, nil)
	svc.SetSearcher(&stubUserSearcher{err: errors.New("opensearch unreachable")})

	got, err := svc.Search(context.Background(), "alice", 10)
	if err != nil {
		t.Fatalf("Search must degrade silently when searcher errors, got: %v", err)
	}
	if len(got) != 1 || got[0].ID != "u1" {
		t.Fatalf("expected fallback to in-memory hit, got %+v", got)
	}
}

type stubChannelSearcher struct {
	ids []string
}

func (s *stubChannelSearcher) Channels(_ context.Context, _ string, _ int) ([]string, error) {
	return s.ids, nil
}

func TestChannelService_SearchPublic_RoutesThroughSearcher(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	channels.channels["c1"] = &model.Channel{ID: "c1", Name: "engineering", Type: model.ChannelTypePublic}
	channels.channels["c2"] = &model.Channel{ID: "c2", Name: "design", Type: model.ChannelTypePublic}
	svc.SetSearcher(&stubChannelSearcher{ids: []string{"c2"}})

	got, err := svc.SearchPublic(context.Background(), "user-1", "des", 10)
	if err != nil {
		t.Fatalf("SearchPublic: %v", err)
	}
	if len(got) != 1 || got[0].ID != "c2" {
		t.Fatalf("expected [c2], got %+v", got)
	}
}

func TestChannelService_SearchPublic_NilSearcherReturnsNil(t *testing.T) {
	// nil-slice signals "fall back to BrowsePublic" to the caller.
	svc, _, _, _, _ := setupChannelService()
	got, err := svc.SearchPublic(context.Background(), "user-1", "anything", 10)
	if err != nil {
		t.Fatalf("SearchPublic: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil slice from no-searcher path, got %v", got)
	}
}

func TestChannelService_SearchPublic_FiltersArchivedAndPrivate(t *testing.T) {
	// Even if ES returns matching hits we must filter out archived /
	// private records — the index hasn't necessarily caught up.
	svc, channels, _, _, _ := setupChannelService()
	channels.channels["c1"] = &model.Channel{ID: "c1", Name: "old", Type: model.ChannelTypePublic, Archived: true}
	channels.channels["c2"] = &model.Channel{ID: "c2", Name: "secret", Type: model.ChannelTypePrivate}
	channels.channels["c3"] = &model.Channel{ID: "c3", Name: "public", Type: model.ChannelTypePublic}
	svc.SetSearcher(&stubChannelSearcher{ids: []string{"c1", "c2", "c3"}})

	got, err := svc.SearchPublic(context.Background(), "user-1", "x", 10)
	if err != nil {
		t.Fatalf("SearchPublic: %v", err)
	}
	if len(got) != 1 || got[0].ID != "c3" {
		t.Fatalf("expected [c3] only, got %+v", got)
	}
}
