package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// scanThreads runs the seed scan the way the background seed does: the
// threads userID's message history shows them in.
func scanThreads(svc *MessageService, userID string) ([]*ThreadSummary, error) {
	if svc.threadFollows == nil {
		svc.SetThreadFollowStore(newMockThreadFollowStore())
	}
	ctx := context.Background()
	parents, overrides, pulled, err := svc.threadSeedInputs(ctx, userID)
	if err != nil {
		return nil, err
	}
	out, _ := svc.scanUserThreads(ctx, userID, parents, overrides, pulled)
	return out, nil
}

// seedFinished makes svc report each finished background seed scan.
func seedFinished(svc *MessageService) <-chan string {
	done := make(chan string, 8)
	svc.afterThreadSeed = func(userID string) { done <- userID }
	return done
}

func waitThreadSeed(t *testing.T, done <-chan string) string {
	t.Helper()
	select {
	case userID := <-done:
		return userID
	case <-time.After(5 * time.Second):
		t.Fatal("the background thread seed never finished")
		return ""
	}
}

// heldScanStore is a batch-capable message store whose history scan can be
// held until released, or fail for one parent.
type heldScanStore struct {
	*batchMockMessageStore
	hold       chan struct{}
	failParent string
}

func (m *heldScanStore) ListMessages(ctx context.Context, parentID, before string, limit int) ([]*model.Message, bool, error) {
	if m.hold != nil {
		<-m.hold
	}
	if parentID == m.failParent {
		m.listCalls.Add(1)
		return nil, false, errors.New("throttled")
	}
	return m.batchMockMessageStore.ListMessages(ctx, parentID, before, limit)
}

func heldScanService(store *heldScanStore) (*MessageService, *mockMembershipStore, *indexedThreadFollowStore) {
	memberships := newMockMembershipStore()
	svc := NewMessageService(store, memberships, newMockConversationStore(), newMockPublisher(), newMockBroker())
	svc.SetParentIndex(newMockParentIndex())
	follows := &indexedThreadFollowStore{mockThreadFollowStore: newMockThreadFollowStore()}
	svc.SetThreadFollowStore(follows)
	return svc, memberships, follows
}

// Regression: an account not yet seeded (every account the history importer
// created) ran the seed scan — up to 25×200 messages in each of its channels
// and DMs — inside the /threads request. Hundreds of parents took longer than
// the client waits, and the phone's chat shows nothing until this list
// arrives. The list now comes from the index at once and the scan runs on.
func TestListThreadsPage_DoesNotWaitForTheSeedScan(t *testing.T) {
	store := &heldScanStore{batchMockMessageStore: &batchMockMessageStore{mockMessageStore: newMockMessageStore()}, hold: make(chan struct{})}
	svc, memberships, follows := heldScanService(store)
	seeds := seedFinished(svc)
	seedMembership(memberships, "ch-1", "u-1")
	at := time.Now().Add(-time.Hour)
	store.messages["ch-1#root-a"] = &model.Message{ID: "root-a", ParentID: "ch-1", AuthorID: "u-2", Body: "imported", CreatedAt: at, ReplyCount: 1}
	follows.follows[threadFollowMockKey("u-1", "ch-1", "root-a")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "root-a", Following: true, LastActivityAt: &at}

	answered := make(chan error, 1)
	go func() {
		_, err := svc.ListThreadsPage(context.Background(), "u-1", "", 0)
		answered <- err
	}()
	select {
	case err := <-answered:
		if err != nil {
			t.Fatalf("first page: %v", err)
		}
	case <-time.After(2 * time.Second):
		close(store.hold)
		t.Fatal("the list waited for the seed scan")
	}
	// The imported thread lists from its follow row meanwhile.
	page, err := svc.ListThreadsPage(context.Background(), "u-1", threadCursorFollowed, 0)
	if err != nil || len(page.Threads) != 1 || page.Threads[0].ThreadRootID != "root-a" {
		t.Fatalf("followed page = %+v (err %v), want root-a", page, err)
	}

	close(store.hold)
	waitThreadSeed(t, seeds)
	if !follows.seeded {
		t.Fatal("the background scan did not mark the account seeded")
	}
}

// Regression: a parent the scan could not read (DynamoDB throttling under an
// import) was skipped silently and the user still marked seeded — the threads
// of that parent would never be rediscovered.
func TestThreadSeed_ScanThatMissedAParentSeedsNothing(t *testing.T) {
	store := &heldScanStore{batchMockMessageStore: &batchMockMessageStore{mockMessageStore: newMockMessageStore()}, failParent: "ch-2"}
	svc, memberships, follows := heldScanService(store)
	seeds := seedFinished(svc)
	memberships.userChannels = []*model.UserChannel{{UserID: "u-1", ChannelID: "ch-1"}, {UserID: "u-1", ChannelID: "ch-2"}}
	at := time.Now().Add(-time.Hour)
	store.messages["ch-1#root-a"] = &model.Message{ID: "root-a", ParentID: "ch-1", AuthorID: "u-1", CreatedAt: at, ReplyCount: 1}

	if _, err := svc.ListThreadsPage(context.Background(), "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	waitThreadSeed(t, seeds)
	if follows.seeded {
		t.Fatal("marked seeded although ch-2 could not be scanned")
	}
	if f := follows.follows[threadFollowMockKey("u-1", "ch-1", "root-a")]; f != nil {
		t.Fatalf("persisted a partial seed: %+v", f)
	}
}

// One seed scan per user at a time, and at most maxThreadSeeds at once: a
// burst of first visits after an import must not stack scans on DynamoDB.
func TestThreadSeed_BoundsTheSeedScans(t *testing.T) {
	store := &heldScanStore{batchMockMessageStore: &batchMockMessageStore{mockMessageStore: newMockMessageStore()}, hold: make(chan struct{})}
	svc, memberships, follows := heldScanService(store)
	seeds := seedFinished(svc)
	users := []string{"u-1", "u-2", "u-3"}
	for _, u := range users {
		memberships.userChannels = append(memberships.userChannels, &model.UserChannel{UserID: u, ChannelID: "ch-" + u})
	}
	ctx := context.Background()
	for _, u := range append(users, "u-1") {
		if _, err := svc.ListThreadsPage(ctx, u, "", 0); err != nil {
			t.Fatalf("ListThreadsPage(%s): %v", u, err)
		}
	}
	svc.threadSeeds.mu.Lock()
	running := len(svc.threadSeeds.running)
	_, third := svc.threadSeeds.running["u-3"]
	svc.threadSeeds.mu.Unlock()
	if running != maxThreadSeeds || third {
		t.Fatalf("running seeds = %d (u-3 among them: %v), want %d without u-3", running, third, maxThreadSeeds)
	}

	close(store.hold)
	for range maxThreadSeeds {
		waitThreadSeed(t, seeds)
	}
	select {
	case u := <-seeds:
		t.Fatalf("an extra seed ran for %s", u)
	default:
	}
	// A slot freed: the next visit of the user turned away starts theirs.
	// (The double keeps one seed marker for everyone; u-3 has none yet.)
	follows.seeded = false
	if _, err := svc.ListThreadsPage(ctx, "u-3", "", 0); err != nil {
		t.Fatalf("ListThreadsPage(u-3): %v", err)
	}
	if u := waitThreadSeed(t, seeds); u != "u-3" {
		t.Fatalf("seeded %s, want u-3", u)
	}
}

// overlapBatchStore records how many root reads run at once. Each read waits
// briefly for a second one to start, so reads issued one after another show
// up as never overlapping.
type overlapBatchStore struct {
	*batchMockMessageStore
	mu          sync.Mutex
	inFlight    int
	maxInFlight int
	second      chan struct{}
	once        sync.Once
}

func (m *overlapBatchStore) GetMessagesByIDs(ctx context.Context, parentID string, ids []string) ([]*model.Message, error) {
	m.mu.Lock()
	m.inFlight++
	m.maxInFlight = max(m.maxInFlight, m.inFlight)
	if m.inFlight == 2 {
		m.once.Do(func() { close(m.second) })
	}
	m.mu.Unlock()
	select {
	case <-m.second:
	case <-time.After(time.Second):
	}
	defer func() {
		m.mu.Lock()
		m.inFlight--
		m.mu.Unlock()
	}()
	return m.batchMockMessageStore.GetMessagesByIDs(ctx, parentID, ids)
}

// Regression: an account that follows threads in hundreds of channels had
// their roots read one channel after another. A page reads its channels'
// roots together.
func TestListThreadsPage_ReadsParentsInParallel(t *testing.T) {
	store := &overlapBatchStore{batchMockMessageStore: &batchMockMessageStore{mockMessageStore: newMockMessageStore()}, second: make(chan struct{})}
	memberships := newMockMembershipStore()
	svc := NewMessageService(store, memberships, newMockConversationStore(), newMockPublisher(), newMockBroker())
	svc.SetParentIndex(newMockParentIndex())
	follows := &indexedThreadFollowStore{mockThreadFollowStore: newMockThreadFollowStore(), seeded: true}
	svc.SetThreadFollowStore(follows)
	const perParent = 10
	base := time.Now().Add(-time.Hour)
	for p, ch := range []string{"ch-1", "ch-2"} {
		seedMembership(memberships, ch, "u-1")
		for i := range perParent {
			id := fmt.Sprintf("root-%03d", i)
			at := base.Add(time.Duration(2*i+p) * time.Second)
			store.messages[ch+"#"+id] = &model.Message{ID: id, ParentID: ch, AuthorID: "u-2", CreatedAt: at, ReplyCount: 1}
			follows.follows[threadFollowMockKey("u-1", ch, id)] = &model.ThreadFollow{UserID: "u-1", ParentID: ch, ParentType: ParentChannel, ThreadRootID: id, Following: true, LastActivityAt: &at}
		}
	}

	page, err := svc.ListThreadsPage(context.Background(), "u-1", threadCursorFollowed, 2*perParent)
	if err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	if len(page.Threads) != 2*perParent {
		t.Fatalf("threads = %d, want %d", len(page.Threads), 2*perParent)
	}
	// Latest reply first, across both channels.
	if page.Threads[0].ParentID != "ch-2" || page.Threads[0].ThreadRootID != "root-009" {
		t.Fatalf("first = %s/%s, want ch-2/root-009", page.Threads[0].ParentID, page.Threads[0].ThreadRootID)
	}
	if len(store.batchSizes) != 2 {
		t.Fatalf("root reads = %v, want one batch per channel", store.batchSizes)
	}
	if store.maxInFlight < 2 {
		t.Fatalf("root reads in flight at once = %d, want the channels read together", store.maxInFlight)
	}
}
