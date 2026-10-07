package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// A reminder in a self-DM (a conversation whose only participant is the
// caller) must behave exactly like one in a channel or a two-person DM: it
// schedules through the REAL access check, carries the thread root for a
// reply, and fires into the activity stream + an alert whose deep link opens
// the message (inside its thread for a reply).
func TestReminderService_SelfDMBehavesLikeAnyOtherParent(t *testing.T) {
	msgSvc, messages, memberships, conversations, _ := setupMessageService()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1"}
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	conversations.conversations["self-1"] = &model.Conversation{ID: "self-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1"}}

	rs := &fakeReminderStore{}
	svc := NewReminderService(rs, messages, msgSvc)
	act := &spyActivityAdder{}
	notif := &spyDirectNotifier{}
	svc.SetDelivery(act, notif)
	base := time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return base }

	parents := []struct {
		name, parentID, parentType, slug, linkPrefix string
	}{
		{"channel", "ch-1", ParentChannel, "general", "/channel/general"},
		{"dm", "dm-1", ParentConversation, "", "/conversation/dm-1"},
		{"self-dm", "self-1", ParentConversation, "", "/conversation/self-1"},
	}
	type want struct{ threadRoot, deepLink string }
	wants := map[string]want{} // reminder ID → expected thread root + link
	for _, p := range parents {
		root := &model.Message{ID: p.name + "-root", ParentID: p.parentID, AuthorID: "u-1", Body: "note to self"}
		reply := &model.Message{ID: p.name + "-reply", ParentID: p.parentID, AuthorID: "u-1", Body: "follow up", ParentMessageID: root.ID}
		messages.messages[p.parentID+"#"+root.ID] = root
		messages.messages[p.parentID+"#"+reply.ID] = reply

		for _, m := range []*model.Message{root, reply} {
			r, err := svc.Schedule(context.Background(), "u-1", ReminderInput{
				MessageID: m.ID, ParentID: p.parentID, ParentType: p.parentType, ChannelSlug: p.slug,
				RemindAt: base.Add(20 * time.Minute),
			})
			if err != nil {
				t.Fatalf("%s: Schedule(%s) = %v", p.name, m.ID, err)
			}
			if r.ParentMessageID != m.ParentMessageID {
				t.Fatalf("%s: reminder thread root = %q, want %q", p.name, r.ParentMessageID, m.ParentMessageID)
			}
			link := p.linkPrefix + "#msg-" + m.ID
			if m.ParentMessageID != "" {
				link = p.linkPrefix + "?thread=" + m.ParentMessageID + "#msg-" + m.ID
			}
			wants[r.ID] = want{threadRoot: m.ParentMessageID, deepLink: link}
		}
	}

	rs.due = rs.scheduled
	fired, err := svc.ProcessDue(context.Background())
	if err != nil || fired != len(wants) {
		t.Fatalf("ProcessDue = %d, %v; want %d fired", fired, err, len(wants))
	}
	for i, n := range notif.notifs {
		w := wants[n.AlertID]
		if n.DeepLink != w.deepLink {
			t.Errorf("reminder %s: deep link = %q, want %q", n.AlertID, n.DeepLink, w.deepLink)
		}
		if act.items[i].ParentMessageID != w.threadRoot || act.items[i].MessageID != n.MessageID {
			t.Errorf("reminder %s: activity item = %+v, want thread root %q", n.AlertID, act.items[i], w.threadRoot)
		}
	}

	// Self-DM access is real, not a rubber stamp: another user can't set a
	// reminder on someone's self-DM, and the self-DM refuses the channel check
	// an outdated client used to send for every DM message (#270).
	selfRoot := ReminderInput{MessageID: "self-dm-root", ParentID: "self-1", ParentType: ParentConversation, RemindAt: base.Add(time.Hour)}
	if _, err := svc.Schedule(context.Background(), "u-2", selfRoot); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-participant on a self-DM = %v, want ErrForbidden", err)
	}
	selfRoot.ParentType = ParentChannel
	if _, err := svc.Schedule(context.Background(), "u-1", selfRoot); !errors.Is(err, ErrForbidden) {
		t.Errorf("self-DM filed as a channel = %v, want ErrForbidden", err)
	}
}
