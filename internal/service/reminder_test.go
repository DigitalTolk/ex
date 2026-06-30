package service

import (
	"context"
	"errors"
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

func (f *fakeMessageGetter) GetMessage(context.Context, string, string) (*model.Message, error) {
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
	_ = base
}

func TestReminderService_ProcessDueClaimError(t *testing.T) {
	rs := &fakeReminderStore{claimErr: errors.New("claim boom")}
	svc, _, _ := newReminderSvc(t, rs, nil, nil)
	if _, err := svc.ProcessDue(context.Background()); err == nil {
		t.Error("claim error should propagate")
	}
}

func TestReminderDeepLink_ChannelFallback(t *testing.T) {
	// No slug → fall back to the channel id.
	got := reminderDeepLink(&model.Reminder{ParentType: ParentChannel, ParentID: "ch-1", MessageID: "m-1"})
	if got != "/channel/ch-1#msg-m-1" {
		t.Fatalf("fallback deep link = %q", got)
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
