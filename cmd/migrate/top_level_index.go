package main

import (
	"context"
	"flag"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/store"
)

// tlWorkers is the default number of message rows stamped at once.
const tlWorkers = 16

// topLevelIndexer is the slice of the message store the backfill drives.
type topLevelIndexer interface {
	BackfillTopLevelIndex(ctx context.Context, dryRun bool, workers int) (store.TopLevelBackfill, error)
	MarkTopLevelIndexSeeded(ctx context.Context) error
}

// runTopLevelIndex backfills the GSI2 top-level message index on messages
// written before it existed, then switches it on. Channel pages read the
// index (only the rows they show) once it is on; until then they keep paging
// past thread replies.
//
// Run it after EVERY server runs a build that stamps the index on write — and
// again after a rollback to an older build, whose writes skip the index.
// Idempotent and resumable: each row is an independent UpdateItem of the
// index keys only, so a crash leaves the table valid and a re-run picks up
// where it stopped. The index is switched on only after a clean full pass.
func runTopLevelIndex(ctx context.Context, db *store.DB, args []string) int {
	workers := tlWorkers
	dryRun, _, mode := migrateFlags("top-level-index", args, func(fs *flag.FlagSet) {
		fs.IntVar(&workers, "workers", tlWorkers, "message rows stamped at once")
	})
	slog.Info("starting top-level-index backfill", "mode", mode, "table", db.Table, "workers", workers)
	return backfillTopLevelIndex(ctx, store.NewMessageStore(db), dryRun, max(workers, 1))
}

func backfillTopLevelIndex(ctx context.Context, ix topLevelIndexer, dryRun bool, workers int) int {
	res, err := ix.BackfillTopLevelIndex(ctx, dryRun, workers)
	slog.Info("backfill pass complete",
		"dry_run", dryRun,
		"unindexed_found", res.Found,
		"stamped", res.Stamped,
		"deleted_mid_run", res.Gone,
	)
	if err != nil {
		slog.Error("backfill failed; the index stays off until a clean re-run", "error", err)
		return 1
	}
	if dryRun {
		return 0
	}
	if err := ix.MarkTopLevelIndexSeeded(ctx); err != nil {
		slog.Error("mark top-level index seeded failed; re-run to switch it on", "error", err)
		return 1
	}
	slog.Info("top-level index switched on; servers adopt it within a minute")
	return 0
}
