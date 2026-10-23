package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// recordingInvalidator records every audience change it is told about.
type recordingInvalidator struct {
	mu       sync.Mutex
	channels []string
	users    []string
}

func (r *recordingInvalidator) ChannelAudienceChanged(_ context.Context, channelID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.channels = append(r.channels, channelID)
}

func (r *recordingInvalidator) UserAudienceChanged(_ context.Context, userID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.users = append(r.users, userID)
}

func (r *recordingInvalidator) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.channels
	r.channels = nil
	return out
}

// Every write that changes who a channel alerts — or how — moves its audience
// generation on: create (owner), join, auto-join, invite, leave, remove, role
// change, mute and per-channel preferences. Even a failed write does, since
// it may still have committed.
func TestChannelService_AudienceWritesInvalidate(t *testing.T) {
	svc, _, memberships, users, _, _ := setupChannelServiceWithUsers()
	inv := &recordingInvalidator{}
	svc.SetAudienceInvalidator(inv)
	ctx := context.Background()
	users.users["owner"] = &model.User{ID: "owner", SystemRole: model.SystemRoleMember}
	users.users["u2"] = &model.User{ID: "u2"}

	ch, err := svc.Create(ctx, "owner", "alerts", model.ChannelTypePublic, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The fake keeps per-channel preferences on its user-side rows.
	memberships.userChannels = []*model.UserChannel{{UserID: "u2", ChannelID: ch.ID}}
	steps := []struct {
		name string
		run  func() error
	}{
		{"join", func() error { return svc.Join(ctx, "u2", ch.ID) }},
		{"auto-join", func() error { return svc.AutoJoinChannel(ctx, "u3", ch.ID, model.ChannelRoleMember) }},
		{"invite", func() error { return svc.AddMember(ctx, "owner", ch.ID, "u4", model.ChannelRoleMember) }},
		{"role", func() error { return svc.UpdateMemberRole(ctx, "owner", ch.ID, "u2", model.ChannelRoleAdmin) }},
		{"mute", func() error { return svc.SetMute(ctx, "u2", ch.ID, true) }},
		{"prefs", func() error { return svc.SetNotificationPrefs(ctx, "u2", ch.ID, model.ChannelNotificationOverride{}) }},
		{"remove", func() error { return svc.RemoveMember(ctx, "owner", ch.ID, "u4") }},
		{"leave", func() error { return svc.Leave(ctx, "u3", ch.ID) }},
	}
	if got := inv.take(); len(got) != 1 || got[0] != ch.ID {
		t.Fatalf("create invalidated %v, want [%s]", got, ch.ID)
	}
	for _, st := range steps {
		if err := st.run(); err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		if got := inv.take(); len(got) != 1 || got[0] != ch.ID {
			t.Fatalf("%s invalidated %v, want [%s]", st.name, got, ch.ID)
		}
	}

	memberships.setMuteErr = errors.New("timeout after commit?")
	if err := svc.SetMute(ctx, "u2", ch.ID, false); err == nil {
		t.Fatal("SetMute error not surfaced")
	}
	if got := inv.take(); len(got) != 1 {
		t.Fatalf("a failed write invalidated %v, want the channel anyway", got)
	}

}

// Changing account notification settings (levels, keywords) moves the user's
// audience generation on — also when the write reports a failure.
func TestUserService_SetNotificationSettingsInvalidatesAudience(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1"}
	svc := NewUserService(users, newMockCache(), nil, newMockPublisher())
	inv := &recordingInvalidator{}
	svc.SetAudienceInvalidator(inv)
	settings := model.NotificationSettings{DesktopLevel: model.NotificationLevelAll, MobileLevel: model.MobileNotificationDefault, Keywords: []string{"outage"}}

	if _, err := svc.SetNotificationSettings(context.Background(), "u1", settings); err != nil {
		t.Fatalf("SetNotificationSettings: %v", err)
	}
	users.updateErr = errors.New("throttled")
	if _, err := svc.SetNotificationSettings(context.Background(), "u1", settings); err == nil {
		t.Fatal("store error not surfaced")
	}
	if len(inv.users) != 2 || inv.users[0] != "u1" || inv.users[1] != "u1" {
		t.Fatalf("user invalidations = %v, want u1 twice", inv.users)
	}
}
