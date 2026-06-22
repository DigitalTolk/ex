// migrate-thread-index backfills the GSI1 thread index on existing reply
// messages (those with a ParentMessageID) for an Ex DynamoDB table. The index
// lets ListThreadMessages fetch a whole thread with one GSI Query instead of
// scanning the parent's message partition, but it's only stamped on new replies
// going forward — so replies created before this ships stay invisible to the
// indexed query path until you run this one-off.
//
// Running it is OPTIONAL: the service layer falls back to a parent scan when a
// thread has a recorded reply count but no indexed replies, so historical
// threads still render correctly, just via the slower path. Run this to get
// indexed-query performance for old threads too.
//
// Idempotent: re-running stamps the same GSI keys. Resumable on failure: each
// reply is stamped with an independent UpdateItem, so a crash leaves the table
// in a valid in-between state. The stamp is a targeted update (GSI keys only),
// so it never clobbers a concurrent edit to the message body.
//
// Usage:
//
//	go run ./cmd/migrate-thread-index --dry-run
//	go run ./cmd/migrate-thread-index --apply
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
	"github.com/DigitalTolk/ex/internal/store"
)

// scanPageSize bounds how many MSG# rows we read per Query iteration when
// walking a parent. The per-query response is 1 MB-capped anyway; a smaller
// page keeps memory predictable for channels with very long history.
const scanPageSize = 500

func main() {
	dryRun := flag.Bool("dry-run", true, "if set, log what would be stamped without touching DynamoDB")
	apply := flag.Bool("apply", false, "actually stamp GSI index keys (overrides --dry-run)")
	verbose := flag.Bool("v", false, "log every reply decision (default: per-parent summary only)")
	flag.Parse()

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

	slog.Info("starting thread-index backfill", "mode", mode, "table", cfg.DynamoDBTable, "region", cfg.AWSRegion)

	t := totals{}

	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		fatal("list channels", err)
	}
	slog.Info("scanned channels", "count", len(channels))
	for _, ch := range channels {
		if err := backfillParent(ctx, messageStore, ch.ID, *dryRun, *verbose, &t); err != nil {
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
		if err := backfillParent(ctx, messageStore, c.ID, *dryRun, *verbose, &t); err != nil {
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
		os.Exit(1)
	}
}

type totals struct {
	parents  int
	messages int
	replies  int
	errors   int
}

// backfillParent walks every MSG# row under one parent and stamps the GSI1
// thread keys on each reply (ParentMessageID != "").
func backfillParent(ctx context.Context, messageStore *store.MessageStoreImpl, parentID string, dryRun, verbose bool, t *totals) error {
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

func fatal(msg string, err error) {
	if err == nil {
		err = errors.New(msg)
	}
	slog.Error(msg, "error", err)
	os.Exit(1)
}
