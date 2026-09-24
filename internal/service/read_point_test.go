package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// rid builds a valid, ordered ULID for tests: rid(1) < rid(2) < ...
func rid(n int) string { return fmt.Sprintf("01J%023d", n) }

func putMsg(ms *mockMessageStore, m *model.Message) { ms.messages[m.ParentID+"#"+m.ID] = m }

func TestResolveReadPoint(t *testing.T) {
	ctx := context.Background()
	now := time.UnixMilli(1_700_000_000_000)
	watermark := store.ReadWatermarkID(now)

	cases := []struct {
		name    string
		msgs    []*model.Message
		noStore bool
		upTo    string
		wantSeq int64
		wantMsg string
		wantErr error
		// The parent's newest seq was claimed within the settle window.
		unsettled bool
	}{
		{name: "read everything", upTo: "", wantSeq: 7, wantMsg: watermark},
		{name: "no message store falls back to everything", noStore: true, upTo: rid(3), wantSeq: 7, wantMsg: watermark},
		{
			name:    "up to a message with later counted messages keeps its own seq",
			msgs:    []*model.Message{{ID: rid(3), Seq: 3}, {ID: rid(4), Seq: 4}},
			upTo:    rid(3),
			wantSeq: 3, wantMsg: rid(3),
		},
		{
			// A seq claimed by a failed send (or an inversion) would leave a
			// phantom unread: reading the newest message takes the current seq.
			name:    "up to the newest message clears phantoms with the current seq",
			msgs:    []*model.Message{{ID: rid(3), Seq: 5}},
			upTo:    rid(3),
			wantSeq: 7, wantMsg: rid(3),
		},
		{
			name:    "thread replies and system notices after it don't count",
			msgs:    []*model.Message{{ID: rid(3), Seq: 5}, {ID: rid(4), ParentMessageID: rid(3)}, {ID: rid(5), System: true}},
			upTo:    rid(3),
			wantSeq: 7, wantMsg: rid(3),
		},
		{
			// A seq claimed moments ago may belong to a message still being
			// written: don't catch up to it yet.
			name:      "caught up but the newest seq is unsettled keeps the anchor's seq",
			msgs:      []*model.Message{{ID: rid(3), Seq: 5}},
			upTo:      rid(3),
			unsettled: true,
			wantSeq:   5, wantMsg: rid(3),
		},
		{
			name:      "an unsettled pre-Seq anchor still falls back to the current seq",
			msgs:      []*model.Message{{ID: rid(3)}},
			upTo:      rid(3),
			unsettled: true,
			wantSeq:   7, wantMsg: rid(3),
		},
		{
			name:    "a seq above an eventually-consistent parent read is kept",
			msgs:    []*model.Message{{ID: rid(3), Seq: 9}},
			upTo:    rid(3),
			wantSeq: 9, wantMsg: rid(3),
		},
		{
			name:    "pre-Seq anchor is bounded by the next counted message",
			msgs:    []*model.Message{{ID: rid(3)}, {ID: rid(6), Seq: 6}, {ID: rid(5), Seq: 5}},
			upTo:    rid(3),
			wantSeq: 4, wantMsg: rid(3),
		},
		{
			name:    "pre-Seq anchor followed only by pre-Seq messages falls back",
			msgs:    []*model.Message{{ID: rid(3)}, {ID: rid(4)}},
			upTo:    rid(3),
			wantSeq: 7, wantMsg: rid(3),
		},
		{name: "malformed ID rejected", upTo: "not-a-ulid", wantErr: ErrValidation},
		{name: "unknown message rejected", upTo: rid(99), wantErr: ErrValidation},
		{
			name:    "thread reply rejected",
			msgs:    []*model.Message{{ID: rid(3), ParentMessageID: rid(1)}},
			upTo:    rid(3),
			wantErr: ErrValidation,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ms := newMockMessageStore()
			for _, m := range tc.msgs {
				m.ParentID = "p1"
				putMsg(ms, m)
			}
			var messages MessageStore = ms
			if tc.noStore {
				messages = nil
			}
			seq, msgID, err := resolveReadPoint(ctx, messages, "p1", 7, !tc.unsettled, tc.upTo, now)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if seq != tc.wantSeq || msgID != tc.wantMsg {
				t.Errorf("got (%d, %q), want (%d, %q)", seq, msgID, tc.wantSeq, tc.wantMsg)
			}
		})
	}
}

// More later messages than the look-ahead can prove: keep the anchor's seq.
func TestResolveReadPoint_LookaheadExhausted(t *testing.T) {
	ms := newMockMessageStore()
	ms.listHasMore = true
	putMsg(ms, &model.Message{ID: rid(1), ParentID: "p1", Seq: 1})
	for i := 2; i <= readPointLookahead+3; i++ {
		putMsg(ms, &model.Message{ID: rid(i), ParentID: "p1", ParentMessageID: rid(1)})
	}
	seq, _, err := resolveReadPoint(context.Background(), ms, "p1", 40, true, rid(1), time.Now())
	if err != nil || seq != 1 {
		t.Fatalf("got (%d, %v), want (1, nil)", seq, err)
	}
}

// pagedStore honours ListMessagesAfter's cursor and limit (the shared mock
// ignores both), to exercise the look-ahead's paging past thread replies.
type pagedStore struct {
	*mockMessageStore
	calls int
}

func (p *pagedStore) ListMessagesAfter(_ context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	p.calls++
	var all []*model.Message
	for _, m := range p.messages {
		if m.ParentID == parentID && m.ID > after {
			all = append(all, m)
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ID < all[j].ID })
	hasMore := len(all) > limit
	if hasMore {
		all = all[:limit]
	}
	return all, hasMore, nil
}

// A long thread under the newest message spills past one page: the probe
// pages on and still proves "caught up"...
func TestResolveReadPoint_PagesPastThreadReplies(t *testing.T) {
	ps := &pagedStore{mockMessageStore: newMockMessageStore()}
	putMsg(ps.mockMessageStore, &model.Message{ID: rid(1), ParentID: "p1", Seq: 1})
	for i := 2; i <= readPointLookahead+5; i++ {
		putMsg(ps.mockMessageStore, &model.Message{ID: rid(i), ParentID: "p1", ParentMessageID: rid(1)})
	}
	seq, _, err := resolveReadPoint(context.Background(), ps, "p1", 9, true, rid(1), time.Now())
	if err != nil || seq != 9 || ps.calls != 2 {
		t.Fatalf("got (%d, %v) in %d pages, want (9, nil) in 2", seq, err, ps.calls)
	}
}

// ...and finds a counted message beyond the first page.
func TestResolveReadPoint_FindsCountedMessageOnLaterPage(t *testing.T) {
	ps := &pagedStore{mockMessageStore: newMockMessageStore()}
	putMsg(ps.mockMessageStore, &model.Message{ID: rid(1), ParentID: "p1", Seq: 1})
	for i := 2; i <= readPointLookahead+5; i++ {
		putMsg(ps.mockMessageStore, &model.Message{ID: rid(i), ParentID: "p1", ParentMessageID: rid(1)})
	}
	putMsg(ps.mockMessageStore, &model.Message{ID: rid(99), ParentID: "p1", Seq: 2})
	seq, _, err := resolveReadPoint(context.Background(), ps, "p1", 9, true, rid(1), time.Now())
	if err != nil || seq != 1 {
		t.Fatalf("got (%d, %v), want (1, nil) — message 99 is still unread", seq, err)
	}
}

func TestSeqSettled(t *testing.T) {
	now := time.Now()
	if !seqSettled(time.Time{}, now) {
		t.Error("a row without lastSeqAt is settled")
	}
	if seqSettled(now.Add(-time.Second), now) {
		t.Error("a seq claimed 1s ago is not settled")
	}
	if !seqSettled(now.Add(-readPointSettleWindow), now) {
		t.Error("a seq claimed a full window ago is settled")
	}
}

// Store failures other than not-found surface as-is (not as a 400).
func TestResolveReadPoint_StoreErrors(t *testing.T) {
	ms := newMockMessageStore()
	ms.getErr = errors.New("boom")
	if _, _, err := resolveReadPoint(context.Background(), ms, "p1", 7, true, rid(3), time.Now()); err == nil || errors.Is(err, ErrValidation) {
		t.Fatalf("get error: err = %v, want a non-validation error", err)
	}
	ms = newMockMessageStore()
	putMsg(ms, &model.Message{ID: rid(3), ParentID: "p1", Seq: 3})
	ms.listAfterErr = errors.New("boom")
	if _, _, err := resolveReadPoint(context.Background(), ms, "p1", 7, true, rid(3), time.Now()); err == nil || errors.Is(err, ErrValidation) {
		t.Fatalf("list error: err = %v, want a non-validation error", err)
	}
}

// With upToMsgID the channel read point lands on that message, not the head —
// and a non-member is refused BEFORE any message lookup (no ID probing).
func TestMarkChannelRead_UpToMessage(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	messages := newMockMessageStore()
	svc := NewChannelService(channels, memberships, newMockUserStore(), messages, newMockCache(), newMockBroker(), newMockPublisher())
	channels.channels["ch-7"] = &model.Channel{ID: "ch-7", Name: "seven", Type: model.ChannelTypePublic, MessageSeq: 7}
	memberships.memberships["ch-7#user-1"] = &model.ChannelMembership{ChannelID: "ch-7", UserID: "user-1", Role: model.ChannelRoleMember}
	putMsg(messages, &model.Message{ID: rid(5), ParentID: "ch-7", Seq: 5})
	putMsg(messages, &model.Message{ID: rid(6), ParentID: "ch-7", Seq: 6})

	if err := svc.MarkChannelRead(context.Background(), "user-1", "ch-7", rid(5)); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	if got := memberships.lastReadSeqs["ch-7#user-1"]; got != 5 {
		t.Errorf("lastReadSeq = %d, want 5 (message 6 stays unread)", got)
	}
	if got := memberships.lastReadMsgIDs["ch-7#user-1"]; got != rid(5) {
		t.Errorf("lastReadMsgID = %q, want %q", got, rid(5))
	}
	if err := svc.MarkChannelRead(context.Background(), "user-1", "ch-7", rid(99)); !errors.Is(err, ErrValidation) {
		t.Fatalf("unknown upTo: err = %v, want ErrValidation", err)
	}
	if err := svc.MarkChannelRead(context.Background(), "stranger", "ch-7", rid(99)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("non-member: err = %v, want ErrNotFound (never a probing 400)", err)
	}
}

// The conversation twin, including the SetMessageStore wiring.
func TestMarkConversationRead_UpToMessage(t *testing.T) {
	svc, convStore, _, _, _ := setupConversationService()
	messages := newMockMessageStore()
	svc.SetMessageStore(messages)
	convStore.conversations["c1"] = &model.Conversation{ID: "c1", ParticipantIDs: []string{"u-1", "u-2"}, MessageSeq: 4}
	convStore.userConvs["u-1"] = []*model.UserConversation{{UserID: "u-1", ConversationID: "c1"}}
	putMsg(messages, &model.Message{ID: rid(2), ParentID: "c1", Seq: 2})
	putMsg(messages, &model.Message{ID: rid(3), ParentID: "c1", Seq: 3})

	if err := svc.MarkConversationRead(context.Background(), "u-1", "c1", rid(2)); err != nil {
		t.Fatalf("MarkConversationRead: %v", err)
	}
	uc := convStore.userConvs["u-1"][0]
	if uc.LastReadSeq != 2 || uc.LastReadMsgID != rid(2) {
		t.Errorf("read point = (%d, %q), want (2, %q)", uc.LastReadSeq, uc.LastReadMsgID, rid(2))
	}
	if err := svc.MarkConversationRead(context.Background(), "u-1", "c1", rid(99)); !errors.Is(err, ErrValidation) {
		t.Fatalf("unknown upTo: err = %v, want ErrValidation", err)
	}
}

// A stale read (the stored point is already past it) succeeds but announces
// NOTHING: its unreadCount/lastRead* would describe a point never stored, and
// every tab SETs its badge from the echo.
func TestMarkRead_StaleWritePublishesNothing(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	publisher := newMockPublisher()
	chSvc := NewChannelService(channels, memberships, newMockUserStore(), newMockMessageStore(), newMockCache(), newMockBroker(), publisher)
	channels.channels["ch-1"] = &model.Channel{ID: "ch-1", Name: "one", Type: model.ChannelTypePublic, MessageSeq: 3}
	memberships.setLastReadErr = store.ErrStaleReadPoint
	if err := chSvc.MarkChannelRead(context.Background(), "u-1", "ch-1", ""); err != nil {
		t.Fatalf("stale channel read: %v", err)
	}

	convSvc, convStore, _, _, convPub := setupConversationService()
	convStore.conversations["c1"] = &model.Conversation{ID: "c1", MessageSeq: 3}
	convStore.lastReadErr = store.ErrStaleReadPoint
	if err := convSvc.MarkConversationRead(context.Background(), "u-1", "c1", ""); err != nil {
		t.Fatalf("stale conversation read: %v", err)
	}
	if len(publisher.published) != 0 || len(convPub.published) != 0 {
		t.Fatalf("stale reads published %d/%d events, want none", len(publisher.published), len(convPub.published))
	}
}

// An applied read announces the seq pair with the count and read point.
func TestMarkChannelRead_EchoCarriesReadPoint(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	publisher := newMockPublisher()
	svc := NewChannelService(channels, memberships, newMockUserStore(), newMockMessageStore(), newMockCache(), newMockBroker(), publisher)
	channels.channels["ch-1"] = &model.Channel{ID: "ch-1", Name: "one", Type: model.ChannelTypePublic, MessageSeq: 3}
	if err := svc.MarkChannelRead(context.Background(), "u-1", "ch-1", ""); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	if len(publisher.published) != 1 {
		t.Fatalf("published %d events, want 1", len(publisher.published))
	}
	raw := string(publisher.published[0].event.Data)
	for _, want := range []string{`"unreadCount":0`, `"lastReadSeq":3`, `"messageSeq":3`, `"lastReadMsgID":"`} {
		if !strings.Contains(raw, want) {
			t.Errorf("echo %s missing %s", raw, want)
		}
	}
}

// The author's own read losing a race to a newer read is not worth a WARN.
func TestMessageService_WriteAuthorRead_StaleIsSilent(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	svc.writeAuthorRead(context.Background(), &mockUnreadSeqStore{lastErr: store.ErrStaleReadPoint}, "ch1", "user-1", 1, rid(1))
}
