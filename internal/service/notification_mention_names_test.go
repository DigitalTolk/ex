package service

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// Alert text names who a mention actually is. The typed half of the syntax is
// whatever the poster wrote, so "@[bobID|Alice]" read "@Alice" in the OS popup,
// the phone push and the Activity row while Bob was the one notified. Every
// text an alert shows now carries the current name for the ID — as the
// rendered message does — and the typed text only for an ID nobody has.

// lockedMentions is a MentionResolver safe to call from the services'
// detached goroutines.
type lockedMentions struct {
	mu          sync.Mutex
	names       MentionNames
	err         error
	calls       int
	gotUsers    []string
	gotChannels []string
}

func (l *lockedMentions) ResolveMentions(_ context.Context, userIDs, channelIDs []string) (MentionNames, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	l.gotUsers = append(l.gotUsers, userIDs...)
	l.gotChannels = append(l.gotChannels, channelIDs...)
	return l.names, l.err
}

func (l *lockedMentions) snapshot() (int, []string, []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls, slices.Clone(l.gotUsers), slices.Clone(l.gotChannels)
}

var bobAndOps = MentionNames{
	Users:    map[string]string{"u-bob": "Bob", "u-carol": "Carol"},
	Channels: map[string]string{"ch-ops": "ops"},
}

type mentionAlertFixture struct {
	svc      *NotificationService
	pub      *mockPublisher
	push     *recordingMobilePush
	activity *recordingActivity
	names    *lockedMentions
	users    *mockUserStore
}

func newMentionAlertFixture(t *testing.T, names *lockedMentions) *mentionAlertFixture {
	t.Helper()
	svc, pub, members, _, chans, users := setupNotifier(t)
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Dana"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	users.users["u-alice"] = &model.User{ID: "u-alice", DisplayName: "Alice"}
	users.users["u-carol"] = &model.User{ID: "u-carol", DisplayName: "Carol"}
	for _, uid := range []string{"u-author", "u-bob", "u-alice", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	svc.SetPresence(&stubPresence{online: map[string]bool{}}) // offline → immediate push
	act := &recordingActivity{}
	svc.SetActivityRecorder(act)
	if names != nil {
		svc.SetMentionResolver(names)
	}
	return &mentionAlertFixture{svc: svc, pub: pub, push: push, activity: act, names: names, users: users}
}

func (f *mentionAlertFixture) alertFor(t *testing.T, uid string) (Notification, bool) {
	t.Helper()
	f.pub.mu.Lock()
	defer f.pub.mu.Unlock()
	for _, p := range f.pub.published {
		if p.channel != pubsub.UserChannel(uid) {
			continue
		}
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err == nil {
			return n, true
		}
	}
	return Notification{}, false
}

func (f *mentionAlertFixture) pushFor(uid string) (Notification, bool) {
	f.push.mu.Lock()
	defer f.push.mu.Unlock()
	for _, c := range f.push.calls {
		if c.userID == uid {
			return c.notif, true
		}
	}
	return Notification{}, false
}

func TestNotifyForMessage_MentionTextShowsCurrentNames(t *testing.T) {
	names := &lockedMentions{names: bobAndOps}
	f := newMentionAlertFixture(t, names)
	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@[u-bob|Alice] the deploy in ~[ch-ops|old-ops] failed, ask @[u-gone|Ghost]"}
	f.svc.NotifyForMessage(context.Background(), msg, ParentChannel, nil)

	const wantPreview = "@Bob the deploy in ~ops failed, ask @Ghost"
	alert, ok := f.alertFor(t, "u-bob")
	if !ok {
		t.Fatal("Bob was mentioned but not alerted")
	}
	if alert.Body != "Dana: "+wantPreview {
		t.Fatalf("popup body = %q, want %q", alert.Body, "Dana: "+wantPreview)
	}
	if p, ok := f.pushFor("u-bob"); !ok || p.Body != "Dana: "+wantPreview {
		t.Fatalf("push = %+v (sent %v), want body %q", p, ok, "Dana: "+wantPreview)
	}
	if item := f.activity.items["u-bob"]; item == nil || item.MessagePreview != wantPreview {
		t.Fatalf("activity item = %+v, want preview %q", item, wantPreview)
	}
	if _, ok := f.alertFor(t, "u-alice"); ok {
		t.Fatal("Alice was alerted for a mention of Bob")
	}
	calls, users, channels := names.snapshot()
	if calls != 1 || !slices.Equal(users, []string{"u-bob", "u-gone"}) || !slices.Equal(channels, []string{"ch-ops"}) {
		t.Fatalf("lookups = %d (users %v, channels %v), want one batched lookup", calls, users, channels)
	}
}

// A thread reply's alert shows two texts — the root in its title, the reply in
// its body — resolved in the same single lookup.
func TestNotifyForMessage_ThreadReplyResolvesRootAndReplyInOneLookup(t *testing.T) {
	names := &lockedMentions{names: bobAndOps}
	f := newMentionAlertFixture(t, names)
	root := &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "u-carol", Body: "@[u-carol|Zed] rollout plan"}
	reply := &model.Message{ID: "m2", ParentID: "ch1", ParentMessageID: "root-1", AuthorID: "u-author", Body: "@[u-bob|Alice] done"}
	f.svc.NotifyForMessage(context.Background(), reply, ParentChannel, root)

	alert, ok := f.alertFor(t, "u-bob")
	if !ok {
		t.Fatal("Bob was mentioned but not alerted")
	}
	if alert.Title != "Thread in ~general: @Carol rollout plan" || alert.Body != "Dana: @Bob done" {
		t.Fatalf("alert = %q / %q", alert.Title, alert.Body)
	}
	calls, users, _ := names.snapshot()
	if calls != 1 || !slices.Equal(users, []string{"u-bob", "u-carol"}) {
		t.Fatalf("lookups = %d (users %v), want one for both texts", calls, users)
	}
}

// A webhook post without text alerts (here Bob, at "All messages") with its
// synthesized attachment summary, whose mentions are resolved the same way.
func TestNotifyForMessage_WebhookSummaryShowsCurrentNames(t *testing.T) {
	f := newMentionAlertFixture(t, &lockedMentions{names: bobAndOps})
	f.users.users["u-bob"].NotificationSettings = &model.NotificationSettings{DesktopLevel: model.NotificationLevelAll, MobileLevel: model.MobileNotificationDefault}
	msg := &model.Message{ID: "m3", ParentID: "ch1", AuthorID: "webhook", WebhookUsername: "CI",
		MessageAttachments: []model.MessageAttachment{{Title: "Build failed", Text: "owner @[u-bob|Alice]"}}}
	f.svc.NotifyForMessage(context.Background(), msg, ParentChannel, nil)

	alert, ok := f.alertFor(t, "u-bob")
	if !ok || alert.Body != "CI: Build failed — owner @Bob" {
		t.Fatalf("alert = %+v (sent %v), want the summary naming Bob", alert, ok)
	}
}

// No mention, no lookup; no resolver or a failed lookup shows the typed text
// and still alerts.
func TestNotifyForMessage_MentionNameLookupFallbacks(t *testing.T) {
	names := &lockedMentions{names: bobAndOps}
	f := newMentionAlertFixture(t, names)
	f.svc.NotifyForMessage(context.Background(), &model.Message{ID: "m4", ParentID: "ch1", AuthorID: "u-author", Body: "@all lunch?"}, ParentChannel, nil)
	if calls, _, _ := names.snapshot(); calls != 0 {
		t.Fatalf("a message without mention syntax looked up %d times", calls)
	}

	failing := newMentionAlertFixture(t, &lockedMentions{err: errors.New("cache down")})
	failing.svc.NotifyForMessage(context.Background(), &model.Message{ID: "m5", ParentID: "ch1", AuthorID: "u-author", Body: "@[u-bob|Robert] ping"}, ParentChannel, nil)
	if alert, ok := failing.alertFor(t, "u-bob"); !ok || alert.Body != "Dana: @Robert ping" {
		t.Fatalf("alert after a failed lookup = %+v (sent %v)", alert, ok)
	}

	unwired := newMentionAlertFixture(t, nil)
	unwired.svc.NotifyForMessage(context.Background(), &model.Message{ID: "m6", ParentID: "ch1", AuthorID: "u-author", Body: "@[u-bob|Robert] ping"}, ParentChannel, nil)
	if alert, ok := unwired.alertFor(t, "u-bob"); !ok || alert.Body != "Dana: @Robert ping" {
		t.Fatalf("alert without a resolver = %+v (sent %v)", alert, ok)
	}
}

func TestFlattenMentions(t *testing.T) {
	cases := []struct{ in, want string }{
		{"@[u-bob|Alice] hi", "@Bob hi"},
		{"@[ u-bob |Alice]", "@Bob"},
		{"@[u-nobody|Typed Name]", "@Typed Name"},
		{"see ~[ch-ops|old-ops] and ~[ch-x|elsewhere]", "see ~ops and ~elsewhere"},
		{"no mentions @all", "no mentions @all"},
	}
	for _, tc := range cases {
		if got := flattenMentions(tc.in, bobAndOps); got != tc.want {
			t.Errorf("flattenMentions(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	users, channels := textMentionIDs("@[u-1|A] @[u-1|B] ~[c-1|x] @[  |blank]", "", "@[u-2|C] ~[c-1|y]")
	if !slices.Equal(users, []string{"u-1", "u-2"}) || !slices.Equal(channels, []string{"c-1"}) {
		t.Fatalf("ids = %v / %v, want distinct ids in order", users, channels)
	}
}

// The Activity row of a reaction, and its preview refreshed on an edit, name
// the mentioned people by their current names.
func TestActivityService_PreviewsShowCurrentMentionNames(t *testing.T) {
	st := newFakeActivityStore()
	st.touched = map[string][]string{"u-1": {itemA}}
	pub := newMockPublisher()
	svc := NewActivityService(st, pub)
	svc.SetMemberLister(&fakeMemberLister{ids: []string{"u-1"}})
	svc.SetMentionResolver(&lockedMentions{names: bobAndOps})
	msg := reactedMessage("author-1")
	msg.Body = "thanks @[u-bob|Alice]"
	svc.RecordReaction(context.Background(), msg, ParentChannel, "reactor-2", "🎉")
	waitForCond(t, func() bool { return activityEventPublished(pub, events.EventActivityNew) }, "reaction recorded")
	if got := st.first("author-1").MessagePreview; got != "thanks @Bob" {
		t.Fatalf("reaction preview = %q", got)
	}

	svc.MessageEdited(context.Background(), &model.Message{ID: "m-1", ParentID: "ch-1", Body: "now ~[ch-ops|x] with @[u-carol|Zed]"}, ParentChannel)
	waitForCond(t, func() bool { return len(changes(t, pub, "u-1")) == 1 }, "update published")
	if _, _, preview := st.lastMessageCall(); preview != "now ~ops with @Carol" {
		t.Fatalf("edited preview = %q", preview)
	}
}

// A reminder's preview — its Activity row and its alert/push body — names the
// mentioned people by their current names, when scheduled, edited and fired.
func TestReminderService_PreviewsShowCurrentMentionNames(t *testing.T) {
	ctx := context.Background()
	names := &lockedMentions{names: bobAndOps}
	rs := &fakeReminderStore{owners: []string{"u-1"}}
	svc, act, notif := newReminderSvc(t, rs, &model.Message{ID: "m-1", ParentID: "ch-1", Body: "ask @[u-bob|Alice]"}, nil)
	svc.SetMentionResolver(names)
	base := svc.now()

	r, err := svc.Schedule(ctx, "u-1", ReminderInput{MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, RemindAt: base.Add(time.Hour)})
	if err != nil || r.MessagePreview != "ask @Bob" {
		t.Fatalf("scheduled preview = %+v, %v", r, err)
	}

	svc.MessageEdited(ctx, &model.Message{ID: "m-1", ParentID: "ch-1"}, ParentChannel)
	waitForCond(t, func() bool { return len(rs.recorded()) == 1 }, "preview refreshed")
	rs.mu.Lock()
	preview := rs.preview
	rs.mu.Unlock()
	if preview != "ask @Bob" {
		t.Fatalf("refreshed preview = %q", preview)
	}

	rs.due = []*model.Reminder{{ID: "r1", UserID: "u-1", MessageID: "m-1", ParentID: "ch-1", ParentType: ParentChannel, MessagePreview: "ask @Alice"}}
	if n, err := svc.ProcessDue(ctx); err != nil || n != 1 {
		t.Fatalf("ProcessDue = %d, %v", n, err)
	}
	if len(notif.notifs) != 1 || notif.notifs[0].Body != "ask @Bob" || len(act.items) != 1 || act.items[0].MessagePreview != "ask @Bob" {
		t.Fatalf("fired with %+v / %+v, want the current name", notif.notifs, act.items)
	}
}
