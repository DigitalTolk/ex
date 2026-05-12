// migrate-parent-index backfills the per-parent PIN# and FILE#
// index rows for an Ex DynamoDB table. The index makes ListPinned
// and ListFiles O(pinned) / O(files-shared) instead of O(messages),
// but it's populated lazily on new pin / new attachment events — so
// pre-migration content stays invisible to the indexed query path
// until you run this one-off.
//
// Running it after the schema migration in #5 is OPTIONAL: the
// service layer falls back to a 1000-message scan when the index
// is empty, so users still see correct results, just slowly. Run
// this to get indexed-query performance from the moment you ship.
//
// Idempotent: re-running rewrites the same PIN# / FILE# rows with
// the same content. Resumable on failure: every parent partition is
// independently transactional in DDB terms (each PutItem stands
// alone) so a crash leaves the table in a valid in-between state.
//
// Usage:
//
//   go run ./cmd/migrate-parent-index --dry-run
//   go run ./cmd/migrate-parent-index --apply
//
// Required environment variables (same as `ex` server):
//   - AWS_REGION
//   - DYNAMODB_TABLE
//   - DYNAMODB_ENDPOINT (only for DynamoDB Local)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"time"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/store"
)

// scanPageSize bounds how many MSG# rows we read per Query iteration
// when walking a parent. DynamoDB's per-query response is capped at
// 1 MB anyway, but a smaller page keeps memory predictable for
// channels with very long history.
const scanPageSize = 500

func main() {
	dryRun := flag.Bool("dry-run", true, "if set, log what would be written without touching DynamoDB")
	apply := flag.Bool("apply", false, "actually write index rows (overrides --dry-run)")
	verbose := flag.Bool("v", false, "log every PIN/FILE row decision (default: per-parent summary only)")
	flag.Parse()

	// Default is dry-run. --apply flips it.
	mode := "dry-run"
	if *apply {
		*dryRun = false
		mode = "apply"
	}

	cfg, err := config.Load()
	if err != nil {
		fatal("config load failed", err)
	}

	ctx := context.Background()
	db, err := store.New(ctx, store.DBConfig{
		Region:   cfg.AWSRegion,
		Endpoint: cfg.DynamoDBEndpoint,
		Table:    cfg.DynamoDBTable,
	})
	if err != nil {
		fatal("dynamodb connect failed", err)
	}

	channelStore := store.NewChannelStore(db)
	convStore := store.NewConversationStore(db)
	messageStore := store.NewMessageStore(db)
	indexStore := store.NewParentIndexStore(db)

	slog.Info("starting parent-index backfill",
		"mode", mode,
		"table", cfg.DynamoDBTable,
		"region", cfg.AWSRegion,
	)

	totals := totals{}

	// Channels first, then conversations. Both contribute message
	// partitions; the indexer doesn't care about parent type.
	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		fatal("list channels", err)
	}
	slog.Info("scanned channels", "count", len(channels))
	for _, ch := range channels {
		if err := backfillParent(ctx, messageStore, indexStore, ch.ID, "channel", *dryRun, *verbose, &totals); err != nil {
			slog.Error("channel backfill failed", "channelID", ch.ID, "name", ch.Name, "error", err)
		}
	}

	convs, err := convStore.ListAll(ctx)
	if err != nil {
		fatal("list conversations", err)
	}
	slog.Info("scanned conversations", "count", len(convs))
	for _, c := range convs {
		if err := backfillParent(ctx, messageStore, indexStore, c.ID, "conversation", *dryRun, *verbose, &totals); err != nil {
			slog.Error("conversation backfill failed", "conversationID", c.ID, "error", err)
		}
	}

	slog.Info("backfill complete",
		"mode", mode,
		"parents_processed", totals.parents,
		"messages_scanned", totals.messages,
		"pin_rows_written", totals.pins,
		"file_rows_written", totals.files,
		"errors", totals.errors,
	)
	if totals.errors > 0 {
		os.Exit(1)
	}
}

type totals struct {
	parents  int
	messages int
	pins     int
	files    int
	errors   int
}

// backfillParent scans every MSG# row under one parent partition and
// writes a PIN# row per pinned message + a FILE# row per attachment.
// Per-attachment dedup picks the most recent message (by createdAt)
// that referenced the file — matches the runtime ListFiles ordering.
func backfillParent(
	ctx context.Context,
	messageStore *store.MessageStoreImpl,
	indexStore *store.ParentIndexStoreImpl,
	parentID, parentType string,
	dryRun, verbose bool,
	totals *totals,
) error {
	totals.parents++

	// Aggregate every MSG# row's pinned + attachment data first, then
	// commit. Per-attachment latest-wins requires seeing every row.
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
			totals.messages++
			if m.Deleted {
				continue
			}
			if m.Pinned {
				when := time.Time{}
				if m.PinnedAt != nil {
					when = *m.PinnedAt
				}
				pinned[m.ID] = pinClaim{
					pinnedBy: m.PinnedBy,
					pinnedAt: when,
				}
			}
			for _, aid := range m.AttachmentIDs {
				if aid == "" {
					continue
				}
				if cur, ok := attachments[aid]; ok && cur.createdAt.After(m.CreatedAt) {
					continue
				}
				attachments[aid] = attachmentClaim{
					messageID: m.ID,
					authorID:  m.AuthorID,
					createdAt: m.CreatedAt,
				}
			}
		}
		if !hasMore {
			break
		}
		cursor = msgs[len(msgs)-1].ID
	}

	// Stable ordering for log readability.
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
			totals.pins++
			continue
		}
		if err := indexStore.SetPinIndex(ctx, parentID, msgID, claim.pinnedBy, claim.pinnedAt); err != nil {
			slog.Warn("set pin index failed", "parentID", parentID, "msgID", msgID, "error", err)
			totals.errors++
			continue
		}
		totals.pins++
	}

	for _, attID := range attIDs {
		claim := attachments[attID]
		if verbose {
			slog.Info("file index", "parentID", parentID, "parentType", parentType, "attID", attID, "msgID", claim.messageID)
		}
		if dryRun {
			totals.files++
			continue
		}
		if err := indexStore.SetFileIndex(ctx, parentID, attID, claim.messageID, claim.authorID, claim.createdAt); err != nil {
			slog.Warn("set file index failed", "parentID", parentID, "attID", attID, "error", err)
			totals.errors++
			continue
		}
		totals.files++
	}

	slog.Info("backfilled parent",
		"parentID", parentID,
		"parentType", parentType,
		"pins", len(pinIDs),
		"files", len(attIDs),
		"dry_run", dryRun,
	)
	return nil
}

type pinClaim struct {
	pinnedBy string
	pinnedAt time.Time
}

func fatal(msg string, err error) {
	if err == nil {
		err = errors.New(msg)
	}
	slog.Error(msg, "error", err)
	os.Exit(1)
}
