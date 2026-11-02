package main

import (
	"context"
	"flag"
	"log/slog"
	"slices"
	"sync/atomic"
	"time"

	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/DigitalTolk/ex/pkg/importer"
	"golang.org/x/sync/errgroup"
)

// tpWorkers is the default parallelism: scan segments, then batches of
// threads backfilled at once.
const tpWorkers = 4

// tpBatchSize bounds the threads of one parent in one backfill call: one read
// of their roots, one of their participants' follow rows.
const tpBatchSize = 100

// tpMachineAuthors author messages but are not people: they follow nothing.
var tpMachineAuthors = []string{importer.SystemAuthorID, importer.WebhookAuthorID}

// threadParticipantsStore is what the backfill needs from the table.
type threadParticipantsStore interface {
	ScanThreadReplies(ctx context.Context, before time.Time, segments int) ([]*store.ThreadReplies, int, error)
	ParentTypes(ctx context.Context, ids []string) (map[string]string, error)
	Backfill(ctx context.Context, parentID, parentType string, threads []*store.ThreadReplies, dryRun bool) (store.ThreadParticipantsResult, error)
}

type tableThreadParticipants struct{ db *store.DB }

func (t tableThreadParticipants) ScanThreadReplies(ctx context.Context, before time.Time, segments int) ([]*store.ThreadReplies, int, error) {
	return store.NewMessageStore(t.db).ScanThreadReplies(ctx, before, segments)
}

func (t tableThreadParticipants) ParentTypes(ctx context.Context, ids []string) (map[string]string, error) {
	return store.ParentTypes(ctx, t.db, ids)
}

func (t tableThreadParticipants) Backfill(ctx context.Context, parentID, parentType string, threads []*store.ThreadReplies, dryRun bool) (store.ThreadParticipantsResult, error) {
	return store.BackfillThreadParticipants(ctx, t.db, parentID, parentType, threads, tpMachineAuthors, dryRun)
}

// threadParticipantsRun is how a thread-participants run goes.
type threadParticipantsRun struct {
	dryRun, verbose bool
	mode            string
	workers         int
	before          time.Time
	progressEvery   time.Duration
}

// runThreadParticipants puts every thread rooted before replies wrote follow
// rows onto its participants' /threads lists: the root author and every reply
// author get a follow row (a deliberate unfollow stays), and the root is
// flagged so its replies find their audience in the follow rows instead of
// re-reading the thread.
//
// Idempotent and resumable: flagged roots are skipped, rows are written only
// where absent, and a root is flagged only after all its rows are written.
func runThreadParticipants(ctx context.Context, db *store.DB, args []string) int {
	workers := tpWorkers
	dryRun, verbose, mode := migrateFlags("thread-participants", args, func(fs *flag.FlagSet) {
		fs.IntVar(&workers, "workers", tpWorkers, "scan segments, then batches of threads, processed at once")
	})
	return threadParticipants(ctx, tableThreadParticipants{db}, threadParticipantsRun{
		dryRun: dryRun, verbose: verbose, mode: mode, workers: max(workers, 1),
		before: service.ThreadIndexEpoch(), progressEvery: progressEvery,
	})
}

// threadParticipants is the env-free core of the subcommand: scan, group the
// threads by parent, and backfill them in batches, run.workers at a time.
func threadParticipants(ctx context.Context, st threadParticipantsStore, run threadParticipantsRun) int {
	slog.Info("starting thread-participants", "mode", run.mode, "rootedBefore", run.before.Format(time.DateOnly), "workers", run.workers)
	threads, replies, err := st.ScanThreadReplies(ctx, run.before, run.workers)
	if err != nil {
		slog.Error("scan thread replies failed", "error", err)
		return 1
	}
	byParent := map[string][]*store.ThreadReplies{}
	for _, t := range threads {
		byParent[t.ParentID] = append(byParent[t.ParentID], t)
	}
	parents := make([]string, 0, len(byParent))
	for id := range byParent {
		parents = append(parents, id)
	}
	slices.Sort(parents)
	types, err := st.ParentTypes(ctx, parents)
	if err != nil {
		slog.Error("resolve parents failed", "error", err)
		return 1
	}
	slog.Info("scanned thread replies", "replies", replies, "threads", len(threads), "parents", len(parents))

	p := newProgress("thread-participants", len(threads))
	stop := p.report(run.progressEvery)
	var already, follows, skipped atomic.Int64
	var g errgroup.Group
	g.SetLimit(run.workers)
	for _, parentID := range parents {
		ts, typ := byParent[parentID], types[parentID]
		if typ == "" {
			// The channel or conversation is gone: nobody can open these.
			skipped.Add(int64(len(ts)))
			p.done.Add(int64(len(ts)))
			continue
		}
		for start := 0; start < len(ts); start += tpBatchSize {
			batch := ts[start:min(start+tpBatchSize, len(ts))]
			g.Go(func() error {
				defer p.done.Add(int64(len(batch)))
				res, err := st.Backfill(ctx, parentID, typ, batch, run.dryRun)
				p.changed.Add(int64(res.Indexed))
				already.Add(int64(res.AlreadyIndexed))
				follows.Add(int64(res.FollowsWritten))
				skipped.Add(int64(res.RootsSkipped))
				if err != nil {
					slog.Warn("backfill failed", "parentID", parentID, "threads", len(batch), "error", err)
					p.failed.Add(1)
					return nil
				}
				if run.verbose {
					slog.Info("backfilled", "parentID", parentID, "type", typ, "threads", len(batch), "indexed", res.Indexed, "follows", res.FollowsWritten)
				}
				return nil
			})
		}
	}
	_ = g.Wait()
	stop()

	slog.Info("thread-participants complete", "mode", run.mode, "replies", replies, "threads", len(threads),
		"indexed", p.changed.Load(), "already_indexed", already.Load(), "follows_written", follows.Load(),
		"skipped", skipped.Load(), "errors", p.failed.Load(), "took", time.Since(p.start).Round(time.Second).String())
	if p.failed.Load() > 0 {
		return 1
	}
	return 0
}
