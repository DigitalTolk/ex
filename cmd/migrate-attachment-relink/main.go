// migrate-attachment-relink repairs message↔attachment links that a
// historical edit bug severed.
//
// The bug: editing a message could submit an empty attachment list (the
// edit composer opened before the existing attachments loaded), which the
// server interpreted as "remove all attachments". That cleared the
// message's AttachmentIDs, removed the message from each attachment's
// refcount set, and dropped the FILE# index row — severing the link in
// every direction. The only survivor is the now-orphaned attachment row
// (its MessageIDs set is empty) which still records who uploaded it and
// when.
//
// This migration finds those orphaned attachments and re-links each to its
// owning message ONLY when the match is unambiguous: exactly one candidate
// message exists by the same author, edited, currently attachment-less, and
// created within --window of the attachment's upload time. Ambiguous or
// unmatched orphans are reported, never guessed — matching the "safe
// re-link" contract.
//
// Idempotent: an attachment that already has a non-empty MessageIDs set is
// skipped. Resumable on failure: every write stands alone.
//
// Usage:
//
//	go run ./cmd/migrate-attachment-relink --dry-run
//	go run ./cmd/migrate-attachment-relink --apply
//	go run ./cmd/migrate-attachment-relink --apply --window=2h
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
	"time"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

const scanPageSize = 500

// victim is an edited, currently attachment-less message — a candidate to
// receive a re-linked orphan.
type victim struct {
	parentID   string
	parentType string
	msg        *model.Message
}

func main() {
	dryRun := flag.Bool("dry-run", true, "if set, report what would be re-linked without touching DynamoDB")
	apply := flag.Bool("apply", false, "actually re-link unambiguous orphans (overrides --dry-run)")
	window := flag.Duration("window", time.Hour, "max gap between an attachment's upload and its candidate message's createdAt")
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

	attachmentStore := store.NewAttachmentStore(db)
	channelStore := store.NewChannelStore(db)
	convStore := store.NewConversationStore(db)
	messageStore := store.NewMessageStore(db)
	indexStore := store.NewParentIndexStore(db)

	slog.Info("starting attachment-relink", "mode", mode, "window", window.String(), "table", cfg.DynamoDBTable)

	// 1. Orphaned attachments: uploaded but referenced by nothing.
	attachments, err := attachmentStore.ListAll(ctx)
	if err != nil {
		fatal("list attachments", err)
	}
	orphans := make([]*model.Attachment, 0)
	for _, a := range attachments {
		if len(a.MessageIDs) == 0 {
			orphans = append(orphans, a)
		}
	}
	slog.Info("scanned attachments", "total", len(attachments), "orphaned", len(orphans))

	// 2. Victim messages, grouped by author for candidate lookup.
	victimsByAuthor, msgCount, err := collectVictims(ctx, channelStore, convStore, messageStore)
	if err != nil {
		fatal("collect victims", err)
	}
	victimCount := 0
	for _, vs := range victimsByAuthor {
		victimCount += len(vs)
	}
	slog.Info("scanned messages", "total", msgCount, "edited_attachmentless", victimCount)

	// 3. Match each orphan to exactly one candidate, then apply.
	t := totals{}
	// Accumulate per-victim so a message that lost several attachments is
	// updated once with all of them re-linked.
	relinks := map[string][]relink{} // key: parentID + "#" + msgID
	victimByKey := map[string]victim{}

	for _, orphan := range orphans {
		t.orphans++
		candidates := matchCandidates(orphan, victimsByAuthor[orphan.CreatedBy], *window)
		switch len(candidates) {
		case 0:
			t.unmatched++
			slog.Info("orphan unmatched (no candidate)", "attachmentID", orphan.ID, "filename", orphan.Filename, "uploadedBy", orphan.CreatedBy)
		case 1:
			v := candidates[0]
			key := v.parentID + "#" + v.msg.ID
			relinks[key] = append(relinks[key], relink{attachment: orphan, v: v})
			victimByKey[key] = v
		default:
			t.ambiguous++
			slog.Info("orphan ambiguous (multiple candidates)", "attachmentID", orphan.ID, "filename", orphan.Filename, "candidates", len(candidates))
		}
	}

	for key, rs := range relinks {
		v := victimByKey[key]
		ids := make([]string, 0, len(rs))
		for _, r := range rs {
			ids = append(ids, r.attachment.ID)
		}
		slog.Info("re-link", "msgID", v.msg.ID, "parentID", v.parentID, "parentType", v.parentType, "attachmentIDs", ids, "dry_run", *dryRun)
		if *dryRun {
			t.relinked += len(ids)
			continue
		}
		if err := applyRelink(ctx, messageStore, attachmentStore, indexStore, v, ids); err != nil {
			slog.Error("re-link failed", "msgID", v.msg.ID, "error", err)
			t.errors++
			continue
		}
		t.relinked += len(ids)
	}

	slog.Info("attachment-relink complete",
		"mode", mode,
		"orphans", t.orphans,
		"relinked", t.relinked,
		"ambiguous", t.ambiguous,
		"unmatched", t.unmatched,
		"errors", t.errors,
	)
	if t.errors > 0 {
		os.Exit(1)
	}
}

type totals struct {
	orphans   int
	relinked  int
	ambiguous int
	unmatched int
	errors    int
}

type relink struct {
	attachment *model.Attachment
	v          victim
}

// matchCandidates returns the victim messages that plausibly owned the
// orphan: same author (already pre-filtered by the caller's map key), the
// message sent at or after the upload, and within window of it.
func matchCandidates(orphan *model.Attachment, victims []victim, window time.Duration) []victim {
	out := make([]victim, 0, 1)
	for _, v := range victims {
		gap := v.msg.CreatedAt.Sub(orphan.CreatedAt)
		if gap < 0 || gap > window {
			continue
		}
		out = append(out, v)
	}
	return out
}

func collectVictims(
	ctx context.Context,
	channelStore *store.ChannelStoreImpl,
	convStore *store.ConversationStoreImpl,
	messageStore *store.MessageStoreImpl,
) (map[string][]victim, int, error) {
	byAuthor := map[string][]victim{}
	count := 0

	scanParent := func(parentID, parentType string) error {
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
				count++
				if m.Deleted || m.EditedAt == nil || len(m.AttachmentIDs) > 0 || m.AuthorID == "" {
					continue
				}
				byAuthor[m.AuthorID] = append(byAuthor[m.AuthorID], victim{parentID: parentID, parentType: parentType, msg: m})
			}
			if !hasMore {
				return nil
			}
			cursor = msgs[len(msgs)-1].ID
		}
	}

	channels, err := channelStore.ListAll(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("list channels: %w", err)
	}
	for _, ch := range channels {
		if err := scanParent(ch.ID, "channel"); err != nil {
			return nil, 0, err
		}
	}
	convs, err := convStore.ListAll(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("list conversations: %w", err)
	}
	for _, c := range convs {
		if err := scanParent(c.ID, "conversation"); err != nil {
			return nil, 0, err
		}
	}
	return byAuthor, count, nil
}


// applyRelink writes the repair: the message regains the attachment IDs, the
// attachment refcount regains the message, and the FILE# index row is
// rebuilt so ListFiles surfaces the recovered share.
func applyRelink(
	ctx context.Context,
	messageStore *store.MessageStoreImpl,
	attachmentStore *store.AttachmentStoreImpl,
	indexStore *store.ParentIndexStoreImpl,
	v victim,
	attachmentIDs []string,
) error {
	updated := *v.msg
	updated.AttachmentIDs = append(append([]string(nil), v.msg.AttachmentIDs...), attachmentIDs...)
	if err := messageStore.Update(ctx, v.parentID, &updated); err != nil {
		return fmt.Errorf("update message: %w", err)
	}
	for _, aid := range attachmentIDs {
		if err := attachmentStore.AddRef(ctx, aid, v.msg.ID); err != nil {
			return fmt.Errorf("add ref %s: %w", aid, err)
		}
		if err := indexStore.SetFileIndex(ctx, v.parentID, aid, v.msg.ID, v.msg.AuthorID, v.msg.CreatedAt); err != nil {
			return fmt.Errorf("set file index %s: %w", aid, err)
		}
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
