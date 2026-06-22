// migrate-notification-keywords backfills the per-user notification keyword
// list for existing Ex accounts. New accounts are seeded at sign-up with their
// first + full name as keywords (so messages mentioning a user's name notify
// them out of the box), but accounts created before that change have an empty
// keyword list. This one-off fills it in for every existing user.
//
// What it does per user:
//   - No display name → skipped (nothing to seed).
//   - Already has at least one keyword (seeded or hand-edited) → skipped, so
//     re-running is safe and customisations are never clobbered.
//   - Otherwise → first + full name are added to the keyword list. Any existing
//     notification settings (levels, thread/group/follow toggles) are preserved;
//     only the keyword list is filled in. A user with no saved settings at all
//     gets the standard new-user defaults plus their name keywords.
//
// Idempotent and resumable: each user is an independent conditional PutItem, so
// a crash leaves the table valid and a re-run only touches the still-empty ones.
//
// Usage:
//
//	go run ./cmd/migrate-notification-keywords --dry-run
//	go run ./cmd/migrate-notification-keywords --apply
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
	"log/slog"
	"os"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// pageSize bounds how many user rows we pull per List call. The user index is
// a single GSI2 partition, so this is just a memory/round-trip knob.
const pageSize = 100

func main() {
	dryRun := flag.Bool("dry-run", true, "log what would change without writing to DynamoDB")
	apply := flag.Bool("apply", false, "actually write the seeded keyword lists (overrides --dry-run)")
	verbose := flag.Bool("v", false, "log every user decision (default: summary only)")
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
	users := store.NewUserStore(db)

	slog.Info("starting notification-keyword backfill",
		"mode", mode,
		"table", cfg.DynamoDBTable,
		"region", cfg.AWSRegion,
	)

	var scanned, seeded, skipped, errCount int
	cursor := ""
	for {
		page, next, err := users.List(ctx, pageSize, cursor)
		if err != nil {
			fatal("list users", err)
		}
		for _, u := range page {
			scanned++
			ns, changed := seededSettings(u)
			if !changed {
				skipped++
				continue
			}
			if *verbose {
				slog.Info("seed keywords", "userID", u.ID, "displayName", u.DisplayName, "keywords", ns.Keywords)
			}
			if *dryRun {
				seeded++
				continue
			}
			u.NotificationSettings = ns
			if err := users.Update(ctx, u); err != nil {
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

	slog.Info("backfill complete",
		"mode", mode,
		"scanned", scanned,
		"seeded", seeded,
		"skipped", skipped,
		"errors", errCount,
	)
	if errCount > 0 {
		os.Exit(1)
	}
}

// seededSettings decides whether a user needs name keywords seeded and returns
// the settings to persist. (nil, false) means "leave this user alone": they
// have no display name, or already have at least one keyword. Existing non-
// keyword settings are carried over untouched.
func seededSettings(u *model.User) (*model.NotificationSettings, bool) {
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

func fatal(msg string, err error) {
	if err == nil {
		err = errors.New(msg)
	}
	slog.Error(msg, "error", err)
	os.Exit(1)
}
