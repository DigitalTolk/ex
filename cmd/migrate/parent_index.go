package main

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/DigitalTolk/ex/internal/store"
)

// runParentIndex backfills the per-parent PIN# and FILE# index rows. The index
// makes ListPinned/ListFiles O(pinned)/O(files-shared) instead of O(messages),
// but it's populated lazily on new pin/attachment events going forward.
//
// Idempotent: re-running rewrites the same rows. Resumable: each PutItem stands
// alone.
func runParentIndex(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("parent-index", args, nil)

	messageStore := store.NewMessageStore(db)
	channelStore := store.NewChannelStore(db)
	convStore := store.NewConversationStore(db)
	indexStore := store.NewParentIndexStore(db)

	slog.Info("starting parent-index backfill", "mode", mode, "table", db.Table)

	t := piTotals{}
	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		fatal("list channels", err)
	}
	slog.Info("scanned channels", "count", len(channels))
	for _, ch := range channels {
		if err := piBackfill(ctx, messageStore, indexStore, ch.ID, "channel", dryRun, verbose, &t); err != nil {
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
		if err := piBackfill(ctx, messageStore, indexStore, c.ID, "conversation", dryRun, verbose, &t); err != nil {
			slog.Error("conversation backfill failed", "conversationID", c.ID, "error", err)
			t.errors++
		}
	}

	slog.Info("backfill complete",
		"mode", mode,
		"parents_processed", t.parents,
		"messages_scanned", t.messages,
		"pin_rows_written", t.pins,
		"file_rows_written", t.files,
		"errors", t.errors,
	)
	if t.errors > 0 {
		return 1
	}
	return 0
}

type piTotals struct {
	parents  int
	messages int
	pins     int
	files    int
	errors   int
}

type pinClaim struct {
	pinnedBy string
	pinnedAt time.Time
}

// piBackfill scans every MSG# row under one parent and writes a PIN# row per
// pinned message + a FILE# row per attachment (latest message wins per file).
func piBackfill(ctx context.Context, messageStore *store.MessageStoreImpl, indexStore *store.ParentIndexStoreImpl, parentID, parentType string, dryRun, verbose bool, t *piTotals) error {
	t.parents++

	type attachmentClaim struct {
		messageID string
		authorID  string
		createdAt time.Time
	}
	pinned := map[string]pinClaim{}
	attachments := map[string]attachmentClaim{}

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
			if m.Deleted {
				continue
			}
			if m.Pinned {
				when := time.Time{}
				if m.PinnedAt != nil {
					when = *m.PinnedAt
				}
				pinned[m.ID] = pinClaim{pinnedBy: m.PinnedBy, pinnedAt: when}
			}
			for _, aid := range m.AttachmentIDs {
				if aid == "" {
					continue
				}
				if cur, ok := attachments[aid]; ok && cur.createdAt.After(m.CreatedAt) {
					continue
				}
				attachments[aid] = attachmentClaim{messageID: m.ID, authorID: m.AuthorID, createdAt: m.CreatedAt}
			}
		}
		if !hasMore {
			break
		}
		cursor = msgs[len(msgs)-1].ID
	}

	pinIDs := make([]string, 0, len(pinned))
	for id := range pinned {
		pinIDs = append(pinIDs, id)
	}
	sort.Strings(pinIDs)
	attIDs := make([]string, 0, len(attachments))
	for id := range attachments {
		attIDs = append(attIDs, id)
	}
	sort.Strings(attIDs)

	for _, msgID := range pinIDs {
		claim := pinned[msgID]
		if verbose {
			slog.Info("pin index", "parentID", parentID, "parentType", parentType, "msgID", msgID, "pinnedBy", claim.pinnedBy)
		}
		if dryRun {
			t.pins++
			continue
		}
		if err := indexStore.SetPinIndex(ctx, parentID, msgID, claim.pinnedBy, claim.pinnedAt); err != nil {
			slog.Warn("set pin index failed", "parentID", parentID, "msgID", msgID, "error", err)
			t.errors++
			continue
		}
		t.pins++
	}

	for _, attID := range attIDs {
		claim := attachments[attID]
		if verbose {
			slog.Info("file index", "parentID", parentID, "parentType", parentType, "attID", attID, "msgID", claim.messageID)
		}
		if dryRun {
			t.files++
			continue
		}
		if err := indexStore.SetFileIndex(ctx, parentID, attID, claim.messageID, claim.authorID, claim.createdAt); err != nil {
			slog.Warn("set file index failed", "parentID", parentID, "attID", attID, "error", err)
			t.errors++
			continue
		}
		t.files++
	}

	slog.Info("backfilled parent", "parentID", parentID, "parentType", parentType, "pins", len(pinIDs), "files", len(attIDs), "dry_run", dryRun)
	return nil
}
