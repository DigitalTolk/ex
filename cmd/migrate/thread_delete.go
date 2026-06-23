package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// runThreadDelete soft-deletes every reply whose thread root has already been
// soft-deleted. Deleting a root now cascades to its replies, but threads
// deleted before that behavior shipped left their replies live.
//
// Idempotent: an already-Deleted reply is skipped, so re-running rewrites
// nothing. Resumable: each Update stands alone.
func runThreadDelete(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("thread-delete", args, nil)

	messageStore := store.NewMessageStore(db)
	channelStore := store.NewChannelStore(db)
	convStore := store.NewConversationStore(db)

	slog.Info("starting thread-delete backfill", "mode", mode, "table", db.Table)

	t := tdTotals{}
	forEachParent(ctx, channelStore, convStore, func(parentID, parentType, name string) {
		if err := tdBackfill(ctx, messageStore, parentID, parentType, dryRun, verbose, &t); err != nil {
			slog.Error("backfill failed", "parentID", parentID, "parentType", parentType, "name", name, "error", err)
			t.errors++
		}
	})

	slog.Info("backfill complete",
		"mode", mode,
		"parents_processed", t.parents,
		"messages_scanned", t.messages,
		"replies_tombstoned", t.tombstoned,
		"errors", t.errors,
	)
	if t.errors > 0 {
		return 1
	}
	return 0
}

type tdTotals struct {
	parents    int
	messages   int
	tombstoned int
	errors     int
}

// tdBackfill walks one parent partition, builds the set of deleted thread
// roots, then tombstones every still-live reply pointing at one of them.
func tdBackfill(ctx context.Context, messageStore *store.MessageStoreImpl, parentID, parentType string, dryRun, verbose bool, t *tdTotals) error {
	t.parents++

	// Load every row first: a reply can sort before its root, so we can't
	// decide reply-by-reply in a single streaming pass.
	all := make([]*model.Message, 0, scanPageSize)
	deletedRoots := map[string]struct{}{}

	if err := forEachMessage(ctx, messageStore, parentID, func(m *model.Message) error {
		t.messages++
		all = append(all, m)
		if m.Deleted && m.ParentMessageID == "" {
			deletedRoots[m.ID] = struct{}{}
		}
		return nil
	}); err != nil {
		return err
	}

	tombstoned := 0
	for _, m := range all {
		if m.ParentMessageID == "" || m.Deleted {
			continue
		}
		if _, orphaned := deletedRoots[m.ParentMessageID]; !orphaned {
			continue
		}
		if verbose {
			slog.Info("tombstone reply", "parentID", parentID, "parentType", parentType, "msgID", m.ID, "rootID", m.ParentMessageID)
		}
		if dryRun {
			tombstoned++
			continue
		}
		m.Tombstone()
		if err := messageStore.Update(ctx, parentID, m); err != nil {
			slog.Warn("tombstone reply failed", "parentID", parentID, "msgID", m.ID, "error", err)
			t.errors++
			continue
		}
		tombstoned++
	}
	t.tombstoned += tombstoned

	if tombstoned > 0 {
		slog.Info("backfilled parent", "parentID", parentID, "parentType", parentType, "replies_tombstoned", tombstoned, "dry_run", dryRun)
	}
	return nil
}
