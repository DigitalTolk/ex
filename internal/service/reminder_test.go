package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeReminderStore struct {
	scheduled []*model.Reminder
	pending   []*model.Reminder
	due       []*model.Reminder
	cancelOK  bool
	schedErr  error
	cancelErr error
	listErr   error
	claimErr  error

	// The sync operations record what they were asked (under mu: the hooks
	// call them from their own goroutine) and answer canned.
	mu            sync.Mutex
	calls         []string
	preview       string
	cancelledN    int
	owners        []string
	syncErr       error
	cancelAllUser string
	cancelAllN    int
}

func (f *fakeReminderStore) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeReminderStore) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeReminderStore) ScheduleReminder(_ context.Context, r *model.Reminder) error {
	if f.schedErr != nil {
		return f.schedErr
	}
	f.scheduled = append(f.scheduled, r)
	return nil
}
func (f *fakeReminderStore) CancelReminder(context.Context, string, string) (bool, error) {
	return f.cancelOK, f.cancelErr
}
func (f *fakeReminderStore) ListPendingReminders(context.Context, string) ([]*model.Reminder, error) {
	return f.pending, f.listErr
}
func (f *fakeReminderStore) CancelRemindersForParent(_ context.Context, userID, parentID string) (int, error) {
	f.record("parent:" + userID + ":" + parentID)
	return f.cancelledN, f.syncErr
}
func (f *fakeReminderStore) CancelRemindersForMessages(_ context.Context, messageIDs []string) ([]string, error) {
	f.record("messages:" + strings.Join(messageIDs, ","))
	return f.owners, f.syncErr
}
func (f *fakeReminderStore) UpdateReminderPreview(_ context.Context, messageID, preview string) ([]string, error) {
	f.mu.Lock()
	f.preview = preview
	f.mu.Unlock()
	f.record("preview:" + messageID)
	return f.owners, f.syncErr
}
func (f *fakeReminderStore) CancelAllRemindersForUser(_ context.Context, userID string) (int, error) {
	f.cancelAllUser = userID
	return f.cancelAllN, f.syncErr
}
func (f *fakeReminderStore) ClaimDueReminders(context.Context, int) ([]*model.Reminder, error) {
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	out := f.due
	f.due = nil // second claim returns empty, ending ProcessDue
	return out, nil
}

type fakeMessageGetter struct {
	msg *model.Message
	err error
}

// GetMessage answers the configured message or error; with neither, the
// message simply exists (empty), as most fire-path tests need.
func (f *fakeMessageGetter) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	if f.msg == nil && f.err == nil {
		return &model.Message{ID: msgID, ParentID: parentID}, nil
	}
	return f.msg, f.err
}

type fakeAccess struct{ err error }

func (f *fakeAccess) CheckAccess(context.Context, string, string, string) error { return f.err }

type spyActivityAdder struct{ items []*model.ActivityItem }

func (s *spyActivityAdder) AddItem(_ context.Context, _ string, item *model.ActivityItem) {
	s.items = append(s.items, item)
}

type spyDirectNotifier struct{ notifs []Notification }

func (s *spyDirectNotifier) NotifyDirect(_ context.Context, _ string, n Notification) {
	s.notifs = append(s.notifs, n)
}

func newReminderSvc(t *testing.T, rs *fakeReminderStore, msg *model.Message, accessErr error) (*ReminderService, *spyActivityAdder, *spyDirectNotifier) {
	t.Helper()
	svc := NewReminderService(rs, &fakeMessageGetter{msg: msg}, &fakeAccess{err: accessErr})
	act := &spyActivityAdder{}
	notif := &spyDirectNotifier{}
	svc.SetDelivery(act, notif)
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return base }
	return svc, act, notif
}

func TestReminderService_ScheduleValidation(t *testing.T) {
	rs := &fakeReminderStore{}
	svc, _, _ := newReminderSvc(t, rs, &model.Message{ID: "m-1", Body: "hi"}, nil)
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	ctx := context.Background()

	cases := []struct {
		name string
		in   ReminderInput
	}{
		{"missing ids", ReminderInput{ParentType: ParentChannel, RemindAt: base.Add(time.Hour)}},
		{"bad parent", ReminderInput{MessageID: "m", ParentID: "p", ParentType: "x", RemindAt: base.Add(time.Hour)}},
		{"past time", ReminderInput{MessageID: "m", ParentID: "p", ParentType: ParentChannel, RemindAt: base.Add(-time.Minute)}},
		{"too far", ReminderInput{MessageID: "m", ParentID: "p", ParentType: ParentChannel, RemindAt: base.Add(400 * 24 * time.Hour)}},
	}
	for _, c := range cases {
		if _, err := svc.Schedule(ctx, "u-1", c.in); err == nil {
			t.Errorf("%s: expected error", c.name)
		}
	}
}

func TestReminderService_ScheduleAccessAndMessageErrors(t *testing.T) {
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	in := ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, RemindAt: base.Add(time.Hour)}

	denied, _, _ := newReminderSvc(t, &fakeReminderStore{}, &model.Message{ID: "m-1"}, errors.New("message: not a channel member"))
	if _, err := denied.Schedule(context.Background(), "u-1", in); err == nil {
		t.Error("access denied should error")
	}

	noMsg := NewReminderService(&fakeReminderStore{}, &fakeMessageGetter{err: store.ErrNotFound}, &fakeAccess{})
	noMsg.now = func() time.Time { return base }
	if _, err := noMsg.Schedule(context.Background(), "u-1", in); err == nil {
		t.Error("missing message should error")
	}
}

func TestReminderService_ScheduleHappyAndStoreError(t *testing.T) {
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	in := ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general", RemindAt: base.Add(time.Hour)}

	rs := &fakeReminderStore{}
	svc, _, _ := newReminderSvc(t, rs, &model.Message{ID: "m-1", Body: "remember me"}, nil)
	r, err := svc.Schedule(context.Background(), "u-1", in)
	if err != nil || r == nil {
		t.Fatalf("Schedule = %v, %v", r, err)
	}
	if len(rs.scheduled) != 1 || rs.scheduled[0].MessagePreview != "remember me" || rs.scheduled[0].UserID != "u-1" {
		t.Fatalf("scheduled reminder wrong: %+v", rs.scheduled)
	}

	errStore := &fakeReminderStore{schedErr: errors.New("redis down")}
	failSvc, _, _ := newReminderSvc(t, errStore, &model.Message{ID: "m-1"}, nil)
	if _, err := failSvc.Schedule(context.Background(), "u-1", in); err == nil {
		t.Error("store error should propagate")
	}
}

func TestReminderService_CancelAndList(t *testing.T) {
	ctx := context.Background()
	okStore := &fakeReminderStore{cancelOK: true, pending: []*model.Reminder{{ID: "r1"}}}
	svc, _, _ := newReminderSvc(t, okStore, nil, nil)
	if err := svc.Cancel(ctx, "u-1", "r1"); err != nil {
		t.Fatalf("Cancel = %v", err)
	}
	list, err := svc.ListPending(ctx, "u-1")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListPending = %v, %v", list, err)
	}

	missStore := &fakeReminderStore{cancelOK: false}
	missSvc, _, _ := newReminderSvc(t, missStore, nil, nil)
	if err := missSvc.Cancel(ctx, "u-1", "gone"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Cancel missing = %v, want ErrNotFound", err)
	}

	errStore := &fakeReminderStore{cancelErr: errors.New("boom")}
	errSvc, _, _ := newReminderSvc(t, errStore, nil, nil)
	if err := errSvc.Cancel(ctx, "u-1", "r"); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Cancel store error = %v", err)
	}
}

func TestReminderService_ProcessDueFires(t *testing.T) {
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	rs := &fakeReminderStore{due: []*model.Reminder{
		{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general", MessagePreview: "look at this"},
		{ID: "r2", UserID: "u-2", MessageID: "m-2", ParentID: "conv-9", ParentType: ParentConversation},
	}}
	svc, act, notif := newReminderSvc(t, rs, nil, nil)

	n, err := svc.ProcessDue(context.Background())
	if err != nil || n != 2 {
		t.Fatalf("ProcessDue = %d, %v", n, err)
	}
	if len(act.items) != 2 || act.items[0].Type != model.ActivityReminder {
		t.Fatalf("expected 2 reminder activity items, got %+v", act.items)
	}
	if len(notif.notifs) != 2 || notif.notifs[0].Kind != NotificationKindReminder {
		t.Fatalf("expected 2 reminder notifications, got %+v", notif.notifs)
	}
	// Channel reminder deep-links by slug; conversation reminder with empty
	// preview gets the fallback body.
	if notif.notifs[0].DeepLink != "/channel/general#msg-m-1" {
		t.Fatalf("channel deep link = %q", notif.notifs[0].DeepLink)
	}
	if notif.notifs[1].DeepLink != "/conversation/conv-9#msg-m-2" {
		t.Fatalf("conversation deep link = %q", notif.notifs[1].DeepLink)
	}
	if notif.notifs[1].Body == "" {
		t.Fatalf("empty-preview reminder should have a fallback body")
	}
	// Each alert is keyed by its reminder, not the message: the user may
	// already have been alerted about that message, and a message-keyed
	// reminder would be deduped away on desktop and mobile.
	if notif.notifs[0].AlertID != "r1" || notif.notifs[1].AlertID != "r2" || notif.notifs[0].MessageID != "m-1" {
		t.Fatalf("alert identity = %+v, want AlertID per reminder and MessageID kept", notif.notifs)
	}
	_ = base
}

func TestReminderService_ProcessDueClaimError(t *testing.T) {
	rs := &fakeReminderStore{claimErr: errors.New("claim boom")}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)
	if _, err := svc.ProcessDue(context.Background()); err == nil {
		t.Error("claim error should propagate")
	}
}

// The deep link matches the client's buildChannelHref / buildConversationHref:
// a channel by slug (id when unknown), a conversation by id, and a thread
// reply opening its thread — a reply never renders in the main list, so a
// link without ?thread= landed on the parent with nothing to show.
func TestReminderDeepLink(t *testing.T) {
	cases := []struct {
		name string
		r    model.Reminder
		want string
	}{
		{"channel by slug", model.Reminder{ParentType: ParentChannel, ParentID: "ch-1", ChannelSlug: "general", MessageID: "m-1"}, "/channel/general#msg-m-1"},
		{"channel slug fallback", model.Reminder{ParentType: ParentChannel, ParentID: "ch-1", MessageID: "m-1"}, "/channel/ch-1#msg-m-1"},
		{"conversation", model.Reminder{ParentType: ParentConversation, ParentID: "dm-1", MessageID: "m-1"}, "/conversation/dm-1#msg-m-1"},
		{"channel thread reply", model.Reminder{ParentType: ParentChannel, ParentID: "ch-1", ChannelSlug: "general", MessageID: "m-2", ParentMessageID: "m-1"}, "/channel/general?thread=m-1#msg-m-2"},
		{"conversation thread reply", model.Reminder{ParentType: ParentConversation, ParentID: "dm-1", MessageID: "m-2", ParentMessageID: "m-1"}, "/conversation/dm-1?thread=m-1#msg-m-2"},
	}
	for _, c := range cases {
		if got := reminderDeepLink(&c.r); got != c.want {
			t.Errorf("%s: deep link = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestReminderService_FireWithoutDelivery(t *testing.T) {
	// A reminder service with no delivery wired still drains the queue safely.
	rs := &fakeReminderStore{due: []*model.Reminder{{ID: "r1", UserID: "u-1"}}}
	svc := NewReminderService(rs, &fakeMessageGetter{}, &fakeAccess{})
	svc.now = func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) }
	if n, err := svc.ProcessDue(context.Background()); err != nil || n != 1 {
		t.Fatalf("ProcessDue without delivery = %d, %v", n, err)
	}
}

type perUserAccess map[string]error

func (p perUserAccess) CheckAccess(_ context.Context, userID, _, _ string) error { return p[userID] }

// A reminder whose owner has since left (or been removed from, or seen
// archived) its channel is dropped: the alert would open "access denied".
// A check that merely failed still fires — losing a reminder is worse.
func TestReminderService_DropsReminderOwnerCanNoLongerOpen(t *testing.T) {
	rs := &fakeReminderStore{due: []*model.Reminder{
		{ID: "r1", UserID: "u-left", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "ops"},
		{ID: "r2", UserID: "u-flaky", MessageID: "m-2", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "ops"},
		{ID: "r3", UserID: "u-member", MessageID: "m-3", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "ops"},
	}}
	svc := NewReminderService(rs, &fakeMessageGetter{}, perUserAccess{
		"u-left":  fmt.Errorf("message: not a channel member: %w", ErrForbidden),
		"u-flaky": errors.New("dynamo timeout"),
	})
	act, notif := &spyActivityAdder{}, &spyDirectNotifier{}
	svc.SetDelivery(act, notif)

	if n, err := svc.ProcessDue(context.Background()); err != nil || n != 3 {
		t.Fatalf("ProcessDue = %d, %v; want all 3 claimed", n, err)
	}
	if len(notif.notifs) != 2 || notif.notifs[0].AlertID != "r2" || notif.notifs[1].AlertID != "r3" {
		t.Fatalf("alerts = %+v, want r2 and r3 only", notif.notifs)
	}
	if len(act.items) != 2 {
		t.Fatalf("activity items = %d, want 2 (none for the dropped reminder)", len(act.items))
	}
}

// remindersChanged lists, in order, the users sent a reminders.changed nudge.
func remindersChanged(pub *mockPublisher) []string {
	pub.mu.Lock()
	defer pub.mu.Unlock()
	var users []string
	for _, p := range pub.published {
		if p.event.Type == events.EventRemindersChanged {
			users = append(users, strings.TrimPrefix(p.channel, "user:"))
		}
	}
	return users
}

// A reminder set or cancelled on one device must show on the others, so each
// successful change tells the owner's clients; a failed one tells nobody.
func TestReminderService_ReportsScheduleAndCancel(t *testing.T) {
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	in := ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, RemindAt: base.Add(time.Hour)}

	rs := &fakeReminderStore{cancelOK: true}
	svc, _, _ := newReminderSvc(t, rs, &model.Message{ID: "m-1"}, nil)
	pub := newMockPublisher()
	svc.SetPublisher(pub)
	if _, err := svc.Schedule(ctx, "u-1", in); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if err := svc.Cancel(ctx, "u-1", "r1"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if got := remindersChanged(pub); len(got) != 2 || got[0] != "u-1" || got[1] != "u-1" {
		t.Fatalf("reminders.changed to %v, want u-1 twice", got)
	}

	rs.cancelOK = false
	_ = svc.Cancel(ctx, "u-1", "gone")
	rs.schedErr = errors.New("redis down")
	_, _ = svc.Schedule(ctx, "u-1", in)
	if got := remindersChanged(pub); len(got) != 2 {
		t.Fatalf("a failed change must not be reported, got %v", got)
	}
}

// A reminder carries a copy of its message's text: losing the channel takes
// it, and the owner's devices are told. Nothing cancelled, or a failed
// cleanup, tells nobody.
func TestReminderService_ParentLeftCancelsAndReports(t *testing.T) {
	ctx := context.Background()
	rs := &fakeReminderStore{cancelledN: 2}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)
	pub := newMockPublisher()
	svc.SetPublisher(pub)
	svc.ParentLeft(ctx, "u-1", "ch-1")
	waitForCond(t, func() bool { return len(remindersChanged(pub)) == 1 }, "owner told")
	if got := rs.recorded(); len(got) != 1 || got[0] != "parent:u-1:ch-1" {
		t.Fatalf("store calls = %v", got)
	}

	for _, quiet := range []*fakeReminderStore{{}, {syncErr: errors.New("redis down")}} {
		svc, _, _ := newReminderSvc(t, quiet, nil, nil)
		pub := newMockPublisher()
		svc.SetPublisher(pub)
		svc.ParentLeft(ctx, "u-1", "ch-1")
		waitForCond(t, func() bool { return len(quiet.recorded()) == 1 }, "cleanup ran")
		time.Sleep(20 * time.Millisecond)
		if got := remindersChanged(pub); len(got) != 0 {
			t.Fatalf("nothing changed, nothing to tell; got %v", got)
		}
	}
}

// Deleting messages takes every pending reminder about them, whoever set it;
// each owner is told. An empty delete does nothing.
func TestReminderService_MessagesDeletedCancelsAndReports(t *testing.T) {
	ctx := context.Background()
	rs := &fakeReminderStore{owners: []string{"u-1", "u-2"}}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)
	pub := newMockPublisher()
	svc.SetPublisher(pub)
	svc.MessagesDeleted(ctx, "ch-1", ParentChannel, nil)
	svc.MessagesDeleted(ctx, "ch-1", ParentChannel, []string{"m-1", "m-2"})
	waitForCond(t, func() bool { return len(remindersChanged(pub)) == 2 }, "owners told")
	if got := rs.recorded(); len(got) != 1 || got[0] != "messages:m-1,m-2" {
		t.Fatalf("store calls = %v, want one cancel for both messages", got)
	}

	failing := &fakeReminderStore{owners: []string{"u-1"}, syncErr: errors.New("redis down")}
	svc2, _, _ := newReminderSvc(t, failing, nil, nil)
	pub2 := newMockPublisher()
	svc2.SetPublisher(pub2)
	svc2.MessagesDeleted(ctx, "ch-1", ParentChannel, []string{"m-1"})
	waitForCond(t, func() bool { return len(failing.recorded()) == 1 }, "cleanup ran")
	time.Sleep(20 * time.Millisecond)
	if got := remindersChanged(pub2); len(got) != 0 {
		t.Fatalf("a failed cleanup must not claim a change; got %v", got)
	}
}

// Text edited out of a message must not live on in a reminder's preview.
func TestReminderService_MessageEditedRefreshesPreview(t *testing.T) {
	ctx := context.Background()
	rs := &fakeReminderStore{owners: []string{"u-2"}}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)
	pub := newMockPublisher()
	svc.SetPublisher(pub)
	svc.MessageEdited(ctx, &model.Message{ID: "m-1", ParentID: "ch-1", Body: "  the   corrected\n text "}, ParentChannel)
	waitForCond(t, func() bool { return len(remindersChanged(pub)) == 1 }, "owner told")
	rs.mu.Lock()
	preview := rs.preview
	rs.mu.Unlock()
	if preview != "the corrected text" || rs.recorded()[0] != "preview:m-1" {
		t.Fatalf("preview = %q, calls = %v", preview, rs.recorded())
	}

	failing := &fakeReminderStore{owners: []string{"u-2"}, syncErr: errors.New("redis down")}
	svc2, _, _ := newReminderSvc(t, failing, nil, nil)
	pub2 := newMockPublisher()
	svc2.SetPublisher(pub2)
	svc2.MessageEdited(ctx, &model.Message{ID: "m-1"}, ParentChannel)
	waitForCond(t, func() bool { return len(failing.recorded()) == 1 }, "refresh ran")
	time.Sleep(20 * time.Millisecond)
	if got := remindersChanged(pub2); len(got) != 0 {
		t.Fatalf("a failed refresh must not claim a change; got %v", got)
	}
}

type messagesByID map[string]*model.Message

func (m messagesByID) GetMessage(_ context.Context, _, msgID string) (*model.Message, error) {
	if msg, ok := m[msgID]; ok {
		return msg, nil
	}
	if msgID == "m-unreadable" {
		return nil, errors.New("dynamo timeout")
	}
	return nil, store.ErrNotFound
}

// A reminder fires about the message as it is now: deleted since (gone, or
// soft-deleted) drops it, edited since fires with the new text — even when the
// delete/edit sync never reached it. A message that can't be read fires with
// the stored preview rather than being lost.
func TestReminderService_FireRereadsTheMessage(t *testing.T) {
	due := func(id, msgID string) *model.Reminder {
		return &model.Reminder{ID: id, UserID: "u-1", MessageID: msgID, ParentID: "ch-1", ParentType: ParentChannel, MessagePreview: "stored text " + id}
	}
	rs := &fakeReminderStore{due: []*model.Reminder{
		due("r-gone", "m-gone"),
		due("r-soft", "m-soft"),
		due("r-edited", "m-edited"),
		due("r-unreadable", "m-unreadable"),
	}}
	svc := NewReminderService(rs, messagesByID{
		"m-soft":   {ID: "m-soft", Deleted: true},
		"m-edited": {ID: "m-edited", Body: "  the   corrected text "},
	}, &fakeAccess{})
	act, notif := &spyActivityAdder{}, &spyDirectNotifier{}
	svc.SetDelivery(act, notif)

	if n, err := svc.ProcessDue(context.Background()); err != nil || n != 4 {
		t.Fatalf("ProcessDue = %d, %v; want all 4 claimed", n, err)
	}
	if len(notif.notifs) != 2 || notif.notifs[0].AlertID != "r-edited" || notif.notifs[1].AlertID != "r-unreadable" {
		t.Fatalf("alerts = %+v, want r-edited and r-unreadable only", notif.notifs)
	}
	if notif.notifs[0].Body != "the corrected text" || act.items[0].MessagePreview != "the corrected text" {
		t.Fatalf("edited reminder = %q / %q, want the current text", notif.notifs[0].Body, act.items[0].MessagePreview)
	}
	if notif.notifs[1].Body != "stored text r-unreadable" {
		t.Fatalf("unreadable message = %q, want the stored preview", notif.notifs[1].Body)
	}
}

// A webhook post has no body; its reminder previews the attachment summary,
// as its activity items do.
func TestReminderService_SchedulePreviewsWebhookAttachments(t *testing.T) {
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	rs := &fakeReminderStore{}
	msg := &model.Message{ID: "m-1", MessageAttachments: []model.MessageAttachment{{Fallback: "Deploy failed"}}}
	svc, _, _ := newReminderSvc(t, rs, msg, nil)
	in := ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, RemindAt: base.Add(time.Hour)}
	if _, err := svc.Schedule(context.Background(), "u-1", in); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if got := rs.scheduled[0].MessagePreview; got != "Deploy failed" {
		t.Fatalf("preview = %q, want the attachment summary", got)
	}
}

// A message deleted while the reminder menu was open answers 404 — not a
// "Reminder set" that would be dropped silently when it comes due.
func TestReminderService_ScheduleRefusesDeletedMessage(t *testing.T) {
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	rs := &fakeReminderStore{}
	svc, _, _ := newReminderSvc(t, rs, &model.Message{ID: "m-1", Deleted: true}, nil)
	in := ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, RemindAt: base.Add(time.Hour)}
	if _, err := svc.Schedule(context.Background(), "u-1", in); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Schedule = %v, want ErrNotFound", err)
	}
	if len(rs.scheduled) != 0 {
		t.Fatalf("a reminder was stored for a deleted message: %+v", rs.scheduled)
	}
}

type fakeOwnerLookup struct {
	users []*model.User
	err   error
	asked [][]string
}

func (f *fakeOwnerLookup) GetUsersByIDs(_ context.Context, ids []string) ([]*model.User, error) {
	f.asked = append(f.asked, ids)
	return f.users, f.err
}

// Every owner whose reminder left the queue — fired, or dropped because the
// message is gone — is told once that their pending list changed, so an open
// Activity panel stops listing it as scheduled. A deactivated owner's
// reminders are dropped without an alert, a push job, or an event, found with
// one batched lookup.
func TestReminderService_ProcessDueReportsOwnersAndDropsDeactivated(t *testing.T) {
	due := func(id, user, msgID string) *model.Reminder {
		return &model.Reminder{ID: id, UserID: user, MessageID: msgID, ParentID: "ch-1", ParentType: ParentChannel}
	}
	rs := &fakeReminderStore{due: []*model.Reminder{
		due("r1", "u-1", "m-1"),
		due("r2", "u-1", "m-2"),
		due("r3", "u-2", "m-gone"),
		due("r4", "u-off", "m-1"),
	}}
	svc := NewReminderService(rs, messagesByID{"m-1": {ID: "m-1"}, "m-2": {ID: "m-2"}}, &fakeAccess{})
	act, notif := &spyActivityAdder{}, &spyDirectNotifier{}
	svc.SetDelivery(act, notif)
	pub := newMockPublisher()
	svc.SetPublisher(pub)
	owners := &fakeOwnerLookup{users: []*model.User{{ID: "u-1", Status: "active"}, {ID: "u-off", Status: "deactivated"}}}
	svc.SetOwnerLookup(owners)

	if n, err := svc.ProcessDue(context.Background()); err != nil || n != 4 {
		t.Fatalf("ProcessDue = %d, %v; want all 4 claimed", n, err)
	}
	if len(owners.asked) != 1 || len(owners.asked[0]) != 3 {
		t.Fatalf("owner lookups = %v, want one batched lookup of the 3 owners", owners.asked)
	}
	if len(notif.notifs) != 2 || notif.notifs[0].AlertID != "r1" || notif.notifs[1].AlertID != "r2" {
		t.Fatalf("alerts = %+v, want r1 and r2 only", notif.notifs)
	}
	got := map[string]int{}
	for _, u := range remindersChanged(pub) {
		got[u]++
	}
	if len(got) != 2 || got["u-1"] != 1 || got["u-2"] != 1 {
		t.Fatalf("reminders.changed to %v, want u-1 and u-2 once each and nothing for the deactivated owner", remindersChanged(pub))
	}
}

// A failed owner lookup still fires: a lost reminder is worse than one sent
// to an account that can't read it.
func TestReminderService_ProcessDueOwnerLookupFailureFires(t *testing.T) {
	rs := &fakeReminderStore{due: []*model.Reminder{{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel}}}
	svc := NewReminderService(rs, &fakeMessageGetter{}, &fakeAccess{})
	notif := &spyDirectNotifier{}
	svc.SetDelivery(&spyActivityAdder{}, notif)
	svc.SetOwnerLookup(&fakeOwnerLookup{err: errors.New("dynamo down")})
	if _, err := svc.ProcessDue(context.Background()); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	if len(notif.notifs) != 1 {
		t.Fatalf("alerts = %+v, want the reminder fired", notif.notifs)
	}
}

func TestReminderService_CancelAllForUser(t *testing.T) {
	rs := &fakeReminderStore{cancelAllN: 3}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)
	if err := svc.CancelAllForUser(context.Background(), "u-off"); err != nil || rs.cancelAllUser != "u-off" {
		t.Fatalf("CancelAllForUser = %v (store got %q)", err, rs.cancelAllUser)
	}
	rs.cancelAllN, rs.syncErr = 0, errors.New("redis down")
	if err := svc.CancelAllForUser(context.Background(), "u-off"); err == nil {
		t.Fatal("a store failure must surface")
	}
}
