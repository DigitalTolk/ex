package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// Do Not Disturb: turning it on stores when it ends, turning it off clears
// it, and saving the other notification settings leaves it as it was.
func TestUserService_SnoozeNotifications(t *testing.T) {
	ctx := context.Background()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1"}
	pub := newMockPublisher()
	svc := NewUserService(users, newMockCache(), nil, pub)
	inv := &recordingInvalidator{}
	svc.SetAudienceInvalidator(inv)

	before := time.Now()
	user, err := svc.SnoozeNotifications(ctx, "u1", time.Hour)
	if err != nil {
		t.Fatalf("SnoozeNotifications: %v", err)
	}
	until := user.NotificationSettings.SnoozeUntil
	if until == nil || until.Before(before.Add(time.Hour)) || until.After(time.Now().Add(time.Hour)) {
		t.Fatalf("snoozeUntil = %v, want an hour from now", until)
	}
	// A user who never saved settings keeps the defaults under the snooze.
	if user.NotificationSettings.DesktopLevel != model.NotificationLevelMentions || !user.NotificationSettings.ThreadReplies {
		t.Fatalf("settings = %+v, want the defaults", user.NotificationSettings)
	}
	if len(inv.users) != 1 || inv.users[0] != "u1" {
		t.Fatalf("audience invalidations = %v, want u1", inv.users)
	}
	// The user's own clients hear of it, with the end time.
	var payload struct {
		Settings model.NotificationSettings `json:"settings"`
	}
	last := pub.published[len(pub.published)-1]
	if last.event.Type != events.EventNotificationSettingsUpdated {
		t.Fatalf("event = %s", last.event.Type)
	}
	if err := json.Unmarshal(last.event.Data, &payload); err != nil || payload.Settings.SnoozeUntil == nil {
		t.Fatalf("event settings = %+v (%v), want snoozeUntil", payload.Settings, err)
	}

	// Saving the other settings keeps Do Not Disturb on.
	saved, err := svc.SetNotificationSettings(ctx, "u1", model.NotificationSettings{DesktopLevel: model.NotificationLevelAll, MobileLevel: model.MobileNotificationDefault})
	if err != nil {
		t.Fatalf("SetNotificationSettings: %v", err)
	}
	if got := saved.NotificationSettings; got.SnoozeUntil == nil || !got.SnoozeUntil.Equal(*until) || got.DesktopLevel != model.NotificationLevelAll {
		t.Fatalf("settings after save = %+v, want the level changed and the snooze kept", got)
	}

	// Zero turns it off, and the saved level stays.
	user, err = svc.SnoozeNotifications(ctx, "u1", 0)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := user.NotificationSettings; got.SnoozeUntil != nil || got.DesktopLevel != model.NotificationLevelAll {
		t.Fatalf("settings after resume = %+v, want no snooze and the level kept", got)
	}
}

func TestUserService_SnoozeNotifications_Refusals(t *testing.T) {
	ctx := context.Background()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1"}
	svc := NewUserService(users, newMockCache(), nil, newMockPublisher())

	for _, d := range []time.Duration{-time.Minute, MaxSnooze + time.Minute} {
		if _, err := svc.SnoozeNotifications(ctx, "u1", d); err == nil {
			t.Errorf("duration %v accepted", d)
		}
	}
	if _, err := svc.SnoozeNotifications(ctx, "nobody", time.Hour); err == nil {
		t.Error("unknown user accepted")
	}
	users.getUserErr = errors.New("dynamo down")
	if _, err := svc.SnoozeNotifications(ctx, "u1", time.Hour); err == nil {
		t.Error("store read error not surfaced")
	}
	users.getUserErr = nil
	users.updateErr = errors.New("throttled")
	if _, err := svc.SnoozeNotifications(ctx, "u1", time.Hour); err == nil {
		t.Error("store write error not surfaced")
	}
}

// While a recipient has Do Not Disturb on, a message that would alert them
// still reaches their clients (so badges and Activity move) but marked
// silent, and no phone push is scheduled. Everyone else is alerted as usual,
// and once the snooze has ended so are they.
func TestNotificationService_DoNotDisturb(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob", "u-carol")
	until := time.Now().Add(time.Hour)
	users.users["u-bob"].NotificationSettings.SnoozeUntil = &until
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	silentFor := func() map[string]bool {
		t.Helper()
		out := map[string]bool{}
		for _, p := range pub.published {
			if p.event.Type != events.EventNotificationNew {
				continue
			}
			var n model.Notification
			if err := json.Unmarshal(p.event.Data, &n); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			out[p.channel] = n.Silent
		}
		return out
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@[u-bob|Bob] deploy is out"}, ParentChannel, nil)

	got := silentFor()
	if len(got) != 2 {
		t.Fatalf("notified %v, want bob and carol", got)
	}
	for channel, silent := range got {
		bob := channel == "user:u-bob" || channel == "user.u-bob" || containsUser(channel, "u-bob")
		if silent != bob {
			t.Errorf("%s silent = %v, want %v", channel, silent, bob)
		}
	}
	if len(push.calls) != 1 || push.calls[0].userID != "u-carol" {
		t.Fatalf("phone pushes = %+v, want carol alone", push.calls)
	}

	// The snooze has ended: bob is alerted like anyone.
	ended := time.Now().Add(-time.Minute)
	users.users["u-bob"].NotificationSettings.SnoozeUntil = &ended
	pub.published, push.calls = nil, nil
	svc.NotifyForMessage(ctx, &model.Message{ID: "m2", ParentID: "ch1", AuthorID: "u-author", Body: "second"}, ParentChannel, nil)
	for channel, silent := range silentFor() {
		if silent {
			t.Errorf("%s still silent after the snooze ended", channel)
		}
	}
	if len(push.calls) != 2 {
		t.Fatalf("phone pushes after the snooze = %d, want 2", len(push.calls))
	}
}

func containsUser(channel, userID string) bool {
	return len(channel) >= len(userID) && channel[len(channel)-len(userID):] == userID
}
