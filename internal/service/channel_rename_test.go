package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// renameEnv is a channel "marketing" that user-1 administers, next to a
// channel "sales".
func renameEnv(t *testing.T) (*ChannelService, *mockChannelStore, *mockMembershipStore, *mockPublisher) {
	t.Helper()
	svc, channels, memberships, _, publisher := setupChannelService()
	channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "marketing", Slug: "marketing", Description: "ads", Type: model.ChannelTypePublic}
	channels.channels["ch-s"] = &model.Channel{ID: "ch-s", Name: "sales", Slug: "sales", Type: model.ChannelTypePublic}
	memberships.memberships["ch-m#user-1"] = &model.ChannelMembership{ChannelID: "ch-m", UserID: "user-1", Role: model.ChannelRoleAdmin}
	return svc, channels, memberships, publisher
}

func ptr(s string) *string { return &s }

func TestChannelService_RenameMovesNameAndSlug(t *testing.T) {
	svc, channels, _, publisher := renameEnv(t)
	msgs := newMockMessageStore()
	svc.messages = msgs

	ch, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("growth"), nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if ch.Name != "growth" || ch.Slug != "growth" || ch.Description != "ads" {
		t.Errorf("returned %+v, want growth/growth with the description kept", ch)
	}
	if got := channels.channels["ch-m"]; got.Name != "growth" || got.Slug != "growth" {
		t.Errorf("stored %+v, want renamed", got)
	}
	var payload map[string]any
	for _, p := range publisher.published {
		if p.event.Type == "channel.updated" {
			_ = json.Unmarshal(p.event.Data, &payload)
		}
	}
	if payload["slug"] != "growth" || payload["name"] != "growth" {
		t.Errorf("channel.updated = %v, want the new name and slug", payload)
	}
	var system string
	for _, m := range msgs.messages {
		if m.System {
			system = m.Body
		}
	}
	if system != "Test User renamed the channel from ~marketing to ~growth" {
		t.Errorf("system message = %q", system)
	}
}

func TestChannelService_RenameRefusesATakenName(t *testing.T) {
	svc, channels, _, publisher := renameEnv(t)
	if _, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("sales"), ptr("new")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Update onto a taken name = %v, want ErrAlreadyExists", err)
	}
	if got := channels.channels["ch-m"]; got.Name != "marketing" || got.Description != "ads" {
		t.Errorf("a refused rename changed the channel: %+v", got)
	}
	if len(publisher.published) != 0 {
		t.Errorf("published %d events for a refused rename", len(publisher.published))
	}
}

// Two renames racing to the same name: the pre-check passes for both, the
// store's slug lock lets only one through.
func TestChannelService_RenameLosingTheRace(t *testing.T) {
	svc, channels, _, _ := renameEnv(t)
	channels.updateErr = store.ErrAlreadyExists
	if _, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("growth"), nil); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Update = %v, want ErrAlreadyExists", err)
	}
	channels.updateErr = errors.New("dynamo down")
	if _, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("growth"), nil); err == nil || !strings.Contains(err.Error(), "channel: rename") {
		t.Fatalf("Update on a store failure = %v, want the rename error", err)
	}
}

func TestChannelService_RenameRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("the general channel keeps its name", func(t *testing.T) {
		svc, channels, memberships, _ := renameEnv(t)
		channels.channels[generalChannelID] = &model.Channel{ID: generalChannelID, Name: "general", Slug: "general"}
		memberships.memberships[generalChannelID+"#user-1"] = &model.ChannelMembership{ChannelID: generalChannelID, UserID: "user-1", Role: model.ChannelRoleOwner}
		if _, err := svc.Update(ctx, "user-1", generalChannelID, ptr("everyone"), nil); !errors.Is(err, ErrForbidden) {
			t.Fatalf("Update = %v, want ErrForbidden", err)
		}
	})
	t.Run("an invalid name", func(t *testing.T) {
		svc, _, _, _ := renameEnv(t)
		if _, err := svc.Update(ctx, "user-1", "ch-m", ptr("Not A Slug"), nil); err == nil {
			t.Fatal("expected a validation error")
		}
	})
	t.Run("an invalid description stops the rename too", func(t *testing.T) {
		svc, channels, _, _ := renameEnv(t)
		if _, err := svc.Update(ctx, "user-1", "ch-m", ptr("growth"), ptr(strings.Repeat("x", 1000))); err == nil {
			t.Fatal("expected a validation error")
		}
		if channels.channels["ch-m"].Name != "marketing" {
			t.Error("the rename was written although the description was invalid")
		}
	})
	t.Run("a failed name check", func(t *testing.T) {
		svc, channels, _, _ := renameEnv(t)
		channels.slugErr = errors.New("dynamo down")
		if _, err := svc.Update(ctx, "user-1", "ch-m", ptr("growth"), nil); err == nil || !strings.Contains(err.Error(), "check name") {
			t.Fatalf("Update = %v, want the name check error", err)
		}
	})
}

// The same name is no rename: only the description is written.
func TestChannelService_UpdateKeepingTheName(t *testing.T) {
	svc, channels, _, _ := renameEnv(t)
	msgs := newMockMessageStore()
	svc.messages = msgs
	ch, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("marketing"), ptr("ads and brand"))
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if ch.Slug != "marketing" || channels.channels["ch-m"].Description != "ads and brand" {
		t.Errorf("channel = %+v", channels.channels["ch-m"])
	}
	if len(msgs.messages) != 0 {
		t.Error("no rename, so no system message")
	}
}

func TestChannelService_NameAvailable(t *testing.T) {
	svc, _, _, _ := renameEnv(t)
	ctx := context.Background()
	for _, c := range []struct {
		name, except string
		want         bool
	}{
		{"growth", "", true},
		{"sales", "", false},
		{"sales", "ch-s", true}, // its own name, when renaming it
		{"marketing", "ch-s", false},
	} {
		got, err := svc.NameAvailable(ctx, c.name, c.except)
		if err != nil || got != c.want {
			t.Errorf("NameAvailable(%q, %q) = (%v, %v), want %v", c.name, c.except, got, err, c.want)
		}
	}
	if _, err := svc.NameAvailable(ctx, "Not A Slug", ""); err == nil {
		t.Error("an invalid name must be an error")
	}
}

// aliasingChannelStore answers a slug lookup for "old-name" with the channel
// renamed away from it, like the store's alias does.
type aliasingChannelStore struct {
	*mockChannelStore
}

func (a *aliasingChannelStore) GetChannelBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	if slug == "old-name" {
		return a.channels["ch-m"], nil
	}
	return a.mockChannelStore.GetChannelBySlug(ctx, slug)
}

// A name a channel was renamed away from is free again: the alias that keeps
// old links working gives way.
func TestChannelService_ARenamedAwayNameIsFree(t *testing.T) {
	channels := &aliasingChannelStore{mockChannelStore: newMockChannelStore()}
	channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "growth", Slug: "growth"}
	users := newMockUserStore()
	users.users["user-1"] = &model.User{ID: "user-1"}
	svc := NewChannelService(channels, newMockMembershipStore(), users, newMockMessageStore(), newMockCache(), newMockBroker(), newMockPublisher())

	if ok, err := svc.NameAvailable(context.Background(), "old-name", ""); err != nil || !ok {
		t.Fatalf("NameAvailable(old-name) = (%v, %v), want available", ok, err)
	}
	if _, err := svc.Create(context.Background(), "user-1", "old-name", model.ChannelTypePublic, ""); err != nil {
		t.Fatalf("Create over an alias: %v", err)
	}
}

// nameSyncMemberships records sidebar-row name rewrites.
type nameSyncMemberships struct {
	*mockMembershipStore
	mu      sync.Mutex
	names   map[string]string
	setErr  error
	listErr error
	done    chan struct{}
}

func (m *nameSyncMemberships) SetUserChannelName(_ context.Context, channelID, userID, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.names == nil {
		m.names = map[string]string{}
	}
	m.names[channelID+"#"+userID] = name
	if len(m.names) == 2 {
		close(m.done)
	}
	return m.setErr
}

func (m *nameSyncMemberships) ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	if m.listErr != nil {
		defer close(m.done)
		return nil, m.listErr
	}
	return m.mockMembershipStore.ListMembers(ctx, channelID)
}

func syncEnvFor(t *testing.T) (*ChannelService, *nameSyncMemberships) {
	t.Helper()
	channels := newMockChannelStore()
	channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "marketing", Slug: "marketing"}
	memberships := &nameSyncMemberships{mockMembershipStore: newMockMembershipStore(), done: make(chan struct{})}
	memberships.memberships["ch-m#user-1"] = &model.ChannelMembership{ChannelID: "ch-m", UserID: "user-1", Role: model.ChannelRoleAdmin}
	memberships.memberships["ch-m#user-2"] = &model.ChannelMembership{ChannelID: "ch-m", UserID: "user-2", Role: model.ChannelRoleMember}
	users := newMockUserStore()
	users.users["user-1"] = &model.User{ID: "user-1"}
	return NewChannelService(channels, memberships, users, newMockMessageStore(), newMockCache(), newMockBroker(), newMockPublisher()), memberships
}

func waitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the member rows were never synced")
	}
}

func TestChannelService_RenameSyncsMemberSidebarRows(t *testing.T) {
	svc, memberships := syncEnvFor(t)
	if _, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("growth"), nil); err != nil {
		t.Fatalf("Update: %v", err)
	}
	waitDone(t, memberships.done)
	memberships.mu.Lock()
	defer memberships.mu.Unlock()
	if memberships.names["ch-m#user-1"] != "growth" || memberships.names["ch-m#user-2"] != "growth" {
		t.Errorf("rows = %v, want every member's renamed", memberships.names)
	}
}

func TestChannelService_RenameSurvivesFailedRowSyncs(t *testing.T) {
	t.Run("a failed row write", func(t *testing.T) {
		svc, memberships := syncEnvFor(t)
		memberships.setErr = errors.New("dynamo down")
		if _, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("growth"), nil); err != nil {
			t.Fatalf("Update: %v", err)
		}
		waitDone(t, memberships.done)
	})
	t.Run("a failed member list", func(t *testing.T) {
		svc, memberships := syncEnvFor(t)
		memberships.listErr = errors.New("dynamo down")
		// The permission check reads the membership row, not the list.
		if _, err := svc.Update(context.Background(), "user-1", "ch-m", ptr("growth"), nil); err != nil {
			t.Fatalf("Update: %v", err)
		}
		waitDone(t, memberships.done)
	})
}

// The sidebar shows the channel's own, current name whatever its row says.
func TestChannelService_ListUserChannelsShowsTheCurrentName(t *testing.T) {
	for _, batched := range []bool{false, true} {
		svc, channels, memberships, _, _ := setupChannelService()
		channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "growth", Slug: "growth"}
		memberships.userChannels = []*model.UserChannel{{UserID: "user-1", ChannelID: "ch-m", ChannelName: "marketing"}}
		if batched {
			svc.channels = &batchMockChannelStore{mockChannelStore: channels}
		}
		rows, err := svc.ListUserChannels(context.Background(), "user-1")
		if err != nil || len(rows) != 1 || rows[0].ChannelName != "growth" {
			t.Errorf("batched=%v: rows = %+v, err %v, want the current name", batched, rows, err)
		}
	}
}

func TestChannelService_UpdateDescriptionWriteFails(t *testing.T) {
	svc, channels, _, publisher := renameEnv(t)
	channels.updateErr = errors.New("dynamo down")
	if _, err := svc.Update(context.Background(), "user-1", "ch-m", nil, ptr("new")); err == nil || !strings.Contains(err.Error(), "channel: update") {
		t.Fatalf("Update = %v, want the update error", err)
	}
	if len(publisher.published) != 0 {
		t.Errorf("published %d events for a failed update", len(publisher.published))
	}
}
