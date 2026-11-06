package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// accessByUser answers CheckAccess per user; anyone unlisted may open it.
type accessByUser map[string]error

func (a accessByUser) CheckAccess(_ context.Context, userID, _, _ string) error { return a[userID] }

type spyReminderPoster struct {
	posts []WebhookMessageInput
	err   error
}

func (s *spyReminderPoster) SendReminder(_ context.Context, in WebhookMessageInput) (*model.Message, error) {
	if s.err != nil {
		return nil, s.err
	}
	s.posts = append(s.posts, in)
	return &model.Message{ID: "posted"}, nil
}

type fakeReminderBots struct {
	asked []string
	err   error
}

func (f *fakeReminderBots) EnsureBotUser(_ context.Context, botID, name string) (*model.User, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.asked = append(f.asked, botID+"|"+name)
	return &model.User{ID: botID, DisplayName: name, IsBot: true}, nil
}

type fakeReminderDMs struct {
	pairs []string
	err   error
}

func (f *fakeReminderDMs) GetOrCreateDM(_ context.Context, a, b string) (*model.Conversation, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.pairs = append(f.pairs, a+"+"+b)
	return &model.Conversation{ID: "dm-bot-" + b}, nil
}

var reminderPeopleUsers = []*model.User{
	{ID: "u-1", DisplayName: "Alice", Status: "active"},
	{ID: "u-2", DisplayName: "Bob", Status: "active"},
	{ID: "u-3", DisplayName: "Carol", Status: "active"},
	{ID: "u-off", DisplayName: "Dan", Status: "deactivated"},
	{ID: "bot-x", DisplayName: "Hook", Status: "active", IsBot: true},
	{ID: "a-1", DisplayName: "gg", Status: "active", Kind: model.UserKindAgent},
}

type peopleRig struct {
	svc    *ReminderService
	store  *fakeReminderStore
	act    *spyActivityAdder
	notif  *spyDirectNotifier
	poster *spyReminderPoster
	bots   *fakeReminderBots
	dms    *fakeReminderDMs
	owners *fakeOwnerLookup
}

func newPeopleRig(access accessByUser) *peopleRig {
	r := &peopleRig{
		store:  &fakeReminderStore{},
		act:    &spyActivityAdder{},
		notif:  &spyDirectNotifier{},
		poster: &spyReminderPoster{},
		bots:   &fakeReminderBots{},
		dms:    &fakeReminderDMs{},
		owners: &fakeOwnerLookup{users: reminderPeopleUsers},
	}
	r.svc = NewReminderService(r.store, &fakeMessageGetter{msg: &model.Message{ID: "m-1", Body: "ship it"}}, access)
	r.svc.SetDelivery(r.act, r.notif)
	r.svc.SetOwnerLookup(r.owners)
	r.svc.SetBot(r.poster, r.bots, r.dms, "https://ex.example.com/")
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	r.svc.now = func() time.Time { return base }
	return r
}

var peopleBase = time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)

func peopleInput(ids ...string) ReminderInput {
	return ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general", RemindAt: peopleBase.Add(time.Hour), UserIDs: ids}
}

// The people are kept once each, without the owner or blanks, in the order
// they were picked.
func TestReminderPeople_ScheduleKeepsEachPersonOnce(t *testing.T) {
	r := newPeopleRig(accessByUser{})
	got, err := r.svc.Schedule(context.Background(), "u-1", peopleInput(" u-2 ", "u-1", "", "u-3", "u-2"))
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if strings.Join(got.UserIDs, ",") != "u-2,u-3" || strings.Join(r.store.scheduled[0].UserIDs, ",") != "u-2,u-3" {
		t.Fatalf("people = %v, want u-2,u-3", got.UserIDs)
	}
	// Only the owner: a personal reminder, with no lookup at all.
	solo, err := r.svc.Schedule(context.Background(), "u-1", peopleInput("u-1"))
	if err != nil || solo.UserIDs != nil {
		t.Fatalf("solo Schedule = %+v, %v", solo, err)
	}
	if len(r.owners.asked) != 1 {
		t.Fatalf("lookups = %v, want only the first schedule's", r.owners.asked)
	}
}

func TestReminderPeople_ScheduleRefusesWhoCannotBeTagged(t *testing.T) {
	ctx := context.Background()
	many := make([]string, maxReminderPeople+1)
	for i := range many {
		many[i] = "p-" + string(rune('a'+i))
	}
	cases := []struct {
		name string
		ids  []string
	}{
		{"too many", many},
		{"unknown", []string{"u-ghost"}},
		{"bot", []string{"bot-x"}},
		{"agent", []string{"a-1"}},
		{"deactivated", []string{"u-off"}},
		{"cannot open the chat", []string{"u-3"}},
	}
	for _, c := range cases {
		r := newPeopleRig(accessByUser{"u-3": ErrForbidden})
		_, err := r.svc.Schedule(ctx, "u-1", peopleInput(c.ids...))
		if !errors.Is(err, apperr.ErrValidation) {
			t.Errorf("%s: err = %v, want an invalid-input error", c.name, err)
		}
		if len(r.store.scheduled) != 0 {
			t.Errorf("%s: scheduled anyway", c.name)
		}
	}

	// A failing access check or lookup is not the person's fault: it surfaces
	// as is, for the client to retry.
	r := newPeopleRig(accessByUser{"u-3": errors.New("dynamo timeout")})
	if _, err := r.svc.Schedule(ctx, "u-1", peopleInput("u-3")); err == nil || strings.Contains(err.Error(), "can't open") {
		t.Fatalf("access failure = %v, want it passed through", err)
	}
	r = newPeopleRig(accessByUser{})
	r.owners.err = errors.New("dynamo down")
	if _, err := r.svc.Schedule(ctx, "u-1", peopleInput("u-2")); err == nil {
		t.Fatal("a failed people lookup should fail the schedule")
	}
}

func TestReminderPeople_UpdateChangesTimeAndPeople(t *testing.T) {
	ctx := context.Background()
	r := newPeopleRig(accessByUser{})
	pub := newMockPublisher()
	r.svc.SetPublisher(pub)
	r.store.getR = &model.Reminder{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, UserIDs: []string{"u-2"}, RemindAt: peopleBase.Add(time.Hour)}

	later := peopleBase.Add(3 * time.Hour)
	got, err := r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later, UserIDs: []string{"u-3"}})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !got.RemindAt.Equal(later) || strings.Join(got.UserIDs, ",") != "u-3" || len(r.store.rescheduled) != 1 {
		t.Fatalf("updated = %+v, rescheduled %v", got, r.store.rescheduled)
	}
	if changed := remindersChanged(pub); len(changed) != 1 || changed[0] != "u-1" {
		t.Fatalf("reminders.changed to %v, want u-1", changed)
	}

	// Emptying the people makes it a personal reminder again.
	got, err = r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later})
	if err != nil || got.UserIDs != nil {
		t.Fatalf("cleared Update = %+v, %v", got, err)
	}
}

func TestReminderPeople_UpdateRefusals(t *testing.T) {
	ctx := context.Background()
	pending := func() *model.Reminder {
		return &model.Reminder{ID: "r1", UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel}
	}
	later := ReminderUpdate{RemindAt: peopleBase.Add(time.Hour)}

	r := newPeopleRig(accessByUser{})
	r.store.getR = pending()
	if _, err := r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: peopleBase.Add(-time.Minute)}); !errors.Is(err, ErrReminderTimeInvalid) {
		t.Fatalf("past time = %v", err)
	}

	r.store.getR, r.store.getErr = nil, store.ErrNotFound
	if _, err := r.svc.Update(ctx, "u-1", "r1", later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("gone reminder = %v, want not found", err)
	}

	r.store.getR, r.store.getErr = pending(), nil
	if _, err := r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later.RemindAt, UserIDs: []string{"bot-x"}}); err == nil {
		t.Fatal("tagging a bot should be refused")
	}

	r.store.reschedErr = store.ErrNotFound
	if _, err := r.svc.Update(ctx, "u-1", "r1", later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("fired meanwhile = %v, want not found", err)
	}
	if len(r.store.rescheduled) != 0 {
		t.Fatalf("rescheduled = %v, want nothing", r.store.rescheduled)
	}
}

// With people added, the bot replies to the message — starting its thread —
// tagging the owner and each person who can still be reached. Nothing is
// sent privately: the tag is the owner's alert.
func TestReminderPeople_FiresAsTheBotsReply(t *testing.T) {
	r := newPeopleRig(accessByUser{"u-3": ErrForbidden})
	r.store.due = []*model.Reminder{{
		ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general",
		UserIDs: []string{"u-2", "u-3", "u-off"},
	}}
	if _, err := r.svc.ProcessDue(context.Background()); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	if len(r.poster.posts) != 1 {
		t.Fatalf("posts = %+v, want one reply", r.poster.posts)
	}
	p := r.poster.posts[0]
	if p.ParentID != "ch-1" || p.ParentType != ParentChannel || p.ParentMessageID != "m-1" || p.AuthorID != "" {
		t.Fatalf("reply = %+v, want the sentinel's reply in m-1's thread", p)
	}
	if p.Username != "Reminder" || p.IconEmoji != "alarm_clock" {
		t.Fatalf("reply identity = %q %q", p.Username, p.IconEmoji)
	}
	if p.Body != "⏰ Reminder for @[u-1|Alice] @[u-2|Bob]" {
		t.Fatalf("body = %q, want the owner and Bob only", p.Body)
	}
	if len(r.act.items) != 0 || len(r.notif.notifs) != 0 {
		t.Fatalf("private alert sent too: %+v %+v", r.act.items, r.notif.notifs)
	}
}

// A reminder about a reply lands in the reply's thread, with a link to the
// very message; a failed name lookup still tags everyone, by id.
func TestReminderPeople_ReplyInAThread(t *testing.T) {
	r := newPeopleRig(accessByUser{})
	r.owners.err = errors.New("dynamo down")
	r.store.due = []*model.Reminder{{
		ID: "r1", UserID: "u-1", MessageID: "m-7", ParentMessageID: "root-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general",
		UserIDs: []string{"u-2"},
	}}
	if _, err := r.svc.ProcessDue(context.Background()); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	p := r.poster.posts[0]
	want := "⏰ [Reminder](https://ex.example.com/channel/general?thread=root-1#msg-m-7) for @[u-1|u-1] @[u-2|u-2]"
	if p.ParentMessageID != "root-1" || p.Body != want {
		t.Fatalf("reply = %q in %q, want %q in root-1", p.Body, p.ParentMessageID, want)
	}
}

// A note is kept trimmed, changed or cleared by an edit, and refused when too
// long — on schedule and on edit alike.
func TestReminderNote_ScheduleAndUpdate(t *testing.T) {
	ctx := context.Background()
	r := newPeopleRig(accessByUser{})
	in := peopleInput("u-2")
	in.Note = "  bring the Q3 numbers \n"
	got, err := r.svc.Schedule(ctx, "u-1", in)
	if err != nil || got.Note != "bring the Q3 numbers" || r.store.scheduled[0].Note != "bring the Q3 numbers" {
		t.Fatalf("Schedule = %+v, %v", got, err)
	}

	r.store.getR = &model.Reminder{ID: "r1", UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, Note: "old"}
	later := peopleBase.Add(2 * time.Hour)
	if got, err := r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later, Note: "new"}); err != nil || got.Note != "new" {
		t.Fatalf("Update = %+v, %v", got, err)
	}
	if got, err := r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later}); err != nil || got.Note != "" {
		t.Fatalf("cleared Update = %+v, %v", got, err)
	}

	// 500 characters is fine (counted as characters, not bytes); 501 is not.
	in.Note = strings.Repeat("é", maxReminderNote)
	if _, err := r.svc.Schedule(ctx, "u-1", in); err != nil {
		t.Fatalf("a %d-character note: %v", maxReminderNote, err)
	}
	in.Note += "x"
	if _, err := r.svc.Schedule(ctx, "u-1", in); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("too long on Schedule = %v", err)
	}
	r.store.rescheduled = nil
	if _, err := r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later, Note: in.Note}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("too long on Update = %v", err)
	}
	if len(r.store.rescheduled) != 0 {
		t.Fatalf("rescheduled a too-long note: %v", r.store.rescheduled)
	}
}

// The note is what the reminder says — "Reminder: <note>" — in the bot's
// reply and in its DM, where "Reminder" links the message; the private alert,
// when the bot can't post, leads with it.
func TestReminderNote_Delivered(t *testing.T) {
	ctx := context.Background()
	r := newPeopleRig(accessByUser{})
	r.store.due = []*model.Reminder{
		{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general", UserIDs: []string{"u-2"}, Note: "bring the numbers"},
		{ID: "r2", UserID: "u-1", MessageID: "m-1", ParentID: "conv-9", ParentType: ParentConversation, Note: "call back"},
		{ID: "r4", UserID: "u-1", MessageID: "m-7", ParentMessageID: "root-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general", UserIDs: []string{"u-2"}, Note: "see the deck"},
	}
	if _, err := r.svc.ProcessDue(ctx); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	for i, want := range []string{
		"⏰ Reminder for @[u-1|Alice] @[u-2|Bob]: bring the numbers",
		"⏰ [Reminder](https://ex.example.com/conversation/conv-9#msg-m-1): call back",
		"⏰ [Reminder](https://ex.example.com/channel/general?thread=root-1#msg-m-7) for @[u-1|Alice] @[u-2|Bob]: see the deck",
	} {
		if got := r.poster.posts[i].Body; got != want {
			t.Errorf("post %d = %q, want %q", i, got, want)
		}
	}

	r = newPeopleRig(accessByUser{})
	r.poster.err = errors.New("posting down")
	r.store.due = []*model.Reminder{{ID: "r3", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, UserIDs: []string{"u-2"}, Note: "call back"}}
	if _, err := r.svc.ProcessDue(ctx); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	if len(r.notif.notifs) != 1 || r.notif.notifs[0].Body != "call back\nship it" {
		t.Fatalf("private alert = %+v, want the note then the message", r.notif.notifs)
	}
}

// A reminder for everyone keeps no people, only who's left out — each once,
// never the owner, at most maxReminderPeople, never looked up — and an edit
// switches a reminder between the two.
func TestReminderEveryone_ScheduleAndUpdate(t *testing.T) {
	ctx := context.Background()
	r := newPeopleRig(accessByUser{})
	in := peopleInput("u-2")
	in.Everyone = true
	in.ExcludedUserIDs = []string{" u-3 ", "u-1", "", "u-3", "u-ghost"}
	got, err := r.svc.Schedule(ctx, "u-1", in)
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if !got.Everyone || got.UserIDs != nil || strings.Join(got.ExcludedUserIDs, ",") != "u-3,u-ghost" {
		t.Fatalf("reminder = %+v", got)
	}
	if len(r.owners.asked) != 0 {
		t.Fatalf("looked people up: %v", r.owners.asked)
	}
	many := make([]string, maxReminderPeople+1)
	for i := range many {
		many[i] = "p-" + string(rune('a'+i))
	}
	in.ExcludedUserIDs = many
	if _, err := r.svc.Schedule(ctx, "u-1", in); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("too many left out = %v", err)
	}

	r.store.getR = &model.Reminder{ID: "r1", UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, UserIDs: []string{"u-2"}, RemindAt: peopleBase.Add(time.Hour)}
	later := peopleBase.Add(2 * time.Hour)
	got, err = r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later, Everyone: true, UserIDs: []string{"u-3"}, ExcludedUserIDs: []string{"u-2"}})
	if err != nil || !got.Everyone || got.UserIDs != nil || strings.Join(got.ExcludedUserIDs, ",") != "u-2" {
		t.Fatalf("to everyone = %+v, %v", got, err)
	}
	got, err = r.svc.Update(ctx, "u-1", "r1", ReminderUpdate{RemindAt: later, UserIDs: []string{"u-3"}, ExcludedUserIDs: []string{"u-2"}})
	if err != nil || got.Everyone || strings.Join(got.UserIDs, ",") != "u-3" || got.ExcludedUserIDs != nil {
		t.Fatalf("back to people = %+v, %v", got, err)
	}
}

// For everyone, the bot's reply tags the owner and @all — one tag the
// fan-out spreads to every member — names (never tags) whoever was left out,
// and has its notifications skip them. A DM's goes the same way.
func TestReminderEveryone_FiresAsTheBotsReplyToAll(t *testing.T) {
	ctx := context.Background()
	r := newPeopleRig(accessByUser{})
	r.store.due = []*model.Reminder{
		{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, ChannelSlug: "general", Everyone: true, ExcludedUserIDs: []string{"u-2", "u-3"}, Note: "standup moved"},
		{ID: "r2", UserID: "u-1", MessageID: "m-1", ParentID: "conv-9", ParentType: ParentConversation, Everyone: true},
	}
	if _, err := r.svc.ProcessDue(ctx); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	if len(r.poster.posts) != 2 {
		t.Fatalf("posts = %+v, want two replies", r.poster.posts)
	}
	reply := r.poster.posts[0]
	if reply.Body != "⏰ Reminder for @[u-1|Alice] and @all (except Bob, Carol): standup moved" || reply.ParentMessageID != "m-1" {
		t.Fatalf("reply = %+v", reply)
	}
	if strings.Join(reply.NotifyExcept, ",") != "u-2,u-3" {
		t.Fatalf("notifications skip %v, want u-2,u-3", reply.NotifyExcept)
	}
	dm := r.poster.posts[1]
	if dm.Body != "⏰ Reminder for @[u-1|Alice] and @all" || dm.ParentID != "conv-9" || dm.ParentMessageID != "m-1" || dm.NotifyExcept != nil || dm.AuthorID != "" {
		t.Fatalf("conversation reply = %+v", dm)
	}
	if len(r.dms.pairs) != 0 || len(r.notif.notifs) != 0 {
		t.Fatalf("DMed or alerted privately: %v %v", r.dms.pairs, r.notif.notifs)
	}

	// Names unknown (a failed lookup): the left-out are counted, not named.
	for _, c := range []struct {
		excluded []string
		want     string
	}{
		{[]string{"u-2"}, "⏰ Reminder for @[u-1|u-1] and @all (except 1 person)"},
		{[]string{"u-2", "u-3"}, "⏰ Reminder for @[u-1|u-1] and @all (except 2 people)"},
	} {
		r := newPeopleRig(accessByUser{})
		r.owners.err = errors.New("dynamo down")
		r.store.due = []*model.Reminder{{ID: "r3", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, Everyone: true, ExcludedUserIDs: c.excluded}}
		if _, err := r.svc.ProcessDue(ctx); err != nil {
			t.Fatalf("ProcessDue: %v", err)
		}
		if got := r.poster.posts[0].Body; got != c.want {
			t.Errorf("body = %q, want %q", got, c.want)
		}
	}
}

// A personal reminder is the bot's DM to its owner, linking the message.
func TestReminderPeople_PersonalReminderIsTheBotsDM(t *testing.T) {
	r := newPeopleRig(accessByUser{})
	r.store.due = []*model.Reminder{{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "conv-9", ParentType: ParentConversation}}
	if _, err := r.svc.ProcessDue(context.Background()); err != nil {
		t.Fatalf("ProcessDue: %v", err)
	}
	bot := ReminderBotUserID()
	if len(r.bots.asked) != 1 || r.bots.asked[0] != bot+"|Reminder" {
		t.Fatalf("bot = %v", r.bots.asked)
	}
	if len(r.dms.pairs) != 1 || r.dms.pairs[0] != bot+"+u-1" {
		t.Fatalf("DM = %v", r.dms.pairs)
	}
	p := r.poster.posts[0]
	if p.ParentID != "dm-bot-u-1" || p.ParentType != ParentConversation || p.AuthorID != bot || p.ParentMessageID != "" {
		t.Fatalf("DM post = %+v", p)
	}
	if p.Body != "⏰ You asked me to remind you about [this message](https://ex.example.com/conversation/conv-9#msg-m-1)" {
		t.Fatalf("DM body = %q", p.Body)
	}
	if len(r.notif.notifs) != 0 {
		t.Fatalf("private alert sent too: %+v", r.notif.notifs)
	}
}

// Whatever keeps the bot from posting, the owner is still reminded
// privately: a lost reminder is worse than a quiet one.
func TestReminderPeople_FallsBackToThePrivateAlert(t *testing.T) {
	cases := []struct {
		name   string
		people []string
		break_ func(*peopleRig)
	}{
		{"reply refused", []string{"u-2"}, func(r *peopleRig) { r.poster.err = ErrThreadDeleted }},
		{"bot account", nil, func(r *peopleRig) { r.bots.err = errors.New("dynamo down") }},
		{"DM", nil, func(r *peopleRig) { r.dms.err = errors.New("dynamo down") }},
		{"DM post", nil, func(r *peopleRig) { r.poster.err = errors.New("archived") }},
	}
	for _, c := range cases {
		r := newPeopleRig(accessByUser{})
		c.break_(r)
		r.store.due = []*model.Reminder{{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, UserIDs: c.people}}
		if _, err := r.svc.ProcessDue(context.Background()); err != nil {
			t.Fatalf("%s: ProcessDue: %v", c.name, err)
		}
		if len(r.notif.notifs) != 1 || len(r.act.items) != 1 || r.notif.notifs[0].AlertID != "r1" {
			t.Errorf("%s: private alert = %+v %+v, want one", c.name, r.notif.notifs, r.act.items)
		}
	}
}

func TestReminderMention(t *testing.T) {
	if got := reminderMention("u-1", " Ann [ops|lead] "); got != "@[u-1|Ann opslead]" {
		t.Fatalf("got %q", got)
	}
	if got := reminderMention("u-1", "[]|"); got != "@[u-1|u-1]" {
		t.Fatalf("empty name = %q", got)
	}
}

func TestReminderBotUserID(t *testing.T) {
	id := ReminderBotUserID()
	if !isBotUserID(id) || id != ReminderBotUserID() || id == WebhookBotUserID("") {
		t.Fatalf("bot id %q must be a stable bot id of its own", id)
	}
}
