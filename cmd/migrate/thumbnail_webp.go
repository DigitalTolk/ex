package main

import (
	"context"
	"flag"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/sync/errgroup"
)

// twWorkers is how many thumbnails are checked and rewritten at once by
// default: each is a round trip to S3, and from a laptop those are long.
const twWorkers = 16

// thumbnailRun is how a thumbnail-webp run goes.
type thumbnailRun struct {
	dryRun, verbose bool
	mode            string
	workers         int
	progressEvery   time.Duration
}

// thumbnailReencoder is service.ReencodeThumbnail bound to an object store.
type thumbnailReencoder func(ctx context.Context, key string, dryRun bool) (bool, error)

// runThumbnailWebP rewrites the message thumbnails written as lossless WebP
// (before thumbnails were lossy) as lossy WebP, in place: same keys, same
// pictures, a fraction of the bytes.
//
// S3-only apart from listing the attachments. Idempotent: a thumbnail that is
// already lossy is skipped.
func runThumbnailWebP(ctx context.Context, db *store.DB, args []string) int {
	workers := twWorkers
	dryRun, verbose, mode := migrateFlags("thumbnail-webp", args, func(fs *flag.FlagSet) {
		fs.IntVar(&workers, "workers", twWorkers, "thumbnails processed at once")
	})

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
	reencode := func(ctx context.Context, key string, dryRun bool) (bool, error) {
		return service.ReencodeThumbnail(ctx, s3Client, key, dryRun)
	}
	return thumbnailWebP(ctx, attachments, reencode, thumbnailRun{
		dryRun: dryRun, verbose: verbose, mode: mode, workers: max(workers, 1), progressEvery: progressEvery,
	})
}

// thumbnailWebP is the env-free core of the subcommand: it checks every
// thumbnail key of every attachment, run.workers at a time, logging progress
// every run.progressEvery.
func thumbnailWebP(ctx context.Context, attachments []*model.Attachment, reencode thumbnailReencoder, run thumbnailRun) int {
	type thumbnail struct{ attachmentID, key string }
	var thumbnails []thumbnail
	for _, a := range attachments {
		for _, key := range []string{a.ThumbnailS3Key, a.SquareThumbnailS3Key} {
			if key != "" {
				thumbnails = append(thumbnails, thumbnail{a.ID, key})
			}
		}
	}
	slog.Info("starting thumbnail-webp", "mode", run.mode, "attachments", len(attachments), "thumbnails", len(thumbnails), "workers", run.workers)

	p := newProgress("thumbnail-webp", len(thumbnails))
	stop := p.report(run.progressEvery)
	var skipped atomic.Int64
	var g errgroup.Group
	g.SetLimit(run.workers)
	for _, th := range thumbnails {
		g.Go(func() error {
			defer p.done.Add(1)
			changed, err := reencode(ctx, th.key, run.dryRun)
			switch {
			case err != nil:
				slog.Warn("re-encode thumbnail failed", "attachmentID", th.attachmentID, "key", th.key, "error", err)
				p.failed.Add(1)
			case !changed:
				skipped.Add(1)
			default:
				if run.verbose {
					slog.Info("re-encode thumbnail", "attachmentID", th.attachmentID, "key", th.key)
				}
				p.changed.Add(1)
			}
			return nil
		})
	}
	_ = g.Wait()
	stop()

	slog.Info("thumbnail-webp complete", "mode", run.mode, "thumbnails", len(thumbnails), "rewritten", p.changed.Load(),
		"skipped", skipped.Load(), "errors", p.failed.Load(), "took", time.Since(p.start).Round(time.Second).String())
	if p.failed.Load() > 0 {
		return 1
	}
	return 0
}
