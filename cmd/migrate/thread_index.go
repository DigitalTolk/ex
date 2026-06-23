package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// runThreadIndex backfills the GSI1 thread index on existing reply messages
// (those with a ParentMessageID). The index lets ListThreadMessages fetch a
// whole thread with one GSI Query instead of scanning the parent's message
// partition, but it's only stamped on new replies going forward.
//
// Idempotent: re-running stamps the same GSI keys. Resumable: each reply is an
// independent UpdateItem of GSI keys only, so it never clobbers a concurrent
// body edit and a crash leaves the table valid.
func runThreadIndex(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("thread-index", args, nil)

	messageStore := store.NewMessageStore(db)
	channelStore := store.NewChannelStore(db)
	convStore := store.NewConversationStore(db)

	slog.Info("starting thread-index backfill", "mode", mode, "table", db.Table)

	t := tiTotals{}
	forEachParent(ctx, channelStore, convStore, func(parentID, parentType, name string) {
		if err := tiBackfill(ctx, messageStore, parentID, dryRun, verbose, &t); err != nil {
			slog.Error("backfill failed", "parentID", parentID, "parentType", parentType, "name", name, "error", err)
			t.errors++
		}
	})

	slog.Info("backfill complete",
		"mode", mode,
		"parents_processed", t.parents,
		"messages_scanned", t.messages,
		"replies_indexed", t.replies,
		"errors", t.errors,
	)
	if t.errors > 0 {
		return 1
	}
	return 0
}

type tiTotals struct {
	parents  int
	messages int
	replies  int
	errors   int
}

// tiBackfill walks every MSG# row under one parent and stamps the GSI1 thread
// keys on each reply (ParentMessageID != "").
func tiBackfill(ctx context.Context, messageStore *store.MessageStoreImpl, parentID string, dryRun, verbose bool, t *tiTotals) error {
	t.parents++
	if err := forEachMessage(ctx, messageStore, parentID, func(m *model.Message) error {
		t.messages++
		if m.ParentMessageID == "" {
			return nil // roots / standalone messages aren't indexed
		}
		if verbose {
			slog.Info("thread index", "parentID", parentID, "msgID", m.ID, "root", m.ParentMessageID)
		}
		if dryRun {
			t.replies++
			return nil
		}
		if err := messageStore.StampThreadIndex(ctx, parentID, m.ID, m.ParentMessageID); err != nil {
			slog.Warn("stamp thread index failed", "parentID", parentID, "msgID", m.ID, "error", err)
			t.errors++
			return nil
		}
		t.replies++
		return nil
	}); err != nil {
		return err
	}
	slog.Info("backfilled parent", "parentID", parentID, "dry_run", dryRun)
	return nil
}
