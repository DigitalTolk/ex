package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// nkPageSize bounds how many user rows we pull per List call.
const nkPageSize = 100

// runNotificationKeywords backfills the per-user notification keyword list for
// accounts created before name keywords were seeded at sign-up.
//
// Idempotent and resumable: a user that already has a keyword (seeded or
// hand-edited) is skipped, so a re-run only touches still-empty accounts and
// never clobbers customizations.
func runNotificationKeywords(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("notification-keywords", args, nil)

	users := store.NewUserStore(db)
	slog.Info("starting notification-keyword backfill", "mode", mode, "table", db.Table)

	var scanned, seeded, skipped, errCount int
	cursor := ""
	for {
		page, next, err := users.ListUsers(ctx, nkPageSize, cursor)
		if err != nil {
			fatal("list users", err)
		}
		for _, u := range page {
			scanned++
			ns, changed := nkSeededSettings(u)
			if !changed {
				skipped++
				continue
			}
			if verbose {
				slog.Info("seed keywords", "userID", u.ID, "displayName", u.DisplayName, "keywords", ns.Keywords)
			}
			if dryRun {
				seeded++
				continue
			}
			u.NotificationSettings = ns
			if err := users.UpdateUser(ctx, u); err != nil {
				slog.Warn("update user failed", "userID", u.ID, "error", err)
				errCount++
				continue
			}
			seeded++
		}
		if next == "" {
			break
		}
		cursor = next
	}

	slog.Info("backfill complete", "mode", mode, "scanned", scanned, "seeded", seeded, "skipped", skipped, "errors", errCount)
	if errCount > 0 {
		return 1
	}
	return 0
}

// nkSeededSettings decides whether a user needs name keywords seeded and
// returns the settings to persist. (nil, false) means "leave this user alone":
// no display name, or already has at least one keyword.
func nkSeededSettings(u *model.User) (*model.NotificationSettings, bool) {
	kw := model.NotificationKeywordsFromName(u.DisplayName)
	if len(kw) == 0 {
		return nil, false
	}
	if u.NotificationSettings == nil {
		ns := model.DefaultNotificationSettingsForNewUser(u.DisplayName)
		return &ns, true
	}
	if len(u.NotificationSettings.Keywords) > 0 {
		return nil, false
	}
	ns := *u.NotificationSettings
	ns.Keywords = kw
	return &ns, true
}
