package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// privateEnv is a public channel "marketing" owned by user-1, where user-2 is
// a plain member.
func privateEnv(t *testing.T) (*ChannelService, *mockChannelStore, *mockMessageStore, *mockPublisher, *stubChannelIndexer) {
	t.Helper()
	svc, channels, memberships, _, publisher := setupChannelService()
	msgs := newMockMessageStore()
	svc.messages = msgs
	idx := &stubChannelIndexer{}
	svc.SetIndexer(idx)
	channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "marketing", Slug: "marketing", Type: model.ChannelTypePublic}
	memberships.memberships["ch-m#user-1"] = &model.ChannelMembership{ChannelID: "ch-m", UserID: "user-1", Role: model.ChannelRoleOwner}
	memberships.memberships["ch-m#user-2"] = &model.ChannelMembership{ChannelID: "ch-m", UserID: "user-2", Role: model.ChannelRoleMember}
	return svc, channels, msgs, publisher, idx
}

func TestChannelService_MakePrivate(t *testing.T) {
	svc, channels, msgs, publisher, idx := privateEnv(t)

	ch, err := svc.MakePrivate(context.Background(), "user-1", "ch-m")
	if err != nil {
		t.Fatalf("MakePrivate: %v", err)
	}
	if ch.Type != model.ChannelTypePrivate || channels.channels["ch-m"].Type != model.ChannelTypePrivate {
		t.Errorf("type = %q (stored %q), want private", ch.Type, channels.channels["ch-m"].Type)
	}
	var payload map[string]any
	for _, p := range publisher.published {
		if p.event.Type == "channel.updated" {
			_ = json.Unmarshal(p.event.Data, &payload)
		}
	}
	if payload["type"] != "private" {
		t.Errorf("channel.updated = %v, want the new type", payload)
	}
	// Reindexed, so channel search stops offering it to non-members.
	if len(idx.indexed) != 1 || idx.indexed[0] != "ch-m" {
		t.Errorf("search reindex = %v, want ch-m", idx.indexed)
	}
	var system string
	for _, m := range msgs.messages {
		if m.System {
			system = m.Body
		}
	}
	if system != "Test User made the channel private" {
		t.Errorf("system message = %q", system)
	}

	// Already private: nothing more happens.
	publisher.published = nil
	if _, err := svc.MakePrivate(context.Background(), "user-1", "ch-m"); err != nil || len(publisher.published) != 0 {
		t.Errorf("second MakePrivate = %v with %d events, want a quiet no-op", err, len(publisher.published))
	}
}

func TestChannelService_MakePrivateRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("a plain member", func(t *testing.T) {
		svc, channels, _, _, _ := privateEnv(t)
		if _, err := svc.MakePrivate(ctx, "user-2", "ch-m"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("MakePrivate = %v, want ErrForbidden", err)
		}
		if channels.channels["ch-m"].Type != model.ChannelTypePublic {
			t.Error("a refused conversion changed the channel")
		}
	})
	t.Run("#general", func(t *testing.T) {
		svc, _, _, _, _ := privateEnv(t)
		if _, err := svc.MakePrivate(ctx, "user-1", generalChannelID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("MakePrivate = %v, want ErrForbidden", err)
		}
	})
	t.Run("an archived channel", func(t *testing.T) {
		svc, channels, _, _, _ := privateEnv(t)
		channels.channels["ch-m"].Archived = true
		if _, err := svc.MakePrivate(ctx, "user-1", "ch-m"); !errors.Is(err, ErrChannelArchived) {
			t.Fatalf("MakePrivate = %v, want ErrChannelArchived", err)
		}
	})
	t.Run("a failed read", func(t *testing.T) {
		svc, channels, _, _, _ := privateEnv(t)
		channels.getErr = errors.New("dynamo down")
		if _, err := svc.MakePrivate(ctx, "user-1", "ch-m"); err == nil {
			t.Fatal("expected the read error")
		}
	})
	t.Run("a failed write", func(t *testing.T) {
		svc, channels, _, publisher, _ := privateEnv(t)
		channels.updateErr = errors.New("dynamo down")
		if _, err := svc.MakePrivate(ctx, "user-1", "ch-m"); err == nil {
			t.Fatal("expected the write error")
		}
		if len(publisher.published) != 0 {
			t.Error("no event for a failed conversion")
		}
	})
}

// The sidebar shows the channel's current type whatever its row says.
func TestChannelService_ListUserChannelsShowsTheCurrentType(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "marketing", Type: model.ChannelTypePrivate}
	memberships.userChannels = []*model.UserChannel{{UserID: "user-1", ChannelID: "ch-m", ChannelName: "marketing", ChannelType: model.ChannelTypePublic}}
	for _, store := range []ChannelStore{channels, &batchMockChannelStore{mockChannelStore: channels}} {
		svc.channels = store
		rows, err := svc.ListUserChannels(context.Background(), "user-1")
		if err != nil || len(rows) != 1 || rows[0].ChannelType != model.ChannelTypePrivate {
			t.Errorf("rows = %+v, err %v, want the current type", rows, err)
		}
	}
}
