package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// threadListService is a service with the paged-list collaborators: a seeded
// follow index, user state, and a publisher to watch.
func threadListService(t *testing.T) (*MessageService, *batchMockMessageStore, *mockMembershipStore, *mockConversationStore, *indexedThreadFollowStore, *mockUserStateStore, *mockPublisher) {
	t.Helper()
	messages := &batchMockMessageStore{mockMessageStore: newMockMessageStore()}
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	publisher := newMockPublisher()
	svc := NewMessageService(messages, memberships, conversations, publisher, newMockBroker())
	svc.SetParentIndex(newMockParentIndex())
	follows := &indexedThreadFollowStore{mockThreadFollowStore: newMockThreadFollowStore(), seeded: true}
	svc.SetThreadFollowStore(follows)
	state := newMockUserStateStore()
	svc.SetUserStateStore(state)
	return svc, messages, memberships, conversations, follows, state, publisher
}

func addMarker(state *mockUserStateStore, userID, parentID, parentType, rootID string, at time.Time) {
	state.rows[state.key(userID, model.UserStateThreadNotification, rootID)] = &model.UserStateItem{
		UserID: userID, Kind: model.UserStateThreadNotification, TargetID: rootID,
		ParentID: parentID, ParentType: parentType, ThreadRootID: rootID, UpdatedAt: at,
	}
}

func addRoot(messages *batchMockMessageStore, parentID, id string, at time.Time) {
	messages.messages[parentID+"#"+id] = &model.Message{ID: id, ParentID: parentID, AuthorID: "u-2", Body: id, CreatedAt: at, ReplyCount: 1, LastReplyAt: &at}
}

func pageRoots(p *ThreadPage) []string {
	ids := make([]string, len(p.Threads))
	for i, s := range p.Threads {
		ids[i] = s.ThreadRootID
	}
	return ids
}

func userStateEvents(p *mockPublisher, userID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.published {
		if e.channel == pubsub.UserChannel(userID) && e.event.Type == events.EventUserChannelUpdated {
			n++
		}
	}
	return n
}

// The list starts with the unread threads, the latest alert first, a page at
// a time; then it goes on to the followed threads, latest reply first,
// without the unread ones again.
func TestListThreadsPage_UnreadThenFollowed(t *testing.T) {
	svc, messages, memberships, _, follows, state, _ := threadListService(t)
	ctx := context.Background()
	seedMembership(memberships, "ch-1", "u-1")
	base := time.Now().Add(-time.Hour).Truncate(time.Second)
	for i, id := range []string{"unread-old", "unread-new", "read-old", "read-new"} {
		addRoot(messages, "ch-1", id, base.Add(time.Duration(i)*time.Minute))
	}
	addMarker(state, "u-1", "ch-1", ParentChannel, "unread-old", base.Add(time.Minute))
	addMarker(state, "u-1", "ch-1", ParentChannel, "unread-new", base.Add(2*time.Minute))
	for i, id := range []string{"unread-new", "read-old", "read-new"} {
		at := base.Add(time.Duration(i+1) * time.Minute)
		follows.follows[threadFollowMockKey("u-1", "ch-1", id)] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: id, Following: true, LastActivityAt: &at}
	}

	// One thread a page; the list may end on an empty page.
	var got []string
	var unread []bool
	for cursor := ""; ; {
		page, err := svc.ListThreadsPage(ctx, "u-1", cursor, 1)
		if err != nil {
			t.Fatalf("ListThreadsPage(%q): %v", cursor, err)
		}
		if len(page.Threads) > 1 {
			t.Fatalf("page of %d threads, want at most 1", len(page.Threads))
		}
		for _, s := range page.Threads {
			got = append(got, s.ThreadRootID)
			unread = append(unread, s.Unread)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	want := []string{"unread-new", "unread-old", "read-new", "read-old"}
	if len(got) != len(want) {
		t.Fatalf("threads = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] || unread[i] != (i < 2) {
			t.Fatalf("threads = %v (unread %v), want %v", got, unread, want)
		}
	}
	// The unread channel thread without a follow row isn't followed; the one
	// with a row is.
	first, _ := svc.ListThreadsPage(ctx, "u-1", "", 0)
	following := map[string]bool{}
	for _, s := range first.Threads {
		following[s.ThreadRootID] = s.Following
	}
	if !following["unread-new"] || following["unread-old"] {
		t.Fatalf("following = %v, want unread-new only", following)
	}
	if messages.listCalls.Load() != 0 {
		t.Fatalf("scans = %d, want 0", messages.listCalls.Load())
	}
}

// Regression: the sidebar's Threads dot now reads the unread markers alone,
// so a marker for a thread the user can no longer open (a channel they left,
// a deleted root) would light it for good. Listing the unread threads drops
// such markers and tells the user's clients.
func TestListThreadsPage_DropsMarkersThatCanNotBeOpened(t *testing.T) {
	svc, messages, memberships, _, _, state, publisher := threadListService(t)
	dropped := make(chan string, 1)
	svc.afterThreadMarkersDropped = func(userID string) { dropped <- userID }
	ctx := context.Background()
	seedMembership(memberships, "ch-1", "u-1")
	at := time.Now().Add(-time.Hour)
	addRoot(messages, "ch-1", "kept", at)
	addRoot(messages, "ch-left", "left", at)
	addMarker(state, "u-1", "ch-1", ParentChannel, "kept", at)
	addMarker(state, "u-1", "ch-1", ParentChannel, "deleted", at.Add(time.Second))
	addMarker(state, "u-1", "ch-left", ParentChannel, "left", at.Add(2*time.Second))

	page, err := svc.ListThreadsPage(ctx, "u-1", "", 0)
	if err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	if ids := pageRoots(page); len(ids) != 1 || ids[0] != "kept" {
		t.Fatalf("threads = %v, want only kept", ids)
	}
	select {
	case <-dropped:
	case <-time.After(5 * time.Second):
		t.Fatal("stale markers never dropped")
	}
	rows, _ := state.ListUserState(ctx, "u-1")
	if len(rows) != 1 || rows[0].ThreadRootID != "kept" {
		t.Fatalf("markers left = %+v, want only kept", rows)
	}
	if userStateEvents(publisher, "u-1") != 1 {
		t.Fatal("the user's clients were not told their state changed")
	}

	// A delete that fails stops there and tells nobody.
	addMarker(state, "u-1", "ch-left", ParentChannel, "left", at)
	state.deleteErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	<-dropped
	if userStateEvents(publisher, "u-1") != 1 {
		t.Fatal("a failed drop must not announce a change")
	}
}

func TestListThreadsPage_Errors(t *testing.T) {
	ctx := context.Background()
	at := time.Now().Add(-time.Hour)

	svc, messages, memberships, _, follows, state, _ := threadListService(t)
	seedMembership(memberships, "ch-1", "u-1")
	addRoot(messages, "ch-1", "r", at)
	addMarker(state, "u-1", "ch-1", ParentChannel, "r", at)

	if _, err := svc.ListThreadsPage(ctx, "u-1", "bogus", 0); err == nil {
		t.Fatal("expected a bad cursor to be refused")
	}
	follows.getManyErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err == nil {
		t.Fatal("expected the follow read error")
	}
	follows.getManyErr = nil
	memberships.getErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err == nil {
		t.Fatal("expected the membership error")
	}
	memberships.getErr = nil
	state.listErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err == nil {
		t.Fatal("expected the user state error")
	}
}

// A page passes over followed threads it can't show and reads on, up to
// threadPageRounds reads; past that it hands back a cursor to go on from.
func TestListThreadsPage_ReadsPastThreadsItCanNotShow(t *testing.T) {
	svc, messages, memberships, _, follows, _, _ := threadListService(t)
	ctx := context.Background()
	seedMembership(memberships, "ch-1", "u-1")
	base := time.Now().Add(-time.Hour)
	follow := func(parentID, id string, at time.Time) {
		follows.follows[threadFollowMockKey("u-1", parentID, id)] = &model.ThreadFollow{UserID: "u-1", ParentID: parentID, ParentType: ParentChannel, ThreadRootID: id, Following: true, LastActivityAt: &at}
	}
	// Newest first: two in a channel the user left, then one they can open.
	follow("ch-left", "gone-1", base.Add(3*time.Minute))
	follow("ch-left", "gone-2", base.Add(2*time.Minute))
	addRoot(messages, "ch-1", "shown", base.Add(time.Minute))
	follow("ch-1", "shown", base.Add(time.Minute))

	page, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 1)
	if err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	if ids := pageRoots(page); len(ids) != 1 || ids[0] != "shown" || page.NextCursor != "" {
		t.Fatalf("page = %v next %q, want shown and the end", ids, page.NextCursor)
	}
	if follows.activityReads != 3 {
		t.Fatalf("follow reads = %d, want 3", follows.activityReads)
	}

	// With more unshowable threads than rounds, the page comes back empty
	// but says where to go on.
	for i := range threadPageRounds + 1 {
		follow("ch-left", "more-"+string(rune('a'+i)), base.Add(time.Hour+time.Duration(i)*time.Minute))
	}
	page, err = svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 1)
	if err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	if len(page.Threads) != 0 || page.NextCursor == "" {
		t.Fatalf("page = %+v, want empty with a cursor", page)
	}
}

// A store without the seed capability never schedules a seed, and a page
// size over the maximum is capped.
func TestListThreadsPage_PlainStoreAndPageSize(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	page, err := svc.ListThreadsPage(context.Background(), "u-1", "", MaxThreadPageSize*10)
	if err != nil || len(page.Threads) != 0 || page.NextCursor != threadCursorFollowed {
		t.Fatalf("page = %+v (err %v), want an empty unread part", page, err)
	}
}

// The thread panel's Follow button asks for one thread: the user's row
// decides; without one a DM's threads are followed and a channel's not.
func TestThreadFollowing(t *testing.T) {
	svc, _, memberships, conversations, follows, _, _ := threadListService(t)
	ctx := context.Background()
	seedMembership(memberships, "ch-1", "u-1")
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	follows.follows[threadFollowMockKey("u-1", "ch-1", "on")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ThreadRootID: "on", Following: true}
	follows.follows[threadFollowMockKey("u-1", "dm-1", "off")] = &model.ThreadFollow{UserID: "u-1", ParentID: "dm-1", ThreadRootID: "off", Following: false}

	for _, tc := range []struct {
		parentID, parentType, root string
		want                       bool
	}{
		{"ch-1", ParentChannel, "on", true},
		{"ch-1", ParentChannel, "none", false},
		{"dm-1", ParentConversation, "none", true},
		{"dm-1", ParentConversation, "off", false},
	} {
		got, err := svc.ThreadFollowing(ctx, "u-1", tc.parentID, tc.parentType, tc.root)
		if err != nil || got != tc.want {
			t.Errorf("%s/%s = %v (err %v), want %v", tc.parentID, tc.root, got, err, tc.want)
		}
	}
	if _, err := svc.ThreadFollowing(ctx, "u-1", "ch-1", "bogus", "on"); err == nil {
		t.Error("expected an invalid parent type to be refused")
	}
	if _, err := svc.ThreadFollowing(ctx, "u-1", "ch-other", ParentChannel, "on"); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-member err = %v, want forbidden", err)
	}
	failing := &failingGetFollowStore{indexedThreadFollowStore: follows}
	svc.SetThreadFollowStore(failing)
	if _, err := svc.ThreadFollowing(ctx, "u-1", "ch-1", ParentChannel, "on"); err == nil {
		t.Error("expected the store error")
	}
}

type failingGetFollowStore struct {
	*indexedThreadFollowStore
}

func (failingGetFollowStore) GetThreadFollow(context.Context, string, string, string) (*model.ThreadFollow, error) {
	return nil, errors.New("dynamo down")
}

// A reply moves its thread up the list of everyone following it — and only
// theirs.
func TestSend_ReplyMovesTheThreadUpForItsFollowers(t *testing.T) {
	svc, messages, memberships, _, follows, _, _ := threadListService(t)
	ctx := context.Background()
	for _, u := range []string{"u-replier", "u-follower", "u-unfollowed"} {
		seedMembership(memberships, "ch-1", u)
	}
	old := time.Now().Add(-24 * time.Hour)
	messages.messages["ch-1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch-1", AuthorID: "u-root", Body: "root", CreatedAt: old}
	follows.follows[threadFollowMockKey("u-follower", "ch-1", "root-1")] = &model.ThreadFollow{UserID: "u-follower", ParentID: "ch-1", ThreadRootID: "root-1", Following: true, LastActivityAt: &old}
	follows.follows[threadFollowMockKey("u-unfollowed", "ch-1", "root-1")] = &model.ThreadFollow{UserID: "u-unfollowed", ParentID: "ch-1", ThreadRootID: "root-1", Following: false, LastActivityAt: &old}

	reply, err := svc.Send(ctx, "u-replier", "ch-1", ParentChannel, "a reply", "root-1")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	for user, want := range map[string]time.Time{"u-follower": reply.CreatedAt, "u-replier": reply.CreatedAt, "u-unfollowed": old} {
		f := follows.follows[threadFollowMockKey(user, "ch-1", "root-1")]
		if f == nil || f.LastActivityAt == nil || !f.LastActivityAt.Equal(want) {
			t.Errorf("%s row = %+v, want latest activity %v", user, f, want)
		}
	}

	// Failures to read the followers or move them are logged; the reply
	// still goes out.
	follows.listErr = errors.New("dynamo down")
	if _, err := svc.Send(ctx, "u-replier", "ch-1", ParentChannel, "again", "root-1"); err != nil {
		t.Fatalf("Send with follower read failing: %v", err)
	}
	follows.listErr = nil
	follows.touchErr = errors.New("dynamo down")
	if _, err := svc.Send(ctx, "u-replier", "ch-1", ParentChannel, "and again", "root-1"); err != nil {
		t.Fatalf("Send with touch failing: %v", err)
	}
}

// Following a thread files it under its latest reply.
func TestSetThreadFollow_FilesTheThreadUnderItsLatestReply(t *testing.T) {
	svc, messages, memberships, _, follows, _, _ := threadListService(t)
	seedMembership(memberships, "ch-1", "u-1")
	created := time.Now().Add(-2 * time.Hour)
	last := time.Now().Add(-time.Hour)
	messages.messages["ch-1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch-1", AuthorID: "u-2", CreatedAt: created, ReplyCount: 2, LastReplyAt: &last}
	if err := svc.SetThreadFollow(context.Background(), "u-1", "ch-1", ParentChannel, "root-1", true); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	if f := follows.follows[threadFollowMockKey("u-1", "ch-1", "root-1")]; f.LastActivityAt == nil || !f.LastActivityAt.Equal(last) {
		t.Fatalf("row = %+v, want the latest reply", f)
	}
}
