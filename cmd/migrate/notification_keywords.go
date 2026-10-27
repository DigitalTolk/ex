package main

import (
	"context"
	"log/slog"
	"slices"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// nkPageSize bounds how many user rows we pull per List call.
const nkPageSize = 100

// runNotificationKeywords backfills the per-user notification keyword list for
// accounts created before name keywords were seeded at sign-up, and swaps an
// auto-seeded name prefix ("Muhammad" from "Muhammad Ali Khan") for the name
// the person goes by ("Ali Khan"): the prefix alerted them for every Muhammad.
//
// Idempotent and resumable: a user that already has a keyword (seeded or
// hand-edited) keeps it, apart from that one seeded prefix, so a re-run only
// touches still-empty or still-prefixed accounts and never clobbers
// customizations.
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

// nkSeededSettings decides whether a user needs name keywords seeded (or a
// seeded name prefix replaced) and returns the settings to persist. (nil,
// false) means "leave this user alone": no display name, or keywords that
// need nothing.
func nkSeededSettings(u *model.User) (*model.NotificationSettings, bool) {
	if u.NotificationSettings != nil && len(u.NotificationSettings.Keywords) > 0 {
		return nkWithoutSeededPrefix(u)
	}
	kw := model.NotificationKeywordsFromName(u.DisplayName)
	if len(kw) == 0 {
		return nil, false
	}
	if u.NotificationSettings == nil {
		ns := model.DefaultNotificationSettingsForNewUser(u.DisplayName)
		return &ns, true
	}
	ns := *u.NotificationSettings
	ns.Keywords = kw
	return &ns, true
}

// nkWithoutSeededPrefix replaces the keyword sign-up seeded from the first
// word of the display name when that word is a name prefix: "Muhammad" in
// ["Muhammad", "Muhammad Ali Khan"] becomes "Ali Khan" (model.ShortName),
// unless that is listed already. Every other keyword stays as it is.
func nkWithoutSeededPrefix(u *model.User) (*model.NotificationSettings, bool) {
	words := strings.Fields(u.DisplayName)
	if len(words) == 0 || !model.IsNamePrefix(words[0]) {
		return nil, false
	}
	kw := u.NotificationSettings.Keywords
	i := slices.IndexFunc(kw, func(k string) bool { return strings.EqualFold(k, words[0]) })
	if i < 0 {
		return nil, false
	}
	out := slices.Delete(slices.Clone(kw), i, i+1)
	first := model.ShortName(u.DisplayName)
	if !model.IsNamePrefix(first) && !slices.ContainsFunc(out, func(k string) bool { return strings.EqualFold(k, first) }) {
		out = slices.Insert(out, i, first)
	}
	ns := *u.NotificationSettings
	ns.Keywords = out
	return &ns, true
}
