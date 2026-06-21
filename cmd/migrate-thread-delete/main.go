// migrate-thread-delete soft-deletes every reply whose thread root has
// already been soft-deleted.
//
// Deleting a thread root now cascades to every reply (see
// MessageService.Delete), but threads deleted *before* that behavior
// shipped left their replies live: the root renders as a "(Message
// deleted)" tombstone while its replies are still visible in the thread
// pane. This one-off walks every channel + conversation, finds replies
// pointing at a deleted root, and tombstones them so historical data
// matches the new invariant.
//
// Tombstoning here means the same field clearing the service does:
// Deleted=true and Body / AttachmentIDs / Reactions / pin-state cleared.
// No events are published — these threads were closed long ago and no
// client is watching them. The PIN# / FILE# index rows owned by an
// affected reply are left in place; ListPinned / ListFiles self-heal
// stale rows on read, so they resolve to nothing once the message is a
// tombstone.
//
// Idempotent: a reply that's already Deleted is skipped, so re-running
// rewrites nothing. Resumable on failure: each Update stands alone.
//
// Usage:
//
//	go run ./cmd/migrate-thread-delete --dry-run
//	go run ./cmd/migrate-thread-delete --apply
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

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// scanPageSize bounds how many MSG# rows we read per Query iteration when
// walking a parent. DynamoDB caps each response at 1 MB anyway; a smaller
// page keeps memory predictable for channels with very long history.
const scanPageSize = 500

func main() {
	dryRun := flag.Bool("dry-run", true, "if set, log what would be deleted without touching DynamoDB")
	apply := flag.Bool("apply", false, "actually tombstone orphaned replies (overrides --dry-run)")
	verbose := flag.Bool("v", false, "log every reply decision (default: per-parent summary only)")
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

	slog.Info("starting thread-delete backfill",
		"mode", mode,
		"table", cfg.DynamoDBTable,
		"region", cfg.AWSRegion,
	)

	t := totals{}

	// Channels first, then conversations. Both hold message partitions;
	// the cascade doesn't care about parent type.
	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		fatal("list channels", err)
	}
	slog.Info("scanned channels", "count", len(channels))
	for _, ch := range channels {
		if err := backfillParent(ctx, messageStore, ch.ID, "channel", *dryRun, *verbose, &t); err != nil {
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
		if err := backfillParent(ctx, messageStore, c.ID, "conversation", *dryRun, *verbose, &t); err != nil {
			slog.Error("conversation backfill failed", "conversationID", c.ID, "error", err)
			t.errors++
		}
	}

	slog.Info("backfill complete",
		"mode", mode,
		"parents_processed", t.parents,
		"messages_scanned", t.messages,
		"replies_tombstoned", t.tombstoned,
		"errors", t.errors,
	)
	if t.errors > 0 {
		os.Exit(1)
	}
}

type totals struct {
	parents    int
	messages   int
	tombstoned int
	errors     int
}

// backfillParent walks one parent partition, builds the set of deleted
// thread roots, then tombstones every still-live reply pointing at one of
// them.
func backfillParent(
	ctx context.Context,
	messageStore *store.MessageStoreImpl,
	parentID, parentType string,
	dryRun, verbose bool,
	t *totals,
) error {
	t.parents++

	// Load every row first: a reply can sort before its root, so we can't
	// decide reply-by-reply in a single streaming pass.
	all := make([]*model.Message, 0, scanPageSize)
	deletedRoots := map[string]struct{}{}

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
			all = append(all, m)
			// A top-level message that's been soft-deleted is a closed
			// thread root. (Replies always carry ParentMessageID, so a
			// deleted reply is never mistaken for a root here.)
			if m.Deleted && m.ParentMessageID == "" {
				deletedRoots[m.ID] = struct{}{}
			}
		}
		if !hasMore {
			break
		}
		cursor = msgs[len(msgs)-1].ID
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
			slog.Info("tombstone reply",
				"parentID", parentID, "parentType", parentType,
				"msgID", m.ID, "rootID", m.ParentMessageID,
			)
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
		slog.Info("backfilled parent",
			"parentID", parentID,
			"parentType", parentType,
			"replies_tombstoned", tombstoned,
			"dry_run", dryRun,
		)
	}
	return nil
}

func fatal(msg string, err error) {
	if err == nil {
		err = errors.New(msg)
	}
	slog.Error(msg, "error", err)
	os.Exit(1)
}
