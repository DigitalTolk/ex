package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// archivedChannelFixture is a channel with an owner and a member.
func archivedChannelFixture(archived bool) (*ChannelService, *mockChannelStore, *mockMembershipStore, *mockPublisher) {
	svc, channels, memberships, _, publisher := setupChannelService()
	channels.channels["ch-a"] = &model.Channel{ID: "ch-a", Name: "alpha", Slug: "alpha", Type: model.ChannelTypePublic, Archived: archived}
	memberships.memberships["ch-a#owner"] = &model.ChannelMembership{ChannelID: "ch-a", UserID: "owner", Role: model.ChannelRoleOwner}
	memberships.memberships["ch-a#m1"] = &model.ChannelMembership{ChannelID: "ch-a", UserID: "m1", Role: model.ChannelRoleMember, DisplayName: "Member One"}
	return svc, channels, memberships, publisher
}

func publishedTo(p *mockPublisher, eventType string) map[string]bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]bool{}
	for _, e := range p.published {
		if e.event.Type == eventType {
			out[e.channel] = true
		}
	}
	return out
}

func TestChannelService_Unarchive_RestoresAndNotifiesEveryone(t *testing.T) {
	svc, channels, _, publisher := archivedChannelFixture(true)
	if err := svc.Unarchive(context.Background(), "owner", "ch-a"); err != nil {
		t.Fatalf("Unarchive: %v", err)
	}
	if channels.channels["ch-a"].Archived {
		t.Fatal("channel still archived")
	}
	got := publishedTo(publisher, events.EventChannelUnarchived)
	for _, topic := range []string{pubsub.ChannelName("ch-a"), pubsub.UserChannel("owner"), pubsub.UserChannel("m1")} {
		if !got[topic] {
			t.Errorf("channel.unarchived not published to %s (got %v)", topic, got)
		}
	}
}

func TestChannelService_Unarchive_Rules(t *testing.T) {
	ctx := context.Background()

	// A plain member may not unarchive.
	svc, channels, _, _ := archivedChannelFixture(true)
	if err := svc.Unarchive(ctx, "m1", "ch-a"); err == nil {
		t.Fatal("member unarchived the channel")
	}
	if !channels.channels["ch-a"].Archived {
		t.Fatal("denied unarchive changed the flag")
	}

	// Unarchiving a channel that is not archived is a silent no-op: no write,
	// no event.
	svc, channels, _, publisher := archivedChannelFixture(false)
	channels.updateErr = errors.New("must not write")
	if err := svc.Unarchive(ctx, "owner", "ch-a"); err != nil {
		t.Fatalf("no-op unarchive: %v", err)
	}
	if len(publishedTo(publisher, events.EventChannelUnarchived)) != 0 {
		t.Fatal("no-op unarchive published an event")
	}
}

// Archiving twice is a no-op the second time.
func TestChannelService_Archive_Idempotent(t *testing.T) {
	svc, channels, _, publisher := archivedChannelFixture(true)
	channels.updateErr = errors.New("must not write")
	if err := svc.Archive(context.Background(), "owner", "ch-a"); err != nil {
		t.Fatalf("re-archive: %v", err)
	}
	if len(publishedTo(publisher, events.EventChannelArchived)) != 0 {
		t.Fatal("re-archive published an event")
	}
}

// An archived channel is read-only: no rename and no self-joins.
func TestChannelService_ArchivedChannelRejectsWrites(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := archivedChannelFixture(true)
	name := "renamed"
	if _, err := svc.Update(ctx, "owner", "ch-a", &name, nil); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("Update: %v, want ErrChannelArchived", err)
	}
	if err := svc.Join(ctx, "user-1", "ch-a"); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("Join: %v, want ErrChannelArchived", err)
	}
}

// Members can still add people to an archived channel (admins cannot join it
// on their own), and the add leaves its frozen history alone.
func TestChannelService_AddMemberToArchivedChannel(t *testing.T) {
	svc, _, memberships, publisher := archivedChannelFixture(true)
	if err := svc.AddMember(context.Background(), "owner", "ch-a", "user-1", model.ChannelRoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if _, ok := memberships.memberships["ch-a#user-1"]; !ok {
		t.Fatal("membership not written")
	}
	if len(publishedTo(publisher, events.EventMessageNew)) != 0 {
		t.Fatal("add posted a system message into an archived channel")
	}
	if len(publishedTo(publisher, events.EventMembersChanged)) == 0 {
		t.Fatal("members-changed event missing")
	}
}

// Leaving an archived channel still works and still tells everyone, but adds
// nothing to its frozen history.
func TestChannelService_LeaveArchivedChannel_NoSystemMessage(t *testing.T) {
	svc, _, memberships, publisher := archivedChannelFixture(true)
	if err := svc.Leave(context.Background(), "m1", "ch-a"); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if _, ok := memberships.memberships["ch-a#m1"]; ok {
		t.Fatal("membership kept after leave")
	}
	if len(publishedTo(publisher, events.EventMessageNew)) != 0 {
		t.Fatal("leave posted a system message into an archived channel")
	}
	if len(publishedTo(publisher, events.EventMembersChanged)) == 0 || len(publishedTo(publisher, events.EventChannelRemoved)) == 0 {
		t.Fatal("leave events missing")
	}
}

// Members keep opening an archived channel; a non-member of an archived
// public channel cannot get in (it can no longer be joined).
func TestChannelService_GetVisible_Archived(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := archivedChannelFixture(true)
	if ch, err := svc.GetVisibleByID(ctx, "m1", "ch-a"); err != nil || !ch.Archived {
		t.Fatalf("member GetVisibleByID = %v, %v", ch, err)
	}
	if ch, err := svc.GetVisibleBySlug(ctx, "m1", "alpha"); err != nil || ch.ID != "ch-a" {
		t.Fatalf("member GetVisibleBySlug = %v, %v", ch, err)
	}
	if _, err := svc.GetVisibleByID(ctx, "user-1", "ch-a"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-member GetVisibleByID: %v, want ErrForbidden", err)
	}
}

// ---------------------------------------------------------------------------
// MessageService: writes into an archived channel
// ---------------------------------------------------------------------------

func archivedMessageFixture(t *testing.T) (*MessageService, *mockMessageStore, *mockChannelStore) {
	t.Helper()
	svc, messages, memberships, _, _ := setupMessageService()
	channels := newMockChannelStore()
	channels.channels["ch-a"] = &model.Channel{ID: "ch-a", Archived: false}
	svc.SetChannelReader(channels)
	memberships.memberships["ch-a#user-1"] = &model.ChannelMembership{ChannelID: "ch-a", UserID: "user-1", Role: model.ChannelRoleAdmin}
	return svc, messages, channels
}

func TestMessageService_ArchivedChannelIsReadOnly(t *testing.T) {
	ctx := context.Background()
	svc, messages, channels := archivedMessageFixture(t)
	msg, err := svc.Send(ctx, "user-1", "ch-a", ParentChannel, "before archive", "")
	if err != nil {
		t.Fatalf("Send before archive: %v", err)
	}
	channels.channels["ch-a"].Archived = true

	writes := map[string]func() error{
		"send": func() error {
			_, err := svc.Send(ctx, "user-1", "ch-a", ParentChannel, "after", "")
			return err
		},
		"reply": func() error {
			_, err := svc.Send(ctx, "user-1", "ch-a", ParentChannel, "reply", msg.ID)
			return err
		},
		"edit": func() error {
			_, err := svc.Edit(ctx, "user-1", "ch-a", ParentChannel, msg.ID, "edited", nil)
			return err
		},
		"delete": func() error { return svc.Delete(ctx, "user-1", "ch-a", ParentChannel, msg.ID) },
		"react": func() error {
			_, err := svc.ToggleReaction(ctx, "user-1", "ch-a", ParentChannel, msg.ID, "👍")
			return err
		},
		"pin": func() error {
			_, err := svc.SetPinned(ctx, "user-1", "ch-a", ParentChannel, msg.ID, true)
			return err
		},
		"no-unfurl": func() error {
			_, err := svc.SetNoUnfurl(ctx, "user-1", "ch-a", ParentChannel, msg.ID, true)
			return err
		},
		"check": func() error { return svc.CheckWriteAccess(ctx, "user-1", "ch-a", ParentChannel) },
		"webhook": func() error {
			_, err := svc.SendWebhook(ctx, WebhookMessageInput{ChannelID: "ch-a", Body: "hook"})
			return err
		},
	}
	for name, write := range writes {
		if err := write(); !errors.Is(err, ErrChannelArchived) {
			t.Errorf("%s: %v, want ErrChannelArchived", name, err)
		}
	}
	stored, _ := messages.GetMessage(ctx, "ch-a", msg.ID)
	if stored.Body != "before archive" || stored.Deleted || stored.Pinned || len(stored.Reactions) != 0 {
		t.Fatalf("archived message changed: %+v", stored)
	}

	// Reading stays allowed.
	if err := svc.CheckAccess(ctx, "user-1", "ch-a", ParentChannel); err != nil {
		t.Fatalf("CheckAccess on archived channel: %v", err)
	}
}

func TestMessageService_CheckWritable_Paths(t *testing.T) {
	ctx := context.Background()
	svc, _, channels := archivedMessageFixture(t)

	// Conversations are never archived and skip the channel lookup.
	channels.getErr = errors.New("must not be read")
	if err := svc.checkWritable(ctx, "conv-1", ParentConversation); err != nil {
		t.Fatalf("conversation: %v", err)
	}
	// A failed lookup fails the write rather than letting it through.
	if err := svc.CheckWriteAccess(ctx, "user-1", "ch-a", ParentChannel); err == nil || errors.Is(err, ErrChannelArchived) {
		t.Fatalf("lookup failure: %v, want a non-archived error", err)
	}
	// A non-member is refused before the archived check.
	channels.getErr = nil
	if err := svc.CheckWriteAccess(ctx, "stranger", "ch-a", ParentChannel); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-member: %v, want ErrForbidden", err)
	}
	// Not archived: allowed.
	if err := svc.CheckWriteAccess(ctx, "user-1", "ch-a", ParentChannel); err != nil {
		t.Fatalf("writable channel: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

func TestIncomingWebhookService_ArchivedChannel(t *testing.T) {
	ctx := context.Background()
	archived := &model.Channel{ID: "ch-x", Name: "Old", Slug: "old", Archived: true}
	live := &model.Channel{ID: "ch-l", Name: "Live", Slug: "live"}
	msgSvc := NewMessageService(newMockMessageStore(), nil, nil, newMockPublisher(), nil)
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: archived.ID, LockToChannel: true, CreatedAt: time.Now()},
		"wl": {ID: "wl", ChannelID: live.ID, CreatedAt: time.Now()},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID:   map[string]*model.Channel{archived.ID: archived, live.ID: live},
		bySlug: map[string]*model.Channel{archived.Slug: archived, live.Slug: live},
	}, msgSvc, nil, "")

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hello"}); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("Execute into archived channel: %v, want ErrChannelArchived", err)
	}
	if _, err := svc.Create(ctx, asAdmin("admin"), &model.IncomingWebhook{Title: "t", ChannelID: archived.ID}); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("Create on archived channel: %v, want ErrChannelArchived", err)
	}
	if _, err := svc.Update(ctx, asAdmin("admin"), "wl", &model.IncomingWebhook{Title: "t", ChannelID: archived.ID}); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("Update onto archived channel: %v, want ErrChannelArchived", err)
	}
}
