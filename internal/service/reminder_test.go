package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

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

	// The sync operations record what they were asked and answer canned.
	parentUser, parentID string
	messageIDs           []string
	preview              string
	cancelled            []string
	owners               map[string][]string
	syncErr              error
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
func (f *fakeReminderStore) CancelRemindersForParent(_ context.Context, userID, parentID string) ([]string, error) {
	f.parentUser, f.parentID = userID, parentID
	return f.cancelled, f.syncErr
}
func (f *fakeReminderStore) CancelRemindersForMessages(_ context.Context, messageIDs []string) (map[string][]string, error) {
	f.messageIDs = messageIDs
	return f.owners, f.syncErr
}
func (f *fakeReminderStore) UpdateReminderPreview(_ context.Context, messageID, preview string) (map[string][]string, error) {
	f.messageIDs, f.preview = []string{messageID}, preview
	return f.owners, f.syncErr
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

// spyReminderChanges records whose reminders were reported changed.
type spyReminderChanges struct{ users []string }

func (s *spyReminderChanges) RemindersChanged(_ context.Context, userID string) {
	s.users = append(s.users, userID)
}

// A reminder set or cancelled on one device must show on the others, so each
// successful change tells the owner's clients; a failed one tells nobody.
func TestReminderService_ReportsScheduleAndCancel(t *testing.T) {
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	in := ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, RemindAt: base.Add(time.Hour)}

	rs := &fakeReminderStore{cancelOK: true}
	svc, _, _ := newReminderSvc(t, rs, &model.Message{ID: "m-1"}, nil)
	changes := &spyReminderChanges{}
	svc.SetChangeNotifier(changes)
	if _, err := svc.Schedule(ctx, "u-1", in); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if err := svc.Cancel(ctx, "u-1", "r1"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(changes.users) != 2 || changes.users[0] != "u-1" || changes.users[1] != "u-1" {
		t.Fatalf("changes = %v, want u-1 twice", changes.users)
	}

	rs.cancelOK = false
	_ = svc.Cancel(ctx, "u-1", "gone")
	rs.schedErr = errors.New("redis down")
	_, _ = svc.Schedule(ctx, "u-1", in)
	if len(changes.users) != 2 {
		t.Fatalf("a failed change must not be reported, got %v", changes.users)
	}
}

func TestReminderService_SyncDelegatesToStore(t *testing.T) {
	ctx := context.Background()
	rs := &fakeReminderStore{cancelled: []string{"r1"}, owners: map[string][]string{"u-2": {"r2"}}}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)

	ids, err := svc.CancelForParent(ctx, "u-1", "ch-1")
	if err != nil || len(ids) != 1 || rs.parentUser != "u-1" || rs.parentID != "ch-1" {
		t.Fatalf("CancelForParent = %v, %v (store got %s/%s)", ids, err, rs.parentUser, rs.parentID)
	}
	owners, err := svc.CancelForMessages(ctx, []string{"m-1", "m-2"})
	if err != nil || len(owners["u-2"]) != 1 || len(rs.messageIDs) != 2 {
		t.Fatalf("CancelForMessages = %v, %v", owners, err)
	}
	owners, err = svc.RefreshPreview(ctx, "m-3", "new text")
	if err != nil || len(owners) != 1 || rs.messageIDs[0] != "m-3" || rs.preview != "new text" {
		t.Fatalf("RefreshPreview = %v, %v", owners, err)
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
