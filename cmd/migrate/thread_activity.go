package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// runThreadActivity puts every followed thread into its follower's /threads
// list order: each follow row without a latest-reply time gets the one its
// thread root carries (LastReplyAt, else the root's own time). Rows written
// since the paged /threads list shipped carry it already.
//
// Idempotent and resumable: a row that has its time is left alone, and the
// write never moves a row behind a newer reply that landed meanwhile.
func runThreadActivity(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("thread-activity", args, nil)

	users := store.NewUserStore(db)
	follows := store.NewThreadFollowStore(db)
	messages := store.NewMessageStore(db)
	slog.Info("starting thread-activity backfill", "mode", mode, "table", db.Table)

	// Threads are shared by their followers: read each root once.
	latest := map[string]time.Time{}
	var scanned, stamped, gone, errCount int
	cursor := ""
	for {
		page, next, err := users.ListUsers(ctx, nkPageSize, cursor)
		if err != nil {
			fatal("list users", err)
		}
		for _, u := range page {
			rows, err := follows.ListUserThreadFollows(ctx, u.ID)
			if err != nil {
				slog.Warn("list follows failed", "userID", u.ID, "error", err)
				errCount++
				continue
			}
			pending := map[string][]*model.ThreadFollow{}
			for _, f := range rows {
				scanned++
				if f.Following && f.LastActivityAt == nil {
					pending[f.ParentID] = append(pending[f.ParentID], f)
				}
			}
			for parentID, fs := range pending {
				if err := taReadRoots(ctx, messages, parentID, fs, latest); err != nil {
					slog.Warn("read roots failed", "parentID", parentID, "error", err)
					errCount++
					continue
				}
				for _, f := range fs {
					at, ok := latest[parentID+"#"+f.ThreadRootID]
					if !ok {
						gone++
						continue
					}
					if verbose {
						slog.Info("thread activity", "userID", u.ID, "parentID", parentID, "root", f.ThreadRootID, "at", at)
					}
					if dryRun {
						stamped++
						continue
					}
					if err := follows.TouchThreadActivity(ctx, []string{u.ID}, parentID, f.ThreadRootID, at); err != nil {
						slog.Warn("stamp failed", "userID", u.ID, "root", f.ThreadRootID, "error", err)
						errCount++
						continue
					}
					stamped++
				}
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}

	slog.Info("backfill complete", "mode", mode, "follows_scanned", scanned, "stamped", stamped, "root_gone", gone, "errors", errCount)
	if errCount > 0 {
		return 1
	}
	return 0
}

// taReadRoots fills latest with the latest-reply time of each followed root
// in parentID it doesn't know yet. A root that no longer exists stays out.
func taReadRoots(ctx context.Context, messages *store.MessageStoreImpl, parentID string, fs []*model.ThreadFollow, latest map[string]time.Time) error {
	var ids []string
	for _, f := range fs {
		if _, ok := latest[parentID+"#"+f.ThreadRootID]; !ok {
			ids = append(ids, f.ThreadRootID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	roots, err := messages.GetMessagesByIDs(ctx, parentID, ids)
	if err != nil {
		return err
	}
	for _, r := range roots {
		at := r.CreatedAt
		if r.LastReplyAt != nil && r.LastReplyAt.After(at) {
			at = *r.LastReplyAt
		}
		latest[parentID+"#"+r.ID] = at
	}
	return nil
}
