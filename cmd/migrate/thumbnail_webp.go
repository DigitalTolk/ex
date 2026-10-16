package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// thumbnailReencoder is service.ReencodeThumbnail bound to an object store.
type thumbnailReencoder func(ctx context.Context, key string, dryRun bool) (bool, error)

// runThumbnailWebP rewrites the message thumbnails written as lossless WebP
// (before thumbnails were lossy) as lossy WebP, in place: same keys, same
// pictures, a fraction of the bytes.
//
// S3-only apart from listing the attachments. Idempotent: a thumbnail that is
// already lossy is skipped.
func runThumbnailWebP(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("thumbnail-webp", args, nil)

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
	attachments, err := store.NewAttachmentStore(db).ListAll(ctx)
	if err != nil {
		fatal("list attachments", err)
	}
	slog.Info("starting thumbnail-webp", "mode", mode, "attachments", len(attachments))
	reencode := func(ctx context.Context, key string, dryRun bool) (bool, error) {
		return service.ReencodeThumbnail(ctx, s3Client, key, dryRun)
	}
	return thumbnailWebP(ctx, attachments, reencode, dryRun, verbose, mode)
}

// thumbnailWebP is the env-free core of the subcommand.
func thumbnailWebP(ctx context.Context, attachments []*model.Attachment, reencode thumbnailReencoder, dryRun, verbose bool, mode string) int {
	var scanned, rewritten, skipped, errCount int
	for _, a := range attachments {
		for _, key := range []string{a.ThumbnailS3Key, a.SquareThumbnailS3Key} {
			if key == "" {
				continue
			}
			scanned++
			changed, err := reencode(ctx, key, dryRun)
			if err != nil {
				slog.Warn("re-encode thumbnail failed", "attachmentID", a.ID, "key", key, "error", err)
				errCount++
				continue
			}
			if !changed {
				skipped++
				continue
			}
			if verbose {
				slog.Info("re-encode thumbnail", "attachmentID", a.ID, "key", key)
			}
			rewritten++
		}
	}
	slog.Info("thumbnail-webp complete", "mode", mode, "thumbnails", scanned, "rewritten", rewritten, "skipped", skipped, "errors", errCount)
	if errCount > 0 {
		return 1
	}
	return 0
}
