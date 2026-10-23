package main

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/store"
)

type fakeTopLevelIndexer struct {
	res     store.TopLevelBackfill
	err     error
	markErr error
	marked  bool
	dryRuns []bool
	workers int
}

func (f *fakeTopLevelIndexer) BackfillTopLevelIndex(_ context.Context, dryRun bool, workers int) (store.TopLevelBackfill, error) {
	f.dryRuns = append(f.dryRuns, dryRun)
	f.workers = workers
	return f.res, f.err
}

func (f *fakeTopLevelIndexer) MarkTopLevelIndexSeeded(context.Context) error {
	f.marked = true
	return f.markErr
}

// The index is switched on only after a clean, applied pass: a dry run or a
// failed pass leaves it off, so channel pages never read an index that is
// missing older messages.
func TestBackfillTopLevelIndex_SwitchesOnOnlyAfterACleanPass(t *testing.T) {
	ctx := context.Background()

	dry := &fakeTopLevelIndexer{res: store.TopLevelBackfill{Found: 3, Stamped: 3}}
	if code := backfillTopLevelIndex(ctx, dry, true, 4); code != 0 || dry.marked || dry.dryRuns[0] != true || dry.workers != 4 {
		t.Fatalf("dry run: code=%d marked=%v calls=%v workers=%d", code, dry.marked, dry.dryRuns, dry.workers)
	}

	failed := &fakeTopLevelIndexer{res: store.TopLevelBackfill{Found: 3, Stamped: 1}, err: errors.New("throttled")}
	if code := backfillTopLevelIndex(ctx, failed, false, 4); code != 1 || failed.marked {
		t.Fatalf("failed pass: code=%d marked=%v", code, failed.marked)
	}

	clean := &fakeTopLevelIndexer{res: store.TopLevelBackfill{Found: 3, Stamped: 2, Gone: 1}}
	if code := backfillTopLevelIndex(ctx, clean, false, 4); code != 0 || !clean.marked || clean.dryRuns[0] != false {
		t.Fatalf("clean pass: code=%d marked=%v", code, clean.marked)
	}

	unmarked := &fakeTopLevelIndexer{markErr: errors.New("put failed")}
	if code := backfillTopLevelIndex(ctx, unmarked, false, 4); code != 1 {
		t.Fatalf("mark failure: code=%d, want 1", code)
	}
}

func TestTopLevelIndexIsRegistered(t *testing.T) {
	if _, ok := commands()["top-level-index"]; !ok {
		t.Fatal("top-level-index missing from the dispatcher")
	}
}
