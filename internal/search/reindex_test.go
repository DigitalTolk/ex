package search

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type fakeSources struct {
	users    []*model.User
	channels []*model.Channel
	convs    []*model.Conversation
	msgs     map[string][]*model.Message
	listErr  error

	// Per-method error overrides for targeted error-branch coverage.
	channelsErr error
	convsErr    error
	msgsErr     map[string]error // parentID → error
}

func (f *fakeSources) ListUsers(_ context.Context) ([]*model.User, error) {
	return f.users, f.listErr
}
func (f *fakeSources) ListChannels(_ context.Context) ([]*model.Channel, error) {
	return f.channels, f.channelsErr
}
func (f *fakeSources) ListConversations(_ context.Context) ([]*model.Conversation, error) {
	return f.convs, f.convsErr
}
func (f *fakeSources) ListMessages(_ context.Context, parentID string) ([]*model.Message, error) {
	if f.msgsErr != nil {
		if err := f.msgsErr[parentID]; err != nil {
			return nil, err
		}
	}
	return f.msgs[parentID], nil
}

type fakeBulk struct {
	mu     sync.Mutex
	calls  map[string]int // index → entry count
	err    error
	errFor string // when set, Bulk errors only for this index
}

func (f *fakeBulk) Bulk(_ context.Context, index string, entries []BulkEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[index] += len(entries)
	if f.errFor != "" {
		if index == f.errFor {
			return errors.New("bulk error for " + index)
		}
		return nil
	}
	return f.err
}

// testReindexer wires a Reindexer with an in-memory status store (DynamoDB
// stand-in) and a fixed clock so Start/Status/persist run without real infra.
func testReindexer(src reindexSources, w bulkWriter) *Reindexer {
	return &Reindexer{src: src, w: w, status: newFakeStore(), now: fixedNow(1700000000)}
}

// waitReindex polls the durable status until the run completes, returning the
// terminal snapshot. Fails the test if it doesn't finish in time.
func waitReindex(t *testing.T, r *Reindexer) ReindexProgress {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st, err := r.Status(ctx)
		if err != nil {
			t.Fatalf("Status: %v", err)
		}
		if !st.Running {
			return st
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("reindex did not complete in time")
	return ReindexProgress{}
}

func TestNewReindexer_NilDepsReturnsNil(t *testing.T) {
	if NewReindexer(nil, &fakeSources{}, newFakeStore()) != nil {
		t.Error("nil client should yield nil reindexer")
	}
	if NewReindexer(&Client{}, nil, newFakeStore()) != nil {
		t.Error("nil sources should yield nil reindexer")
	}
	if NewReindexer(&Client{}, &fakeSources{}, nil) != nil {
		t.Error("nil status store should yield nil reindexer")
	}
}

func TestReindexer_RunIndexesAllResources(t *testing.T) {
	src := &fakeSources{
		users:    []*model.User{{ID: "u-1"}, {ID: "u-2"}},
		channels: []*model.Channel{{ID: "ch-1"}, {ID: "ch-2"}},
		convs:    []*model.Conversation{{ID: "conv-1"}},
		msgs: map[string][]*model.Message{
			"ch-1":   {{ID: "m-1", Body: "hello"}, {ID: "m-2", System: true}},
			"ch-2":   {{ID: "m-3", Body: "world"}},
			"conv-1": {{ID: "m-4", Body: "dm"}},
		},
	}
	w := &fakeBulk{}
	r := testReindexer(src, w)

	if !r.Start(context.Background()) {
		t.Fatal("Start returned false")
	}

	st := waitReindex(t, r)
	if st.LastError != "" {
		t.Errorf("LastError = %q", st.LastError)
	}
	if w.calls[IndexUsers] != 2 {
		t.Errorf("indexed users = %d, want 2", w.calls[IndexUsers])
	}
	if w.calls[IndexChannels] != 2 {
		t.Errorf("indexed channels = %d, want 2", w.calls[IndexChannels])
	}
	// 4 messages total but one is system → 3 indexed.
	if w.calls[IndexMessages] != 3 {
		t.Errorf("indexed messages = %d, want 3", w.calls[IndexMessages])
	}
	if st.Users != 2 || st.Channels != 2 || st.Messages != 3 {
		t.Errorf("progress = %+v", st)
	}
	// No attachments in this fixture → ex_files Bulk skipped.
	if w.calls[IndexFiles] != 0 {
		t.Errorf("indexed files = %d, want 0 (no attachments)", w.calls[IndexFiles])
	}
	if st.StartedAt == 0 || st.CompletedAt == 0 {
		t.Errorf("expected start/complete timestamps, got %+v", st)
	}
}

func TestReindexer_BuildsExFilesFromAttachments(t *testing.T) {
	src := &fakeSources{
		channels: []*model.Channel{{ID: "ch-1"}, {ID: "ch-2"}},
		msgs: map[string][]*model.Message{
			"ch-1": {{ID: "m-1", ParentID: "ch-1", AttachmentIDs: []string{"a-1"}}},
			"ch-2": {{ID: "m-2", ParentID: "ch-2", AttachmentIDs: []string{"a-1"}}},
		},
	}
	w := &fakeBulk{}
	r := testReindexer(src, w)
	r.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "shared.pdf", CreatedBy: "u-1"},
	}})
	r.Start(context.Background())
	st := waitReindex(t, r)
	if w.calls[IndexFiles] != 1 {
		t.Fatalf("indexed files = %d, want 1 (one unique attachment shared in two channels)", w.calls[IndexFiles])
	}
	if st.Files != 1 {
		t.Errorf("Status.Files = %d, want 1", st.Files)
	}
}

func TestReindexer_StartIsIdempotentWhileRunning(t *testing.T) {
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, running: true}
	if r.Start(context.Background()) {
		t.Error("expected false when already running")
	}
}

func TestNewReindexer_LiveDeps(t *testing.T) {
	store := newFakeStore()
	// A "running" record with an epoch-old heartbeat: reading it back
	// through Status drives the default wall clock the constructor
	// installs, which must report the run as interrupted.
	_ = store.PutSearchStatus(context.Background(), searchJobReindex, ReindexProgress{Running: true, UpdatedAt: 1})
	r := NewReindexer(NewClient("http://example.test"), &fakeSources{}, store)
	if r == nil {
		t.Fatal("expected non-nil reindexer")
	}
	st, err := r.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Running || st.LastError == "" {
		t.Errorf("Status = %+v, want stale heartbeat reported interrupted via the real clock", st)
	}
}

func TestReindexer_BulkErrorSurfacesAndStops(t *testing.T) {
	src := &fakeSources{users: []*model.User{{ID: "u-1"}}}
	w := &fakeBulk{err: errors.New("bulk down")}
	r := testReindexer(src, w)
	r.Start(context.Background())
	st := waitReindex(t, r)
	if st.LastError == "" {
		t.Error("expected LastError from bulk failure")
	}
	if st.Channels != 0 {
		t.Error("subsequent steps should not run after a bulk error")
	}
}

// doRun is exercised synchronously below so each list/bulk error branch
// is deterministically observed (no goroutine polling).

func TestReindexer_doRun_ListChannelsError(t *testing.T) {
	r := &Reindexer{src: &fakeSources{channelsErr: errors.New("channels down")}, w: &fakeBulk{}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected list channels error")
	}
}

func TestReindexer_doRun_BulkChannelsError(t *testing.T) {
	src := &fakeSources{channels: []*model.Channel{{ID: "ch-1"}}}
	r := &Reindexer{src: src, w: &fakeBulk{errFor: IndexChannels}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected bulk channels error")
	}
}

func TestReindexer_doRun_ListConversationsError(t *testing.T) {
	r := &Reindexer{src: &fakeSources{convsErr: errors.New("convs down")}, w: &fakeBulk{}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected list conversations error")
	}
}

func TestReindexer_doRun_ListMessagesChannelError(t *testing.T) {
	src := &fakeSources{
		channels: []*model.Channel{{ID: "ch-1"}},
		msgsErr:  map[string]error{"ch-1": errors.New("msgs down")},
	}
	r := &Reindexer{src: src, w: &fakeBulk{}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected list messages (channel) error")
	}
}

func TestReindexer_doRun_BulkMessagesChannelError(t *testing.T) {
	src := &fakeSources{
		channels: []*model.Channel{{ID: "ch-1"}},
		msgs:     map[string][]*model.Message{"ch-1": {{ID: "m-1", Body: "hi"}}},
	}
	r := &Reindexer{src: src, w: &fakeBulk{errFor: IndexMessages}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected bulk messages error")
	}
}

func TestReindexer_doRun_ListMessagesConversationError(t *testing.T) {
	src := &fakeSources{
		convs:   []*model.Conversation{{ID: "conv-1"}},
		msgsErr: map[string]error{"conv-1": errors.New("conv msgs down")},
	}
	r := &Reindexer{src: src, w: &fakeBulk{}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected list messages (conversation) error")
	}
}

func TestReindexer_doRun_BulkMessagesConversationError(t *testing.T) {
	src := &fakeSources{
		convs: []*model.Conversation{{ID: "conv-1"}},
		msgs:  map[string][]*model.Message{"conv-1": {{ID: "m-1", Body: "hi"}}},
	}
	r := &Reindexer{src: src, w: &fakeBulk{errFor: IndexMessages}}
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected bulk messages (conversation) error")
	}
}

func TestReindexer_doRun_BulkFilesError(t *testing.T) {
	src := &fakeSources{
		channels: []*model.Channel{{ID: "ch-1"}},
		msgs: map[string][]*model.Message{
			"ch-1": {{ID: "m-1", ParentID: "ch-1", AttachmentIDs: []string{"a-1"}}},
		},
	}
	r := &Reindexer{src: src, w: &fakeBulk{errFor: IndexFiles}}
	r.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "f.pdf"},
	}})
	if err := r.doRun(context.Background()); err == nil {
		t.Fatal("expected bulk files error")
	}
}

// A nil attachment in the resolved set is skipped during bulkMessages.
func TestReindexer_bulkMessages_SkipsNilAttachment(t *testing.T) {
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}}
	r.SetAttachmentResolver(nilResolver{})
	files := map[string]*fileBucket{}
	msgs := []*model.Message{{ID: "m-1", ParentID: "ch", AttachmentIDs: []string{"a-1"}}}
	if err := r.bulkMessages(context.Background(), msgs, "channel", files); err != nil {
		t.Fatalf("bulkMessages: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("nil attachment should not create a file bucket, got %d", len(files))
	}
}

// All messages filtered out (system/nil) → no bulk call, early return.
func TestReindexer_bulkMessages_NoEntriesEarlyReturn(t *testing.T) {
	w := &fakeBulk{}
	r := &Reindexer{src: &fakeSources{}, w: w}
	msgs := []*model.Message{{ID: "m-sys", System: true}, nil, {ID: "m-noindex", NoIndex: true}}
	if err := r.bulkMessages(context.Background(), msgs, "channel", nil); err != nil {
		t.Fatalf("bulkMessages: %v", err)
	}
	if w.calls[IndexMessages] != 0 {
		t.Errorf("expected no bulk call for all-filtered messages, got %d", w.calls[IndexMessages])
	}
}

func TestReindexer_Status_MissIsZero(t *testing.T) {
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: newFakeStore(), now: fixedNow(1)}
	st, err := r.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st != (ReindexProgress{}) {
		t.Fatalf("never-run status should be zero, got %+v", st)
	}
}

func TestReindexer_Status_SurfacesStoreError(t *testing.T) {
	store := newFakeStore()
	store.getErr = errors.New("ddb down")
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: store, now: fixedNow(1)}
	if _, err := r.Status(context.Background()); err == nil {
		t.Fatal("expected the store read error to surface")
	}
}

func TestReindexer_Status_ReconcilesStaleHeartbeat(t *testing.T) {
	store := newFakeStore()
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: store, now: fixedNow(1000)}
	// A "running" record whose heartbeat is well past the stale window — the
	// runner crashed. now(1000) - UpdatedAt(100) = 900s >> reindexStaleAfter.
	_ = store.PutSearchStatus(context.Background(), searchJobReindex, ReindexProgress{Running: true, UpdatedAt: 100})
	st, err := r.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Running {
		t.Fatal("a stale-heartbeat running record must reconcile to not-running")
	}
	if st.LastError == "" {
		t.Fatal("interrupted reconcile should annotate lastError")
	}
}

func TestReindexer_Status_ReconcileKeepsExistingError(t *testing.T) {
	store := newFakeStore()
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: store, now: fixedNow(1000)}
	_ = store.PutSearchStatus(context.Background(), searchJobReindex, ReindexProgress{Running: true, UpdatedAt: 100, LastError: "prior"})
	st, _ := r.Status(context.Background())
	if st.Running || st.LastError != "prior" {
		t.Fatalf("reconcile should not clobber an existing error, got %+v", st)
	}
}

func TestReindexer_Status_FreshHeartbeatStaysRunning(t *testing.T) {
	store := newFakeStore()
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: store, now: fixedNow(1000)}
	// now(1000) - UpdatedAt(990) = 10s < reindexStaleAfter → still running.
	_ = store.PutSearchStatus(context.Background(), searchJobReindex, ReindexProgress{Running: true, UpdatedAt: 990})
	st, _ := r.Status(context.Background())
	if !st.Running {
		t.Fatal("a fresh heartbeat must keep the run marked running")
	}
}

func TestReindexer_persist_ThrottlesUnlessForced(t *testing.T) {
	store := newFakeStore()
	var clock int64 = 1000
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: store, now: func() int64 { return clock }}
	r.mu.Lock()
	r.running = true
	r.progress = ReindexProgress{Users: 1}
	r.mu.Unlock()

	r.persist(context.Background(), true) // forced → writes
	if store.putCalls != 1 {
		t.Fatalf("forced persist should write once, got %d", store.putCalls)
	}
	r.persist(context.Background(), false) // same clock → throttled, skipped
	if store.putCalls != 1 {
		t.Fatalf("a persist within the throttle window should skip, got %d", store.putCalls)
	}
	clock += int64(reindexPersistThrottle.Seconds()) + 1 // advance past the throttle
	r.persist(context.Background(), false)
	if store.putCalls != 2 {
		t.Fatalf("a persist past the throttle window should write, got %d", store.putCalls)
	}
}

func TestReindexer_persist_LogsAndSurvivesStoreError(t *testing.T) {
	store := newFakeStore()
	store.putErr = errors.New("ddb write down")
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, status: store, now: fixedNow(1000)}
	r.mu.Lock()
	r.running = true
	r.mu.Unlock()
	// A failed flush is best-effort: it logs and returns, never panics or blocks.
	r.persist(context.Background(), true)
	if store.putCalls != 1 {
		t.Fatalf("persist should have attempted one write, got %d", store.putCalls)
	}
}

func TestReindexer_PropagatesListError(t *testing.T) {
	src := &fakeSources{listErr: errors.New("ddb down")}
	w := &fakeBulk{}
	r := testReindexer(src, w)
	r.Start(context.Background())
	st := waitReindex(t, r)
	if st.LastError == "" {
		t.Error("expected LastError to surface ddb failure")
	}
}
