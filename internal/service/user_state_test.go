package service

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// mockUserStateStore is mutex-guarded: the notify path persists thread
// markers for many recipients in bounded-parallel goroutines.
type mockUserStateStore struct {
	mu        sync.Mutex
	rows      map[string]*model.UserStateItem
	setErr    error
	deleteErr error
	listErr   error
}

func newMockUserStateStore() *mockUserStateStore {
	return &mockUserStateStore{rows: map[string]*model.UserStateItem{}}
}

func (m *mockUserStateStore) key(userID string, kind model.UserStateKind, targetID string) string {
	return userID + "#" + string(kind) + "#" + targetID
}

func (m *mockUserStateStore) SetUserState(_ context.Context, item *model.UserStateItem) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.setErr != nil {
		return m.setErr
	}
	cp := *item
	m.rows[m.key(item.UserID, item.Kind, item.TargetID)] = &cp
	return nil
}

func (m *mockUserStateStore) DeleteUserState(_ context.Context, userID string, kind model.UserStateKind, targetID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.rows, m.key(userID, kind, targetID))
	return nil
}

func (m *mockUserStateStore) ListUserState(_ context.Context, userID string) ([]*model.UserStateItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.listErr != nil {
		return nil, m.listErr
	}
	out := make([]*model.UserStateItem, 0)
	for _, row := range m.rows {
		if row.UserID != userID {
			continue
		}
		cp := *row
		out = append(out, &cp)
	}
	return out, nil
}

func TestUserStateService_ErrorsAndNilInputs(t *testing.T) {
	ctx := context.Background()
	empty, err := NewUserStateService(nil, nil).List(ctx, "")
	if err != nil {
		t.Fatalf("nil List: %v", err)
	}
	if len(empty.ThreadNotifications) != 0 || len(empty.HiddenConversations) != 0 {
		t.Fatalf("nil List state = %#v", empty)
	}

	store := newMockUserStateStore()
	store.listErr = assertErr("list")
	if _, err := NewUserStateService(store, nil).List(ctx, "u-1"); err == nil {
		t.Fatal("expected list error")
	}
	store = newMockUserStateStore()
	store.setErr = assertErr("set")
	if err := NewUserStateService(store, nil).HideConversation(ctx, "u-1", "conv-1"); err == nil {
		t.Fatal("expected set error")
	}
	if err := NewUserStateService(store, nil).MarkThreadSeen(ctx, "u-1", "ch-1", ParentChannel, "root-1"); err == nil {
		t.Fatal("expected mark thread seen set error")
	}
	store = newMockUserStateStore()
	store.deleteErr = assertErr("delete")
	if err := NewUserStateService(store, nil).UnhideConversation(ctx, "u-1", "conv-1"); err == nil {
		t.Fatal("expected delete error")
	}

	// Empty target/user IDs short-circuit set/delete before touching the
	// store — no error, and the injected store errors are never reached.
	guard := newMockUserStateStore()
	guard.setErr = assertErr("set")
	guard.deleteErr = assertErr("delete")
	svc := NewUserStateService(guard, nil)
	if err := svc.HideConversation(ctx, "u-1", ""); err != nil {
		t.Fatalf("empty-target Hide should no-op, got %v", err)
	}
	if err := svc.UnhideConversation(ctx, "", "conv-1"); err != nil {
		t.Fatalf("empty-user Unhide should no-op, got %v", err)
	}
}

type assertErr string

func (e assertErr) Error() string { return string(e) }

func TestUserStateService_ListAndMutations(t *testing.T) {
	ctx := context.Background()
	store := newMockUserStateStore()
	publisher := newMockPublisher()
	svc := NewUserStateService(store, publisher)

	if err := svc.MarkThreadNotificationUnread(ctx, "u-1", "conv-1", ParentConversation, "root-1"); err != nil {
		t.Fatalf("MarkThreadNotificationUnread: %v", err)
	}
	if len(publisher.published) == 0 {
		t.Fatal("expected user state change event")
	}
	// A second thread notification that is never marked seen, so it survives
	// into List and exercises the ThreadNotification case of the switch.
	if err := svc.MarkThreadNotificationUnread(ctx, "u-1", "conv-1", ParentConversation, "root-2"); err != nil {
		t.Fatalf("MarkThreadNotificationUnread root-2: %v", err)
	}
	if err := svc.HideConversation(ctx, "u-1", "conv-1"); err != nil {
		t.Fatalf("HideConversation: %v", err)
	}
	beforeSeen := time.Now()
	if err := svc.MarkThreadSeen(ctx, "u-1", "conv-1", ParentConversation, "root-1"); err != nil {
		t.Fatalf("MarkThreadSeen: %v", err)
	}
	afterSeen := time.Now()

	state, err := svc.List(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got := state.ThreadNotifications; len(got) != 1 || got[0] != "root-2" {
		t.Fatalf("thread notifications = %#v, want [root-2] after seen", got)
	}
	gotSeen, err := time.Parse(time.RFC3339Nano, state.ThreadSeen["root-1"])
	if err != nil {
		t.Fatalf("thread seen parse: %v", err)
	}
	if gotSeen.Before(beforeSeen) || gotSeen.After(afterSeen) {
		t.Fatalf("thread seen = %s, want server time between %s and %s", gotSeen, beforeSeen, afterSeen)
	}
	if got := state.HiddenConversations; len(got) != 1 || got[0] != "conv-1" {
		t.Fatalf("hidden conversations = %#v", got)
	}

	if err := svc.UnhideConversation(ctx, "u-1", "conv-1"); err != nil {
		t.Fatalf("UnhideConversation: %v", err)
	}
	state, err = svc.List(ctx, "u-1")
	if err != nil {
		t.Fatalf("List after clear: %v", err)
	}
	if len(state.HiddenConversations) != 0 {
		t.Fatalf("state after clear = %#v", state)
	}
}
