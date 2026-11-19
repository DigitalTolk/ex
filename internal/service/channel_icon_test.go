package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// iconEvents returns the payload of every channel.updated event published to
// channelID's own topic.
func iconEvents(t *testing.T, publisher *mockPublisher, channelID string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, p := range publisher.published {
		if p.event.Type != events.EventChannelUpdated || p.channel != pubsub.ChannelName(channelID) {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(p.event.Data, &payload); err != nil {
			t.Fatalf("channel.updated payload: %v", err)
		}
		out = append(out, payload)
	}
	return out
}

// An admin gives the channel an emoji, by glyph or by name, and takes it away
// again. Each change is stored and tells the channel's members; setting the
// icon the channel already has does neither.
func TestChannelService_SetIcon(t *testing.T) {
	ctx := context.Background()
	steps := []struct {
		name      string
		icon      string
		want      string
		wantEvent bool
	}{
		{name: "an emoji", icon: "🚀", want: "🚀", wantEvent: true},
		{name: "the same emoji again", icon: " 🚀 ", want: "🚀"},
		{name: "an emoji name", icon: ":Rocket:", want: "rocket", wantEvent: true},
		{name: "the same name again", icon: "rocket", want: "rocket"},
		{name: "cleared", icon: "", want: "", wantEvent: true},
		{name: "cleared again", icon: "  ", want: ""},
	}
	svc, channels, _, publisher := renameEnv(t)
	for _, step := range steps {
		publisher.published = nil
		before := channels.channels["ch-m"].UpdatedAt
		ch, err := svc.SetIcon(ctx, "user-1", "ch-m", step.icon)
		if err != nil {
			t.Fatalf("%s: SetIcon: %v", step.name, err)
		}
		if ch.Icon != step.want || channels.channels["ch-m"].Icon != step.want {
			t.Errorf("%s: icon = %q (stored %q), want %q", step.name, ch.Icon, channels.channels["ch-m"].Icon, step.want)
		}
		got := iconEvents(t, publisher, "ch-m")
		if !step.wantEvent {
			if len(publisher.published) != 0 || !channels.channels["ch-m"].UpdatedAt.Equal(before) {
				t.Errorf("%s: %d events, want a quiet no-op that writes nothing", step.name, len(publisher.published))
			}
			continue
		}
		if len(got) != 1 {
			t.Fatalf("%s: channel.updated events = %v, want one", step.name, got)
		}
		if got[0]["channelID"] != "ch-m" || got[0]["icon"] != step.want || got[0]["name"] != "marketing" || got[0]["slug"] != "marketing" || got[0]["description"] != "ads" {
			t.Errorf("%s: channel.updated = %v, want the channel with icon %q", step.name, got[0], step.want)
		}
		if ch.UpdatedAt.IsZero() {
			t.Errorf("%s: UpdatedAt was not stamped", step.name)
		}
	}
}

func TestChannelService_SetIconRefusals(t *testing.T) {
	ctx := context.Background()
	errDynamoDown := errors.New("dynamo down")
	cases := []struct {
		name    string
		actor   string
		icon    string
		arrange func(channels *mockChannelStore, memberships *mockMembershipStore)
		wantErr error
	}{
		{
			name:  "a plain member",
			actor: "user-2",
			icon:  "🚀",
			arrange: func(_ *mockChannelStore, memberships *mockMembershipStore) {
				memberships.memberships["ch-m#user-2"] = &model.ChannelMembership{ChannelID: "ch-m", UserID: "user-2", Role: model.ChannelRoleMember}
			},
			wantErr: ErrForbidden,
		},
		{name: "someone outside the channel", actor: "user-3", icon: "🚀", wantErr: ErrForbidden},
		{name: "plain text", actor: "user-1", icon: "launch day!", wantErr: ErrValidation},
		{name: "an emoji with text after it", actor: "user-1", icon: "🚀x", wantErr: ErrValidation},
		{
			name:  "an archived channel",
			actor: "user-1",
			icon:  "🚀",
			arrange: func(channels *mockChannelStore, _ *mockMembershipStore) {
				channels.channels["ch-m"].Archived = true
			},
			wantErr: ErrChannelArchived,
		},
		{
			name:  "a failed read",
			actor: "user-1",
			icon:  "🚀",
			arrange: func(channels *mockChannelStore, _ *mockMembershipStore) {
				channels.getErr = errDynamoDown
			},
			wantErr: errDynamoDown,
		},
		{
			name:  "a failed write",
			actor: "user-1",
			icon:  "🚀",
			arrange: func(channels *mockChannelStore, _ *mockMembershipStore) {
				channels.updateErr = errDynamoDown
			},
			wantErr: errDynamoDown,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, channels, memberships, publisher := renameEnv(t)
			if tc.arrange != nil {
				tc.arrange(channels, memberships)
			}
			ch, err := svc.SetIcon(ctx, tc.actor, "ch-m", tc.icon)
			if !errors.Is(err, tc.wantErr) || ch != nil {
				t.Fatalf("SetIcon = %+v, %v, want %v", ch, err, tc.wantErr)
			}
			if channels.channels["ch-m"].Icon != "" {
				t.Errorf("a refused change stored the icon %q", channels.channels["ch-m"].Icon)
			}
			if len(publisher.published) != 0 {
				t.Errorf("published %d events for a refused change", len(publisher.published))
			}
		})
	}
}

// The sidebar row carries the channel's current icon, read from the channel
// itself, on both the batched and the one-by-one path.
func TestChannelService_ListUserChannelsShowsTheIcon(t *testing.T) {
	for _, batched := range []bool{false, true} {
		svc, channels, memberships, _, _ := setupChannelService()
		channels.channels["ch-m"] = &model.Channel{ID: "ch-m", Name: "marketing", Slug: "marketing", Icon: "🚀"}
		channels.channels["ch-s"] = &model.Channel{ID: "ch-s", Name: "sales", Slug: "sales"}
		memberships.userChannels = []*model.UserChannel{
			{UserID: "user-1", ChannelID: "ch-m", ChannelName: "marketing"},
			{UserID: "user-1", ChannelID: "ch-s", ChannelName: "sales"},
		}
		if batched {
			svc.channels = &batchMockChannelStore{mockChannelStore: channels}
		}
		rows, err := svc.ListUserChannels(context.Background(), "user-1")
		if err != nil || len(rows) != 2 {
			t.Fatalf("batched=%v: rows = %+v, err %v, want both channels", batched, rows, err)
		}
		icons := map[string]string{}
		for _, row := range rows {
			icons[row.ChannelID] = row.Icon
		}
		if icons["ch-m"] != "🚀" || icons["ch-s"] != "" {
			t.Errorf("batched=%v: icons = %v, want the rocket on ch-m only", batched, icons)
		}
	}
}
