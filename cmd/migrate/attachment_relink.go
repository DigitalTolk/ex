package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// runAttachmentRelink repairs message↔attachment links a historical edit bug
// severed, re-linking an orphaned attachment to its owning message ONLY when
// the match is unambiguous (exactly one same-author, edited, attachment-less
// message created within --window of the upload). Ambiguous/unmatched orphans
// are reported, never guessed.
//
// Idempotent: an attachment that already has a non-empty MessageIDs set is
// skipped. Resumable: every write stands alone.
func runAttachmentRelink(ctx context.Context, db *store.DB, args []string) int {
	var window *time.Duration
	dryRun, _, mode := migrateFlags("attachment-relink", args, func(fs *flag.FlagSet) {
		window = fs.Duration("window", time.Hour, "max gap between an attachment's upload and its candidate message's createdAt")
	})

	attachmentStore := store.NewAttachmentStore(db)
	channelStore := store.NewChannelStore(db)
	convStore := store.NewConversationStore(db)
	messageStore := store.NewMessageStore(db)
	indexStore := store.NewParentIndexStore(db)

	slog.Info("starting attachment-relink", "mode", mode, "window", window.String(), "table", db.Table)

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

	victimsByAuthor, msgCount, err := arCollectVictims(ctx, channelStore, convStore, messageStore)
	if err != nil {
		fatal("collect victims", err)
	}
	victimCount := 0
	for _, vs := range victimsByAuthor {
		victimCount += len(vs)
	}
	slog.Info("scanned messages", "total", msgCount, "edited_attachmentless", victimCount)

	t := arTotals{}
	relinks := map[string][]arRelink{}
	victimByKey := map[string]arVictim{}

	for _, orphan := range orphans {
		t.orphans++
		candidates := arMatchCandidates(orphan, victimsByAuthor[orphan.CreatedBy], *window)
		switch len(candidates) {
		case 0:
			t.unmatched++
			slog.Info("orphan unmatched (no candidate)", "attachmentID", orphan.ID, "filename", orphan.Filename, "uploadedBy", orphan.CreatedBy)
		case 1:
			v := candidates[0]
			key := v.parentID + "#" + v.msg.ID
			relinks[key] = append(relinks[key], arRelink{attachment: orphan, v: v})
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
		slog.Info("re-link", "msgID", v.msg.ID, "parentID", v.parentID, "parentType", v.parentType, "attachmentIDs", ids, "dry_run", dryRun)
		if dryRun {
			t.relinked += len(ids)
			continue
		}
		if err := arApplyRelink(ctx, messageStore, attachmentStore, indexStore, v, ids); err != nil {
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
		return 1
	}
	return 0
}

type arTotals struct {
	orphans   int
	relinked  int
	ambiguous int
	unmatched int
	errors    int
}

// arVictim is an edited, currently attachment-less message — a candidate to
// receive a re-linked orphan.
type arVictim struct {
	parentID   string
	parentType string
	msg        *model.Message
}

type arRelink struct {
	attachment *model.Attachment
	v          arVictim
}

// arMatchCandidates returns the victim messages that plausibly owned the
// orphan: same author (pre-filtered by the caller), sent at or after the
// upload, and within window of it.
func arMatchCandidates(orphan *model.Attachment, victims []arVictim, window time.Duration) []arVictim {
	out := make([]arVictim, 0, 1)
	for _, v := range victims {
		gap := v.msg.CreatedAt.Sub(orphan.CreatedAt)
		if gap < 0 || gap > window {
			continue
		}
		out = append(out, v)
	}
	return out
}

func arCollectVictims(ctx context.Context, channelStore *store.ChannelStoreImpl, convStore *store.ConversationStoreImpl, messageStore *store.MessageStoreImpl) (map[string][]arVictim, int, error) {
	byAuthor := map[string][]arVictim{}
	count := 0
	var scanErr error

	forEachParent(ctx, channelStore, convStore, func(parentID, parentType, _ string) {
		if scanErr != nil {
			return
		}
		scanErr = forEachMessage(ctx, messageStore, parentID, func(m *model.Message) error {
			count++
			if m.Deleted || m.EditedAt == nil || len(m.AttachmentIDs) > 0 || m.AuthorID == "" {
				return nil
			}
			byAuthor[m.AuthorID] = append(byAuthor[m.AuthorID], arVictim{parentID: parentID, parentType: parentType, msg: m})
			return nil
		})
	})
	return byAuthor, count, scanErr
}

// arApplyRelink writes the repair: the message regains the attachment IDs, the
// attachment refcount regains the message, and the FILE# index row is rebuilt.
func arApplyRelink(ctx context.Context, messageStore *store.MessageStoreImpl, attachmentStore *store.AttachmentStoreImpl, indexStore *store.ParentIndexStoreImpl, v arVictim, attachmentIDs []string) error {
	updated := *v.msg
	updated.AttachmentIDs = append(append([]string(nil), v.msg.AttachmentIDs...), attachmentIDs...)
	if err := messageStore.UpdateMessage(ctx, &updated); err != nil {
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
