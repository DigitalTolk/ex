package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/store"
)

// fakeThreadParticipants records the backfill calls it gets.
type fakeThreadParticipants struct {
	threads  []*store.ThreadReplies
	types    map[string]string
	scanErr  error
	typesErr error
	failOn   string // a parent whose backfill fails

	mu       sync.Mutex
	segments int
	before   time.Time
	calls    map[string][]int // parent -> batch sizes
	dryRuns  []bool
}

func (f *fakeThreadParticipants) ScanThreadReplies(_ context.Context, before time.Time, segments int) ([]*store.ThreadReplies, int, error) {
	f.before, f.segments = before, segments
	return f.threads, 2 * len(f.threads), f.scanErr
}

func (f *fakeThreadParticipants) ParentTypes(context.Context, []string) (map[string]string, error) {
	return f.types, f.typesErr
}

func (f *fakeThreadParticipants) Backfill(_ context.Context, parentID, parentType string, threads []*store.ThreadReplies, dryRun bool) (store.ThreadParticipantsResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string][]int{}
	}
	f.calls[parentID+"/"+parentType] = append(f.calls[parentID+"/"+parentType], len(threads))
	f.dryRuns = append(f.dryRuns, dryRun)
	if parentID == f.failOn {
		return store.ThreadParticipantsResult{}, errors.New("throttled")
	}
	return store.ThreadParticipantsResult{Indexed: len(threads), FollowsWritten: 2 * len(threads)}, nil
}

func threadsIn(parentID string, n int) []*store.ThreadReplies {
	out := make([]*store.ThreadReplies, n)
	for i := range out {
		out[i] = &store.ThreadReplies{ParentID: parentID, RootID: fmt.Sprintf("%s-r%d", parentID, i)}
	}
	return out
}

func tpRun(dryRun bool) threadParticipantsRun {
	return threadParticipantsRun{dryRun: dryRun, verbose: true, mode: "test", workers: 3, before: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), progressEvery: time.Millisecond}
}

// Threads are backfilled per parent, at most tpBatchSize at a time, with the
// parent's type; a parent that no longer exists is skipped.
func TestThreadParticipants_BatchesPerParent(t *testing.T) {
	f := &fakeThreadParticipants{
		threads: append(append(threadsIn("ch-big", 2*tpBatchSize+1), threadsIn("dm-1", 3)...), threadsIn("gone", 4)...),
		types:   map[string]string{"ch-big": store.SidebarItemChannel, "dm-1": store.SidebarItemConversation},
	}
	run := tpRun(true)
	if code := threadParticipants(context.Background(), f, run); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if f.segments != run.workers || !f.before.Equal(run.before) {
		t.Fatalf("scan with %d segments before %v", f.segments, f.before)
	}
	big := f.calls["ch-big/channel"]
	if len(big) != 3 || big[0]+big[1]+big[2] != 2*tpBatchSize+1 || big[0] > tpBatchSize || big[1] > tpBatchSize || big[2] > tpBatchSize {
		t.Fatalf("ch-big batches = %v", big)
	}
	if got := f.calls["dm-1/conversation"]; len(got) != 1 || got[0] != 3 {
		t.Fatalf("dm-1 batches = %v", got)
	}
	if len(f.calls) != 2 {
		t.Fatalf("calls = %v, want nothing for the gone parent", f.calls)
	}
	for _, dry := range f.dryRuns {
		if !dry {
			t.Fatal("a dry run wrote")
		}
	}
}

// A failed batch is reported and the run exits 1 (re-run it: done threads are
// skipped); the other batches still run.
func TestThreadParticipants_FailedBatch(t *testing.T) {
	f := &fakeThreadParticipants{
		threads: append(threadsIn("ch-1", 2), threadsIn("ch-2", 2)...),
		types:   map[string]string{"ch-1": store.SidebarItemChannel, "ch-2": store.SidebarItemChannel},
		failOn:  "ch-1",
	}
	if code := threadParticipants(context.Background(), f, tpRun(false)); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if len(f.calls["ch-2/channel"]) != 1 {
		t.Fatalf("calls = %v, want ch-2 backfilled anyway", f.calls)
	}
}

// Without the scan or the parent lookup nothing can be done.
func TestThreadParticipants_ReadFailures(t *testing.T) {
	for name, f := range map[string]*fakeThreadParticipants{
		"scan":    {scanErr: errors.New("scan down")},
		"parents": {threads: threadsIn("ch-1", 1), typesErr: errors.New("batch down")},
	} {
		if code := threadParticipants(context.Background(), f, tpRun(false)); code != 1 {
			t.Fatalf("%s failure: exit = %d, want 1", name, code)
		}
		if len(f.calls) != 0 {
			t.Fatalf("%s failure: backfilled %v", name, f.calls)
		}
	}
}
