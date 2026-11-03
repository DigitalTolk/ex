package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// The production store pages history from the top-level index.
var _ MessageStore = (*store.MessageStoreImpl)(nil)

// indexedMessageStore adds the store's top-level index to the mock.
type indexedMessageStore struct {
	*mockMessageStore
	page      []*model.Message
	hasMore   bool
	err       error
	gotBefore string
	gotLimit  int
	calls     int
	// The forward (newer) direction; it shares hasMore and err.
	newer      []*model.Message
	gotAfter   string
	afterLimit int
	afterCalls int
}

func (s *indexedMessageStore) ListTopLevelMessages(_ context.Context, _, before string, limit int) ([]*model.Message, bool, error) {
	s.calls++
	s.gotBefore, s.gotLimit = before, limit
	return s.page, s.hasMore, s.err
}

func (s *indexedMessageStore) ListTopLevelMessagesAfter(_ context.Context, _, after string, limit int) ([]*model.Message, bool, error) {
	s.afterCalls++
	s.gotAfter, s.afterLimit = after, limit
	return s.newer, s.hasMore, s.err
}

func indexedMessageService(t *testing.T) (*MessageService, *indexedMessageStore) {
	t.Helper()
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}
	messages.messages["ch1#scan-only"] = &model.Message{ID: "scan-only", ParentID: "ch1", Body: "from the scan"}
	idx := &indexedMessageStore{mockMessageStore: messages}
	svc.messages = idx
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	return svc, idx
}

// Loading a channel page reads the top-level index: one bounded read of the
// rows it shows, instead of paging through every thread reply in between
// (up to six rounds of ListMessages for a single page).
func TestMessageService_List_ReadsTheTopLevelIndex(t *testing.T) {
	svc, idx := indexedMessageService(t)
	idx.page = []*model.Message{{ID: "top-2", ParentID: "ch1", Body: "**two**"}, {ID: "top-1", ParentID: "ch1", Body: "one"}}
	idx.hasMore = true

	msgs, hasMore, err := svc.List(context.Background(), "user-1", "ch1", ParentChannel, "cursor", 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if idx.listCalls.Load() != 0 {
		t.Fatalf("ListMessages called %d times, want the index alone", idx.listCalls.Load())
	}
	if idx.calls != 1 || idx.gotBefore != "cursor" || idx.gotLimit != 2 {
		t.Fatalf("index read calls=%d before=%q limit=%d", idx.calls, idx.gotBefore, idx.gotLimit)
	}
	if !hasMore || len(msgs) != 2 || msgs[0].ID != "top-2" {
		t.Fatalf("page = %+v hasMore=%v", msgs, hasMore)
	}
	if msgs[0].Rendered == nil || msgs[0].ParentType != ParentChannel {
		t.Fatalf("indexed page must be rendered and stamped like the scan path: %+v", msgs[0])
	}
}

// An index read failure surfaces — it is not papered over with a second,
// more expensive read against the same failing table.
func TestMessageService_List_IndexErrorSurfaces(t *testing.T) {
	svc, idx := indexedMessageService(t)
	idx.err = errors.New("index down")

	if _, _, err := svc.List(context.Background(), "user-1", "ch1", ParentChannel, "", 50); err == nil || !errors.Is(err, idx.err) {
		t.Fatalf("err = %v, want the index error", err)
	}
	if idx.listCalls.Load() != 0 {
		t.Fatalf("ListMessages called %d times after an index failure", idx.listCalls.Load())
	}
}

// Scrolling down (and the newer half of a jump) reads the top-level index
// too, instead of paging raw messages past every thread reply.
func TestMessageService_ListAfter_ReadsTheTopLevelIndex(t *testing.T) {
	svc, idx := indexedMessageService(t)
	idx.newer = []*model.Message{{ID: "top-4", ParentID: "ch1", Body: "**four**"}, {ID: "top-3", ParentID: "ch1", Body: "three"}}
	idx.hasMore = true

	msgs, hasMore, err := svc.ListAfter(context.Background(), "user-1", "ch1", ParentChannel, "top-2", 2)
	if err != nil {
		t.Fatalf("ListAfter: %v", err)
	}
	if idx.listCalls.Load() != 0 {
		t.Fatalf("raw message reads = %d, want the index alone", idx.listCalls.Load())
	}
	if idx.afterCalls != 1 || idx.gotAfter != "top-2" || idx.afterLimit != 2 {
		t.Fatalf("index read calls=%d after=%q limit=%d", idx.afterCalls, idx.gotAfter, idx.afterLimit)
	}
	if !hasMore || len(msgs) != 2 || msgs[0].ID != "top-4" {
		t.Fatalf("page = %+v hasMore=%v", msgs, hasMore)
	}
	if msgs[0].Rendered == nil || msgs[0].ParentType != ParentChannel {
		t.Fatalf("indexed page must be rendered and stamped like the scan path: %+v", msgs[0])
	}
}

func TestMessageService_ListAround_ReadsTheTopLevelIndexBothWays(t *testing.T) {
	svc, idx := indexedMessageService(t)
	idx.messages["ch1#top-2"] = &model.Message{ID: "top-2", ParentID: "ch1", Body: "target"}
	idx.page = []*model.Message{{ID: "top-1", ParentID: "ch1"}}
	idx.newer = []*model.Message{{ID: "top-3", ParentID: "ch1"}}

	msgs, _, _, err := svc.ListAround(context.Background(), "user-1", "ch1", ParentChannel, "top-2", 5, 5)
	if err != nil {
		t.Fatalf("ListAround: %v", err)
	}
	if idx.listCalls.Load() != 0 || idx.calls != 1 || idx.afterCalls != 1 || idx.gotBefore != "top-2" || idx.gotAfter != "top-2" {
		t.Fatalf("raw reads=%d index older=%d(%q) newer=%d(%q)", idx.listCalls.Load(), idx.calls, idx.gotBefore, idx.afterCalls, idx.gotAfter)
	}
	got := make([]string, len(msgs))
	for i, m := range msgs {
		got[i] = m.ID
	}
	if len(got) != 3 || got[0] != "top-3" || got[1] != "top-2" || got[2] != "top-1" {
		t.Fatalf("window = %v, want [top-3 top-2 top-1]", got)
	}
}

// An index failure on the forward page surfaces rather than retrying the
// long way.
func TestMessageService_ListAfter_IndexErrorSurfaces(t *testing.T) {
	svc, idx := indexedMessageService(t)
	idx.err = errors.New("index down")
	if _, _, err := svc.ListAfter(context.Background(), "user-1", "ch1", ParentChannel, "cursor", 50); err == nil || !errors.Is(err, idx.err) {
		t.Fatalf("err = %v, want the index error", err)
	}
	if idx.listCalls.Load() != 0 {
		t.Fatalf("raw reads = %d after an index failure", idx.listCalls.Load())
	}
}
