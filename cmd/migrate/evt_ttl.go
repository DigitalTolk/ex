package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/redis/go-redis/v9"
)

// runEvtTTL backfills the idle TTL onto durable inbox streams (`evt:<userID>`)
// created before the TTL existed. Those keys are MAXLEN-bounded but had no
// expiry, so a departed/idle user's stream pinned ~2000 event blobs in RAM
// forever. New appends self-heal (each refreshes the expiry); this reaps the
// streams of users who will never append again.
//
// Redis-only: it ignores the DynamoDB handle and dials Redis from REDIS_URL.
// Idempotent — a re-run only touches keys that still lack a TTL.
func runEvtTTL(ctx context.Context, _ *store.DB, args []string) int {
	dryRun, _, mode := migrateFlags("evt-ttl", args, nil)

	cfg, err := config.Load()
	if err != nil {
		fatal("config load failed", err)
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		fatal("parse redis url", err)
	}
	client := redis.NewClient(opts)
	defer func() { _ = client.Close() }()

	stream := eventlog.NewStream(client, 0)
	slog.Info("starting evt-ttl", "mode", mode)

	res, err := stream.BackfillTTL(ctx, !dryRun)
	if err != nil {
		fatal("backfill evt ttl", err)
	}
	slog.Info("evt-ttl done", "mode", mode, "scanned", res.Scanned, "missing_ttl", res.Missing, "updated", res.Updated)
	return 0
}
