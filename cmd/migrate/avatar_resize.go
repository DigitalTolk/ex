package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// arPageSize bounds how many user rows we pull per List call.
const arPageSize = 100

// arDecodeLimit is how much memory decoding one avatar may take here, ~89
// megapixels. The server stops at ~22 (its share of a budget every upload in
// flight draws from), which refuses some of the full-size camera photos this
// backfill exists to shrink; it decodes one avatar at a time.
const arDecodeLimit = 1 << 30

// avatarShrinker is the slice of service.UserService the backfill drives.
type avatarShrinker interface {
	ShrinkAvatar(ctx context.Context, userID string, dryRun bool) (bool, error)
}

// userLister pages through every user row.
type userLister interface {
	ListUsers(ctx context.Context, limit int, lastKey string) ([]*model.User, string, error)
}

// runAvatarResize shrinks avatars uploaded before the server resized them to
// fit service.MaxAvatarSide. It goes through the user service, so the cached
// profile is dropped and connected clients get user.updated with the new URL.
//
// Idempotent: an avatar that already fits is skipped. The original objects
// are kept (open clients may still be showing them).
func runAvatarResize(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("avatar-resize", args, nil)

	cfg, err := config.Load()
	if err != nil {
		fatal("config load failed", err)
	}
	s3Client, err := storage.NewS3Client(ctx, storage.S3Config{
		Endpoint:       cfg.S3Endpoint,
		PublicEndpoint: cfg.S3PublicEndpoint,
		Bucket:         cfg.S3Bucket,
		AccessKey:      cfg.S3AccessKey,
		SecretKey:      cfg.S3SecretKey,
		Region:         cfg.S3Region,
	})
	if err != nil {
		fatal("s3 connect failed", err)
	}
	redisCache, err := cache.NewRedisCache(cfg.RedisURL)
	if err != nil {
		fatal("redis connect failed", err)
	}
	redisPubSub, err := pubsub.NewRedisPubSub(cfg.RedisURL)
	if err != nil {
		fatal("redis pubsub connect failed", err)
	}
	defer func() { _ = redisPubSub.Client().Close() }()

	users := store.NewUserStore(db)
	svc := service.NewUserService(users, redisCache, s3Client, redisPubSub)
	svc.SetMediaURLCache(redisCache)
	svc.SetAvatarObjects(s3Client)
	svc.SetAvatarDecodeLimit(arDecodeLimit)

	slog.Info("starting avatar-resize", "mode", mode, "maxSide", service.MaxAvatarSide, "decodeLimitMiB", arDecodeLimit>>20)
	return avatarResize(ctx, users, svc, dryRun, verbose, mode)
}

// avatarResize is the env-free core of the subcommand: it walks every user
// with an avatar and shrinks the ones that are too big.
func avatarResize(ctx context.Context, users userLister, svc avatarShrinker, dryRun, verbose bool, mode string) int {
	var scanned, shrunk, skipped, errCount int
	cursor := ""
	for {
		page, next, err := users.ListUsers(ctx, arPageSize, cursor)
		if err != nil {
			fatal("list users", err)
		}
		for _, u := range page {
			scanned++
			if u.AvatarKey == "" {
				skipped++
				continue
			}
			changed, err := svc.ShrinkAvatar(ctx, u.ID, dryRun)
			if err != nil {
				slog.Warn("shrink avatar failed", "userID", u.ID, "key", u.AvatarKey, "error", err)
				errCount++
				continue
			}
			if !changed {
				skipped++
				continue
			}
			if verbose {
				slog.Info("shrink avatar", "userID", u.ID, "key", u.AvatarKey)
			}
			shrunk++
		}
		if next == "" {
			break
		}
		cursor = next
	}

	slog.Info("avatar-resize complete", "mode", mode, "scanned", scanned, "shrunk", shrunk, "skipped", skipped, "errors", errCount)
	if errCount > 0 {
		return 1
	}
	return 0
}
