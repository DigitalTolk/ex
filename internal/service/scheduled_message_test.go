package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeScheduledStore mimics the DynamoDB store's due-queue semantics in
// memory: a pending message sits at its SendAt; a claim moves it to a lease
// only if it is still where the claimer read it.
type fakeScheduledStore struct {
	mu                                                   sync.Mutex
	items                                                map[string]*model.ScheduledMessage
	dueKeys                                              map[string]string
	putErr, getErr, listErr, deleteErr, dueErr, claimErr error
	// claimLost makes every claim lose (another instance got there first).
	claimLost bool
}

func newFakeScheduledStore() *fakeScheduledStore {
	return &fakeScheduledStore{items: map[string]*model.ScheduledMessage{}, dueKeys: map[string]string{}}
}

func skey(userID, id string) string { return userID + "/" + id }

func (f *fakeScheduledStore) PutScheduledMessage(_ context.Context, m *model.ScheduledMessage) error {
	if f.putErr != nil {
		return f.putErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *m
	f.items[skey(m.UserID, m.ID)] = &cp
	f.dueKeys[skey(m.UserID, m.ID)] = ""
	if m.State == model.ScheduledMessagePending {
		f.dueKeys[skey(m.UserID, m.ID)] = store.ScheduledDueKey(m.SendAt, m.ID)
	}
	return nil
}

func (f *fakeScheduledStore) GetScheduledMessage(_ context.Context, userID, id string) (*model.ScheduledMessage, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	m, ok := f.items[skey(userID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *m
	return &cp, nil
}

func (f *fakeScheduledStore) ListScheduledMessages(_ context.Context, userID string) ([]*model.ScheduledMessage, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.ScheduledMessage
	for _, m := range f.items {
		if m.UserID == userID {
			cp := *m
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeScheduledStore) DeleteScheduledMessage(_ context.Context, userID, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.items, skey(userID, id))
	delete(f.dueKeys, skey(userID, id))
	return nil
}

func (f *fakeScheduledStore) ListDueScheduledMessages(_ context.Context, now time.Time, limit int) ([]store.DueScheduledMessage, error) {
	if f.dueErr != nil {
		return nil, f.dueErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.DueScheduledMessage
	for k, dk := range f.dueKeys {
		if dk != "" && dk <= store.ScheduledDueKey(now, "~") {
			cp := *f.items[k]
			out = append(out, store.DueScheduledMessage{ScheduledMessage: &cp, DueKey: dk})
		}
	}
	slices.SortFunc(out, func(a, b store.DueScheduledMessage) int { return strings.Compare(a.DueKey, b.DueKey) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeScheduledStore) ClaimScheduledMessage(_ context.Context, userID, id, dueKey string, leaseUntil time.Time) (bool, error) {
	if f.claimErr != nil {
		return false, f.claimErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	k := skey(userID, id)
	cur, exists := f.dueKeys[k]
	if f.claimLost || !exists || cur != dueKey {
		return false, nil
	}
	f.dueKeys[k] = store.ScheduledDueKey(leaseUntil, id)
	return true, nil
}

type fakeScheduledSender struct {
	mu        sync.Mutex
	sent      []string
	sendErr   error
	accessErr error
}

func (f *fakeScheduledSender) Send(_ context.Context, userID, parentID, _, body, parentMessageID string, _ ...string) (*model.Message, error) {
	if f.sendErr != nil {
		return nil, f.sendErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, body)
	return &model.Message{ID: fmt.Sprintf("m-%d", len(f.sent)), AuthorID: userID, ParentID: parentID, Body: body, ParentMessageID: parentMessageID}, nil
}

func (f *fakeScheduledSender) CheckAccess(context.Context, string, string, string) error {
	return f.accessErr
}

type fakeReleaser struct {
	released []string
	err      error
}

func (f *fakeReleaser) DeleteDraft(_ context.Context, _, id string) error {
	f.released = append(f.released, id)
	return f.err
}

type schedFixture struct {
	svc     *ScheduledMessageService
	st      *fakeScheduledStore
	sender  *fakeScheduledSender
	release *fakeReleaser
	pub     *mockPublisher
	now     *time.Time
}

func newSchedFixture() *schedFixture {
	now := time.Date(2026, 10, 8, 9, 0, 0, 0, time.UTC)
	fx := &schedFixture{st: newFakeScheduledStore(), sender: &fakeScheduledSender{}, release: &fakeReleaser{}, pub: newMockPublisher(), now: &now}
	fx.svc = NewScheduledMessageService(fx.st, fx.sender, fx.release, fx.pub)
	fx.svc.now = func() time.Time { return *fx.now }
	return fx
}

func (fx *schedFixture) schedule(t *testing.T, body string, in time.Duration) *model.ScheduledMessage {
	t.Helper()
	m, err := fx.svc.Schedule(context.Background(), "u-1", ScheduledMessageInput{
		ParentID: "ch-1", ParentType: ParentChannel, Body: body, AttachmentIDs: []string{"att-1"}, SendAt: fx.now.Add(in),
	})
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	return m
}

func (fx *schedFixture) changedEvents() int {
	n := 0
	for _, p := range fx.pub.published {
		if p.channel == "user:u-1" && p.event.Type == events.EventScheduledMessagesChanged {
			n++
		}
	}
	return n
}

func TestScheduledMessage_ScheduleValidates(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	in := func(mod func(*ScheduledMessageInput)) ScheduledMessageInput {
		i := ScheduledMessageInput{ParentID: "ch-1", ParentType: ParentChannel, Body: "hi", SendAt: fx.now.Add(time.Hour)}
		mod(&i)
		return i
	}
	for name, bad := range map[string]ScheduledMessageInput{
		"no parent":        in(func(i *ScheduledMessageInput) { i.ParentID = "" }),
		"bad parent type":  in(func(i *ScheduledMessageInput) { i.ParentType = "page" }),
		"past":             in(func(i *ScheduledMessageInput) { i.SendAt = fx.now.Add(-time.Minute) }),
		"too far":          in(func(i *ScheduledMessageInput) { i.SendAt = fx.now.Add(400 * 24 * time.Hour) }),
		"empty":            in(func(i *ScheduledMessageInput) { i.Body = "  " }),
		"too long":         in(func(i *ScheduledMessageInput) { i.Body = strings.Repeat("x", MaxMessageBodyChars+1) }),
		"too many uploads": in(func(i *ScheduledMessageInput) { i.AttachmentIDs = make([]string, MaxAttachmentsPerMessage+1) }),
	} {
		if _, err := fx.svc.Schedule(ctx, "u-1", bad); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: want ErrValidation, got %v", name, err)
		}
	}
	// Files alone are a message.
	if _, err := fx.svc.Schedule(ctx, "u-1", in(func(i *ScheduledMessageInput) { i.Body = ""; i.AttachmentIDs = []string{"a"} })); err != nil {
		t.Errorf("attachment-only: %v", err)
	}
	fx.sender.accessErr = ErrForbidden
	if _, err := fx.svc.Schedule(ctx, "u-1", in(func(*ScheduledMessageInput) {})); !errors.Is(err, ErrForbidden) {
		t.Errorf("no access: %v", err)
	}
	fx.sender.accessErr = nil
	fx.st.putErr = errors.New("dynamo down")
	if _, err := fx.svc.Schedule(ctx, "u-1", in(func(*ScheduledMessageInput) {})); err == nil {
		t.Error("store error: want error")
	}
}

func TestScheduledMessage_ScheduleListUpdate(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	later := fx.schedule(t, "later", 2*time.Hour)
	sooner := fx.schedule(t, "sooner", time.Hour)
	if later.State != model.ScheduledMessagePending || fx.changedEvents() != 2 {
		t.Fatalf("state %s, %d events", later.State, fx.changedEvents())
	}
	list, err := fx.svc.List(ctx, "u-1")
	if err != nil || len(list) != 2 || list[0].ID != sooner.ID {
		t.Fatalf("List = %+v, %v; want soonest first", list, err)
	}
	fx.st.listErr = errors.New("boom")
	if _, err := fx.svc.List(ctx, "u-1"); err == nil {
		t.Error("List error: want error")
	}
	fx.st.listErr = nil

	body := "edited"
	newTime := fx.now.Add(3 * time.Hour)
	m, err := fx.svc.Update(ctx, "u-1", later.ID, ScheduledMessageUpdate{Body: &body, SendAt: &newTime})
	if err != nil || m.Body != "edited" || !m.SendAt.Equal(newTime) {
		t.Fatalf("Update = %+v, %v", m, err)
	}
	if dk := fx.st.dueKeys[skey("u-1", later.ID)]; dk != store.ScheduledDueKey(newTime, later.ID) {
		t.Fatalf("not requeued at the new time: %q", dk)
	}

	tooLong, past := strings.Repeat("x", MaxMessageBodyChars+1), fx.now.Add(-time.Minute)
	for name, upd := range map[string]ScheduledMessageUpdate{"too long": {Body: &tooLong}, "past time": {SendAt: &past}} {
		if _, err := fx.svc.Update(ctx, "u-1", later.ID, upd); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := fx.svc.Update(ctx, "u-1", "nope", ScheduledMessageUpdate{Body: &body}); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
	fx.st.claimLost = true
	if _, err := fx.svc.Update(ctx, "u-1", later.ID, ScheduledMessageUpdate{Body: &body}); !errors.Is(err, ErrScheduledBusy) {
		t.Errorf("being sent: %v", err)
	}
	fx.st.claimLost = false
	fx.st.claimErr = errors.New("claim boom")
	if _, err := fx.svc.Update(ctx, "u-1", later.ID, ScheduledMessageUpdate{Body: &body}); err == nil {
		t.Error("claim error: want error")
	}
	fx.st.claimErr = nil
	fx.st.putErr = errors.New("put boom")
	if _, err := fx.svc.Update(ctx, "u-1", later.ID, ScheduledMessageUpdate{Body: &body}); err == nil {
		t.Error("put error: want error")
	}
}

func TestScheduledMessage_FailedMessageRescheduledByNewTime(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	m := fx.schedule(t, "x", time.Hour)
	m.State, m.FailReason = model.ScheduledMessageFailed, "nope"
	_ = fx.st.PutScheduledMessage(ctx, m)

	body := "fixed"
	got, err := fx.svc.Update(ctx, "u-1", m.ID, ScheduledMessageUpdate{Body: &body})
	if err != nil || got.State != model.ScheduledMessageFailed || fx.st.dueKeys[skey("u-1", m.ID)] != "" {
		t.Fatalf("text edit must leave it failed and unqueued: %+v, %v", got, err)
	}
	at := fx.now.Add(time.Hour)
	got, err = fx.svc.Update(ctx, "u-1", m.ID, ScheduledMessageUpdate{SendAt: &at})
	if err != nil || got.State != model.ScheduledMessagePending || got.FailReason != "" {
		t.Fatalf("new time must schedule it again: %+v, %v", got, err)
	}
}

func TestScheduledMessage_DeleteReleasesFiles(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	m := fx.schedule(t, "x", time.Hour)
	fx.release.err = errors.New("in use by a sent message")
	if err := fx.svc.Delete(ctx, "u-1", m.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := fx.st.GetScheduledMessage(ctx, "u-1", m.ID); !errors.Is(err, store.ErrNotFound) || fx.release.released[0] != "att-1" {
		t.Fatalf("not deleted / files not released: %v %v", err, fx.release.released)
	}
	if err := fx.svc.Delete(ctx, "u-1", m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("twice: %v", err)
	}
	m2 := fx.schedule(t, "y", time.Hour)
	fx.st.claimLost = true
	if err := fx.svc.Delete(ctx, "u-1", m2.ID); !errors.Is(err, ErrScheduledBusy) {
		t.Errorf("being sent: %v", err)
	}
	fx.st.claimLost = false
	fx.st.deleteErr = errors.New("boom")
	if err := fx.svc.Delete(ctx, "u-1", m2.ID); err == nil {
		t.Error("delete error: want error")
	}
	// Without a releaser it just deletes.
	fx.st.deleteErr = nil
	fx.svc.attachments = nil
	m3 := fx.schedule(t, "z", time.Hour)
	if err := fx.svc.Delete(ctx, "u-1", m3.ID); err != nil {
		t.Errorf("no releaser: %v", err)
	}
}

func TestScheduledMessage_SendNow(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	m := fx.schedule(t, "now please", time.Hour)
	msg, err := fx.svc.SendNow(ctx, "u-1", m.ID)
	if err != nil || msg.Body != "now please" {
		t.Fatalf("SendNow = %+v, %v", msg, err)
	}
	if _, err := fx.st.GetScheduledMessage(ctx, "u-1", m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("sent message still scheduled: %v", err)
	}
	if _, err := fx.svc.SendNow(ctx, "u-1", m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("already sent: %v", err)
	}
	m2 := fx.schedule(t, "y", time.Hour)
	fx.st.claimLost = true
	if _, err := fx.svc.SendNow(ctx, "u-1", m2.ID); !errors.Is(err, ErrScheduledBusy) {
		t.Errorf("being sent: %v", err)
	}
	fx.st.claimLost = false

	// Retrying a failed one: it isn't queued, so it's claimed with "" — once.
	fx.sender.sendErr = ErrForbidden
	if _, err := fx.svc.SendNow(ctx, "u-1", m2.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("forbidden: %v", err)
	}
	failed, _ := fx.st.GetScheduledMessage(ctx, "u-1", m2.ID)
	if failed.State != model.ScheduledMessageFailed || failed.FailReason == "" {
		t.Fatalf("not marked failed: %+v", failed)
	}
	fx.sender.sendErr = nil
	if _, err := fx.svc.SendNow(ctx, "u-1", m2.ID); err != nil {
		t.Fatalf("retry of failed: %v", err)
	}
}

func TestScheduledMessage_ProcessDue(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	a := fx.schedule(t, "first", time.Minute)
	b := fx.schedule(t, "second", 2*time.Minute)
	fx.schedule(t, "not yet", time.Hour)
	*fx.now = fx.now.Add(5 * time.Minute)

	n, err := fx.svc.ProcessDue(ctx)
	if err != nil || n != 2 || !slices.Equal(fx.sender.sent, []string{"first", "second"}) {
		t.Fatalf("ProcessDue = %d, %v, sent %v", n, err, fx.sender.sent)
	}
	for _, id := range []string{a.ID, b.ID} {
		if _, err := fx.st.GetScheduledMessage(ctx, "u-1", id); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("%s still scheduled", id)
		}
	}
	if n, _ := fx.svc.ProcessDue(ctx); n != 0 {
		t.Errorf("sent again: %d", n)
	}

	fx.st.dueErr = errors.New("query boom")
	if _, err := fx.svc.ProcessDue(ctx); err == nil {
		t.Error("due error: want error")
	}
}

func TestScheduledMessage_ProcessDueSkipsLostAndErroredClaims(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	fx.schedule(t, "x", time.Minute)
	*fx.now = fx.now.Add(time.Hour)
	fx.st.claimLost = true
	if n, err := fx.svc.ProcessDue(ctx); n != 0 || err != nil {
		t.Fatalf("lost claim: %d, %v", n, err)
	}
	fx.st.claimLost = false
	fx.st.claimErr = errors.New("claim boom")
	if n, err := fx.svc.ProcessDue(ctx); n != 0 || err != nil {
		t.Fatalf("claim error: %d, %v", n, err)
	}
}

func TestScheduledMessage_ProcessDueDrainsFullBatchesWithinABound(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	for i := 0; i < scheduledClaimBatch+5; i++ {
		fx.schedule(t, fmt.Sprintf("m%d", i), time.Minute)
	}
	*fx.now = fx.now.Add(time.Hour)
	if n, err := fx.svc.ProcessDue(ctx); err != nil || n != scheduledClaimBatch+5 {
		t.Fatalf("ProcessDue = %d, %v; want all drained across rounds", n, err)
	}
	// A queue that never shrinks (every claim lost) stops after the bound.
	for i := 0; i < scheduledClaimBatch; i++ {
		fx.schedule(t, fmt.Sprintf("k%d", i), time.Minute)
	}
	*fx.now = fx.now.Add(time.Hour)
	fx.st.claimLost = true
	if n, err := fx.svc.ProcessDue(ctx); n != 0 || err != nil {
		t.Fatalf("bounded drain = %d, %v", n, err)
	}
}

func TestScheduledMessage_DeliveryFailures(t *testing.T) {
	fx := newSchedFixture()
	ctx := context.Background()
	m := fx.schedule(t, "x", time.Minute)
	*fx.now = fx.now.Add(5 * time.Minute)

	// Transient, early: left leased for a retry, not failed.
	fx.sender.sendErr = errors.New("dynamo blip")
	if n, _ := fx.svc.ProcessDue(ctx); n != 0 {
		t.Fatalf("sent despite error")
	}
	got, _ := fx.st.GetScheduledMessage(ctx, "u-1", m.ID)
	if got.State != model.ScheduledMessagePending {
		t.Fatalf("transient failure marked failed early: %+v", got)
	}
	// Still failing past the give-up window, once the lease lapses: failed.
	*fx.now = fx.now.Add(2 * scheduledGiveUpAfter)
	_, _ = fx.svc.ProcessDue(ctx)
	got, _ = fx.st.GetScheduledMessage(ctx, "u-1", m.ID)
	if got.State != model.ScheduledMessageFailed || got.FailReason != "It couldn't be sent. Try again." {
		t.Fatalf("not given up on: %+v", got)
	}
	if fx.st.dueKeys[skey("u-1", m.ID)] != "" {
		t.Fatal("failed message left in the due queue")
	}

	// Bookkeeping failures after a send are logged, not fatal.
	fx2 := newSchedFixture()
	fx2.schedule(t, "y", time.Minute)
	*fx2.now = fx2.now.Add(time.Hour)
	fx2.st.deleteErr = errors.New("delete boom")
	if n, _ := fx2.svc.ProcessDue(ctx); n != 1 {
		t.Fatalf("sent but delete failed: %d", n)
	}
	fx3 := newSchedFixture()
	m3 := fx3.schedule(t, "z", time.Minute)
	*fx3.now = fx3.now.Add(time.Hour)
	fx3.sender.sendErr = ErrThreadDeleted
	fx3.st.putErr = errors.New("put boom")
	if _, err := fx3.svc.SendNow(ctx, "u-1", m3.ID); !errors.Is(err, ErrThreadDeleted) {
		t.Fatalf("failure not recorded: %v", err)
	}
}

func TestScheduledFailReason(t *testing.T) {
	for err, final := range map[error]bool{
		ErrForbidden:                       true,
		ErrThreadDeleted:                   true,
		store.ErrNotFound:                  true,
		ErrMessageTooLong:                  true,
		ErrTooManyAttachments:              true,
		fmt.Errorf("%w: x", ErrValidation): true,
		errors.New("network"):              false,
	} {
		reason, gotFinal := scheduledFailReason(err)
		if reason == "" || gotFinal != final {
			t.Errorf("%v: reason %q final %v", err, reason, gotFinal)
		}
	}
}
