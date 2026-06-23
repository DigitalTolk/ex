// migrate is the consolidated one-off maintenance tool for an Ex DynamoDB
// table. Each subcommand is an idempotent, resumable backfill or cleanup that
// can be re-run any number of times without harm. All default to --dry-run;
// pass --apply to actually write.
//
// Usage:
//
//	go run ./cmd/migrate <subcommand> [--apply] [-v]
//
// Subcommands:
//
//	thread-delete          soft-delete replies whose thread root is already deleted
//	thread-index           backfill the GSI1 thread index on existing replies
//	parent-index           backfill per-parent PIN#/FILE# index rows
//	notification-keywords  seed name keywords for accounts that have none
//	attachment-relink      re-link orphaned attachments to their message [--window=1h]
//	draft-cleanup          delete orphaned DynamoDB DRAFT# rows (drafts now live in Redis)
//
// Required environment variables (same as the `ex` server):
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
	"strings"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// scanPageSize bounds how many MSG# rows we read per Query iteration when
// walking a parent. DynamoDB caps each response at 1 MB anyway; a smaller page
// keeps memory predictable for parents with very long history.
const scanPageSize = 500

// command is one idempotent subcommand. run parses its own flags out of args
// and returns a process exit code (0 = ok, 1 = some rows failed).
type command struct {
	summary string
	run     func(ctx context.Context, db *store.DB, args []string) int
}

func commands() map[string]command {
	return map[string]command{
		"thread-delete":         {"soft-delete replies whose thread root is already deleted", runThreadDelete},
		"thread-index":          {"backfill the GSI1 thread index on existing replies", runThreadIndex},
		"parent-index":          {"backfill per-parent PIN#/FILE# index rows", runParentIndex},
		"notification-keywords": {"seed name keywords for accounts that have none", runNotificationKeywords},
		"attachment-relink":     {"re-link orphaned attachments to their message [--window=1h]", runAttachmentRelink},
		"draft-cleanup":         {"delete orphaned DynamoDB DRAFT# rows (drafts now live in Redis)", runDraftCleanup},
	}
}

func main() {
	cmds := commands()
	if len(os.Args) < 2 {
		usage(cmds)
		os.Exit(2)
	}
	name := os.Args[1]
	cmd, ok := cmds[name]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n\n", name)
		usage(cmds)
		os.Exit(2)
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
	os.Exit(cmd.run(ctx, db, os.Args[2:]))
}

func usage(cmds map[string]command) {
	names := make([]string, 0, len(cmds))
	for n := range cmds {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("usage: migrate <subcommand> [--apply] [-v]\n\nsubcommands:\n")
	for _, n := range names {
		fmt.Fprintf(&b, "  %-22s %s\n", n, cmds[n].summary)
	}
	b.WriteString("\nall subcommands default to --dry-run; pass --apply to write.\n")
	fmt.Fprint(os.Stderr, b.String())
}

// migrateFlags parses the flags every subcommand shares (--dry-run/--apply/-v)
// and returns (dryRun, verbose, mode). register, if non-nil, adds extra flags
// (e.g. attachment-relink's --window) BEFORE parsing so the caller can read
// them afterwards.
func migrateFlags(name string, args []string, register func(*flag.FlagSet)) (dryRun, verbose bool, mode string) {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	dr := fs.Bool("dry-run", true, "log what would change without writing to DynamoDB")
	ap := fs.Bool("apply", false, "actually write changes (overrides --dry-run)")
	v := fs.Bool("v", false, "log every per-row decision (default: per-parent/summary only)")
	if register != nil {
		register(fs)
	}
	_ = fs.Parse(args)
	dryRun, verbose = *dr, *v
	if *ap {
		dryRun = false
	}
	mode = "dry-run"
	if !dryRun {
		mode = "apply"
	}
	return dryRun, verbose, mode
}

func fatal(msg string, err error) {
	if err == nil {
		err = errors.New(msg)
	}
	slog.Error(msg, "error", err)
	os.Exit(1)
}

// forEachParent walks every channel then every conversation — the message
// partitions every backfill scans — invoking fn(parentID, parentType, name) for
// each. name is the channel name (empty for conversations) for log context. A
// store list failure is fatal (the migration can't proceed without the full set).
func forEachParent(ctx context.Context, channelStore *store.ChannelStoreImpl, convStore *store.ConversationStoreImpl, fn func(parentID, parentType, name string)) {
	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		fatal("list channels", err)
	}
	slog.Info("scanned channels", "count", len(channels))
	for _, ch := range channels {
		fn(ch.ID, "channel", ch.Name)
	}
	convs, err := convStore.ListAll(ctx)
	if err != nil {
		fatal("list conversations", err)
	}
	slog.Info("scanned conversations", "count", len(convs))
	for _, c := range convs {
		fn(c.ID, "conversation", "")
	}
}

// forEachMessage pages through every MSG# row under one parent (oldest cursor
// forward, scanPageSize at a time) and calls fn for each. fn's error aborts the
// walk for that parent.
func forEachMessage(ctx context.Context, messageStore *store.MessageStoreImpl, parentID string, fn func(*model.Message) error) error {
	cursor := ""
	for {
		msgs, hasMore, err := messageStore.List(ctx, parentID, cursor, scanPageSize)
		if err != nil {
			return fmt.Errorf("scan messages: %w", err)
		}
		if len(msgs) == 0 {
			return nil
		}
		for _, m := range msgs {
			if err := fn(m); err != nil {
				return err
			}
		}
		if !hasMore {
			return nil
		}
		cursor = msgs[len(msgs)-1].ID
	}
}
