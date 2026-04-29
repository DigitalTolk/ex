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
}

func (f *fakeSources) ListUsers(_ context.Context) ([]*model.User, error) {
	return f.users, f.listErr
}
func (f *fakeSources) ListChannels(_ context.Context) ([]*model.Channel, error) {
	return f.channels, nil
}
func (f *fakeSources) ListConversations(_ context.Context) ([]*model.Conversation, error) {
	return f.convs, nil
}
func (f *fakeSources) ListMessages(_ context.Context, parentID string) ([]*model.Message, error) {
	return f.msgs[parentID], nil
}

type fakeBulk struct {
	mu     sync.Mutex
	calls  map[string]int // index → entry count
	err    error
}

func (f *fakeBulk) Bulk(_ context.Context, index string, entries []BulkEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[index] += len(entries)
	return f.err
}

func TestNewReindexer_NilDepsReturnsNil(t *testing.T) {
	if NewReindexer(nil, &fakeSources{}) != nil {
		t.Error("nil client should yield nil reindexer")
	}
	if NewReindexer(&Client{}, nil) != nil {
		t.Error("nil sources should yield nil reindexer")
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
	r := &Reindexer{src: src, w: w}
	now := func() int64 { return 1700000000 }

	started := r.Start(context.Background(), now)
	if !started {
		t.Fatal("Start returned false")
	}

	// Wait for the goroutine to finish.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !r.Status().Running {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	st := r.Status()
	if st.Running {
		t.Fatal("reindex did not complete in time")
	}
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
	r := &Reindexer{src: src, w: w}
	r.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "shared.pdf", CreatedBy: "u-1"},
	}})
	r.Start(context.Background(), func() int64 { return 0 })
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && r.Status().Running {
		time.Sleep(5 * time.Millisecond)
	}
	if w.calls[IndexFiles] != 1 {
		t.Fatalf("indexed files = %d, want 1 (one unique attachment shared in two channels)", w.calls[IndexFiles])
	}
	if r.Status().Files != 1 {
		t.Errorf("Status.Files = %d, want 1", r.Status().Files)
	}
}

func TestReindexer_StartIsIdempotentWhileRunning(t *testing.T) {
	r := &Reindexer{src: &fakeSources{}, w: &fakeBulk{}, running: true}
	if r.Start(context.Background(), func() int64 { return 0 }) {
		t.Error("expected false when already running")
	}
}

func TestNewReindexer_LiveDeps(t *testing.T) {
	r := NewReindexer(NewClient("http://example.test"), &fakeSources{})
	if r == nil {
		t.Fatal("expected non-nil reindexer")
	}
}

func TestReindexer_BulkErrorSurfacesAndStops(t *testing.T) {
	src := &fakeSources{users: []*model.User{{ID: "u-1"}}}
	w := &fakeBulk{err: errors.New("bulk down")}
	r := &Reindexer{src: src, w: w}
	r.Start(context.Background(), func() int64 { return 0 })
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && r.Status().Running {
		time.Sleep(5 * time.Millisecond)
	}
	if msg := r.Status().LastError; msg == "" {
		t.Error("expected LastError from bulk failure")
	}
	if r.Status().Channels != 0 {
		t.Error("subsequent steps should not run after a bulk error")
	}
}

func TestReindexer_PropagatesListError(t *testing.T) {
	src := &fakeSources{listErr: errors.New("ddb down")}
	w := &fakeBulk{}
	r := &Reindexer{src: src, w: w}
	r.Start(context.Background(), func() int64 { return 0 })
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && r.Status().Running {
		time.Sleep(5 * time.Millisecond)
	}
	if msg := r.Status().LastError; msg == "" {
		t.Error("expected LastError to surface ddb failure")
	}
}
