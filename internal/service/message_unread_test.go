package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// pagedAfterStore makes ListMessagesAfter behave like the DynamoDB query: IDs
// strictly after the cursor, ascending, `limit` per page, returned
// newest-first with has-more — so the mark-unread count walk really pages.
type pagedAfterStore struct {
	*mockMessageStore
	pages int
}

func (p *pagedAfterStore) ListMessagesAfter(_ context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	if p.listAfterErr != nil {
		return nil, false, p.listAfterErr
	}
	p.pages++
	var newer []*model.Message
	for _, m := range p.messages {
		if m.ParentID == parentID && m.ID > after {
			newer = append(newer, m)
		}
	}
	sort.Slice(newer, func(i, j int) bool { return newer[i].ID < newer[j].ID })
	hasMore := len(newer) > limit
	if hasMore {
		newer = newer[:limit]
	}
	for i, j := 0, len(newer)-1; i < j; i, j = i+1, j-1 {
		newer[i], newer[j] = newer[j], newer[i]
	}
	return newer, hasMore, nil
}

type unreadFixture struct {
	svc      *MessageService
	messages *pagedAfterStore
	chSeq    *mockUnreadSeqStore
	convSeq  *mockUnreadSeqStore
	state    *mockUserStateStore
	pub      *mockPublisher
}

func newUnreadFixture(t *testing.T) *unreadFixture {
	t.Helper()
	messages := &pagedAfterStore{mockMessageStore: newMockMessageStore()}
	memberships := newMockMembershipStore()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1"}
	conversations := newMockConversationStore()
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1"}}
	pub := newMockPublisher()
	svc := NewMessageService(messages, memberships, conversations, pub, newMockBroker())
	f := &unreadFixture{svc: svc, messages: messages, chSeq: &mockUnreadSeqStore{}, convSeq: &mockUnreadSeqStore{}, state: newMockUserStateStore(), pub: pub}
	svc.SetChannelSeqStore(f.chSeq)
	svc.SetConversationSeqStore(f.convSeq)
	svc.SetUserStateStore(f.state)
	return f
}

// add stores a message with a sortable id ("m-007") and returns it.
func (f *unreadFixture) add(parentID string, n int, edit func(*model.Message)) *model.Message {
	m := &model.Message{ID: fmt.Sprintf("m-%03d", n), ParentID: parentID, AuthorID: "u-2", Body: "hi", CreatedAt: time.Date(2026, 10, 7, 9, 0, n, 0, time.UTC)}
	if edit != nil {
		edit(m)
	}
	f.messages.messages[parentID+"#"+m.ID] = m
	return m
}

func (f *unreadFixture) lastEvent(t *testing.T) (string, map[string]any) {
	t.Helper()
	if len(f.pub.published) == 0 {
		t.Fatal("nothing published")
	}
	p := f.pub.published[len(f.pub.published)-1]
	var data map[string]any
	if err := json.Unmarshal(p.event.Data, &data); err != nil {
		t.Fatalf("event data: %v", err)
	}
	return p.channel, data
}

// Marking a channel message unread rewinds the watermark by exactly the
// messages that bumped the counter from it onward: thread replies and system
// join/leave posts are skipped, a deleted message still counts.
func TestMarkUnread_ChannelRewindsWatermark(t *testing.T) {
	f := newUnreadFixture(t)
	from := f.add("ch-1", 1, nil)
	f.add("ch-1", 2, func(m *model.Message) { m.ParentMessageID = from.ID }) // reply: no
	f.add("ch-1", 3, func(m *model.Message) { m.System = true })             // system: no
	f.add("ch-1", 4, func(m *model.Message) { m.Deleted = true })            // deleted: yes
	f.add("ch-1", 5, nil)
	f.add("ch-0", 6, nil) // another channel: no
	f.chSeq.seq = map[string]int64{"ch-1": 40}

	res, err := f.svc.MarkUnread(context.Background(), "u-1", "ch-1", ParentChannel, from.ID)
	if err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	if res.UnreadCount != 3 || res.ParentType != ParentChannel || res.MessageID != from.ID || res.ThreadRootID != "" {
		t.Fatalf("result = %+v, want 3 unread on the channel", res)
	}
	if got, _ := f.chSeq.lastRead("ch-1", "u-1"); got != 37 {
		t.Fatalf("last read = %d, want 40-3", got)
	}
	topic, data := f.lastEvent(t)
	if topic != pubsub.UserChannel("u-1") || data["channelID"] != "ch-1" || data["unread"] != true {
		t.Fatalf("event %s %v, want the caller's userchannel.updated {channelID, unread}", topic, data)
	}
}

// A system message counts in a conversation (conversations bump on every
// top-level post), and the walk pages past one page of results.
func TestMarkUnread_ConversationCountsAcrossPages(t *testing.T) {
	f := newUnreadFixture(t)
	from := f.add("dm-1", 0, func(m *model.Message) { m.System = true })
	for i := 1; i <= markUnreadPageSize+20; i++ {
		f.add("dm-1", i, nil)
	}
	f.convSeq.seq = map[string]int64{"dm-1": 500}

	res, err := f.svc.MarkUnread(context.Background(), "u-1", "dm-1", ParentConversation, from.ID)
	if err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	want := int64(markUnreadPageSize + 21)
	if res.UnreadCount != want || f.messages.pages < 2 {
		t.Fatalf("unread = %d over %d pages, want %d over 2+", res.UnreadCount, f.messages.pages, want)
	}
	if got, _ := f.convSeq.lastRead("dm-1", "u-1"); got != 500-want {
		t.Fatalf("last read = %d, want %d", got, 500-want)
	}
	if _, data := f.lastEvent(t); data["conversationID"] != "dm-1" || data["unread"] != true {
		t.Fatalf("event %v, want {conversationID, unread}", data)
	}
}

// A counter that lags the messages (its bump is async) never goes negative:
// the watermark floors at 0 and the reported count at the counter.
func TestMarkUnread_ClampsToCounter(t *testing.T) {
	f := newUnreadFixture(t)
	from := f.add("ch-1", 1, nil)
	f.add("ch-1", 2, nil)
	f.chSeq.seq = map[string]int64{"ch-1": 1}

	res, err := f.svc.MarkUnread(context.Background(), "u-1", "ch-1", ParentChannel, from.ID)
	if err != nil || res.UnreadCount != 1 {
		t.Fatalf("MarkUnread = %+v, %v; want unread clamped to 1", res, err)
	}
	if got, _ := f.chSeq.lastRead("ch-1", "u-1"); got != 0 {
		t.Fatalf("last read = %d, want 0", got)
	}
}

// Very old messages: the walk stops at its page cap instead of scanning the
// whole history.
func TestMarkUnread_StopsAtPageCap(t *testing.T) {
	f := newUnreadFixture(t)
	from := f.add("ch-1", 0, nil)
	capped := &cappedAfterStore{pagedAfterStore: f.messages}
	f.svc.messages = capped
	f.chSeq.seq = map[string]int64{"ch-1": 10_000}

	if _, err := f.svc.MarkUnread(context.Background(), "u-1", "ch-1", ParentChannel, from.ID); err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	if capped.calls != markUnreadMaxPages {
		t.Fatalf("pages walked = %d, want the cap %d", capped.calls, markUnreadMaxPages)
	}
}

// cappedAfterStore always reports another full page.
type cappedAfterStore struct {
	*pagedAfterStore
	calls int
}

func (c *cappedAfterStore) ListMessagesAfter(_ context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	c.calls++
	page := make([]*model.Message, limit)
	for i := range page {
		page[i] = &model.Message{ID: fmt.Sprintf("%s-%04d-%03d", after, c.calls, limit-i), ParentID: parentID}
	}
	return page, true, nil
}

// A thread reply rewinds the thread's seen time to just before it (keeping
// the real write time, so List reports the rewind) and flags the thread.
func TestMarkUnread_ThreadReplyRewindsThreadSeen(t *testing.T) {
	f := newUnreadFixture(t)
	root := f.add("ch-1", 1, nil)
	reply := f.add("ch-1", 2, func(m *model.Message) { m.ParentMessageID = root.ID })

	res, err := f.svc.MarkUnread(context.Background(), "u-1", "ch-1", ParentChannel, reply.ID)
	if err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	if res.ThreadRootID != root.ID || res.SeenAt == nil || !res.SeenAt.Before(reply.CreatedAt) {
		t.Fatalf("result = %+v, want thread %s seen just before the reply", res, root.ID)
	}
	if _, ok := f.chSeq.lastRead("ch-1", "u-1"); ok {
		t.Fatal("a thread reply must not touch the channel watermark")
	}
	seen := f.state.rows[f.state.key("u-1", model.UserStateThreadSeen, root.ID)]
	flag := f.state.rows[f.state.key("u-1", model.UserStateThreadNotification, root.ID)]
	if seen == nil || flag == nil || !seen.SeenAt.Equal(*res.SeenAt) || seen.ParentID != "ch-1" || flag.ParentType != ParentChannel {
		t.Fatalf("user state = seen %+v, flag %+v", seen, flag)
	}
	state, err := NewUserStateService(f.state, nil).List(context.Background(), "u-1")
	if err != nil || state.ThreadMarkedUnread[root.ID] == "" || state.ThreadSeen[root.ID] == "" {
		t.Fatalf("List = %+v, %v; want the thread seen + marked unread", state, err)
	}
	if _, data := f.lastEvent(t); data["userState"] != true {
		t.Fatalf("event %v, want {userState: true}", data)
	}
}

func TestMarkUnread_Errors(t *testing.T) {
	ctx := context.Background()
	boom := errors.New("boom")
	cases := []struct {
		name   string
		setup  func(f *unreadFixture) (parentID, parentType, msgID string)
		wantIs error
	}{
		{"no access", func(f *unreadFixture) (string, string, string) {
			return "ch-x", ParentChannel, "m-001"
		}, ErrForbidden},
		{"missing message", func(f *unreadFixture) (string, string, string) {
			return "ch-1", ParentChannel, "m-404"
		}, store.ErrNotFound},
		{"no seq store", func(f *unreadFixture) (string, string, string) {
			f.add("ch-1", 1, nil)
			f.svc.channelSeq = nil
			return "ch-1", ParentChannel, "m-001"
		}, ErrMarkUnreadUnavailable},
		{"no user-state store", func(f *unreadFixture) (string, string, string) {
			f.add("ch-1", 2, func(m *model.Message) { m.ParentMessageID = "m-001" })
			f.svc.userState = nil
			return "ch-1", ParentChannel, "m-002"
		}, ErrMarkUnreadUnavailable},
		{"count walk fails", func(f *unreadFixture) (string, string, string) {
			f.add("ch-1", 1, nil)
			f.messages.listAfterErr = boom
			return "ch-1", ParentChannel, "m-001"
		}, boom},
		{"counter read fails", func(f *unreadFixture) (string, string, string) {
			f.add("ch-1", 1, nil)
			f.chSeq.curErr = boom
			return "ch-1", ParentChannel, "m-001"
		}, boom},
		{"watermark write fails", func(f *unreadFixture) (string, string, string) {
			f.add("ch-1", 1, nil)
			f.chSeq.lastErr = boom
			return "ch-1", ParentChannel, "m-001"
		}, boom},
		{"thread state write fails", func(f *unreadFixture) (string, string, string) {
			f.add("ch-1", 2, func(m *model.Message) { m.ParentMessageID = "m-001" })
			f.state.setErr = boom
			return "ch-1", ParentChannel, "m-002"
		}, boom},
	}
	for _, c := range cases {
		f := newUnreadFixture(t)
		parentID, parentType, msgID := c.setup(f)
		if _, err := f.svc.MarkUnread(ctx, "u-1", parentID, parentType, msgID); !errors.Is(err, c.wantIs) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.wantIs)
		}
	}
}

// List reports a thread as marked unread only for a rewound seen row — an
// ordinary "seen" carries no flag.
func TestUserStateService_ListReportsMarkedUnreadOnlyForRewinds(t *testing.T) {
	st := newMockUserStateStore()
	at := time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)
	earlier := at.Add(-time.Hour)
	_ = st.SetUserState(context.Background(), &model.UserStateItem{UserID: "u-1", Kind: model.UserStateThreadSeen, TargetID: "seen", SeenAt: &at, UpdatedAt: at})
	_ = st.SetUserState(context.Background(), &model.UserStateItem{UserID: "u-1", Kind: model.UserStateThreadSeen, TargetID: "rewound", SeenAt: &earlier, Rewound: true, UpdatedAt: at})

	state, err := NewUserStateService(st, nil).List(context.Background(), "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if _, ok := state.ThreadMarkedUnread["seen"]; ok || state.ThreadMarkedUnread["rewound"] != at.Format(time.RFC3339Nano) {
		t.Fatalf("ThreadMarkedUnread = %v, want only the rewound thread", state.ThreadMarkedUnread)
	}
}
