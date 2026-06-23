package main

import (
	"context"
	"fmt"
	"log/slog"

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
	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		fatal("list channels", err)
	}
	slog.Info("scanned channels", "count", len(channels))
	for _, ch := range channels {
		if err := tiBackfill(ctx, messageStore, ch.ID, dryRun, verbose, &t); err != nil {
			slog.Error("channel backfill failed", "channelID", ch.ID, "name", ch.Name, "error", err)
			t.errors++
		}
	}
	convs, err := convStore.ListAll(ctx)
	if err != nil {
		fatal("list conversations", err)
	}
	slog.Info("scanned conversations", "count", len(convs))
	for _, c := range convs {
		if err := tiBackfill(ctx, messageStore, c.ID, dryRun, verbose, &t); err != nil {
			slog.Error("conversation backfill failed", "conversationID", c.ID, "error", err)
			t.errors++
		}
	}

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
	cursor := ""
	for {
		msgs, hasMore, err := messageStore.List(ctx, parentID, cursor, scanPageSize)
		if err != nil {
			return fmt.Errorf("scan messages: %w", err)
		}
		if len(msgs) == 0 {
			break
		}
		for _, m := range msgs {
			t.messages++
			if m.ParentMessageID == "" {
				continue // roots / standalone messages aren't indexed
			}
			if verbose {
				slog.Info("thread index", "parentID", parentID, "msgID", m.ID, "root", m.ParentMessageID)
			}
			if dryRun {
				t.replies++
				continue
			}
			if err := messageStore.StampThreadIndex(ctx, parentID, m.ID, m.ParentMessageID); err != nil {
				slog.Warn("stamp thread index failed", "parentID", parentID, "msgID", m.ID, "error", err)
				t.errors++
				continue
			}
			t.replies++
		}
		if !hasMore {
			break
		}
		cursor = msgs[len(msgs)-1].ID
	}
	slog.Info("backfilled parent", "parentID", parentID, "dry_run", dryRun)
	return nil
}
