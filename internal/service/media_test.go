package service

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/store"
)

type fakeMediaObjectStore struct {
	contentType  string
	size         int64
	lastModified time.Time
	err          error
}

func (s fakeMediaObjectStore) GetObject(_ context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	if s.err != nil {
		return nil, "", 0, time.Time{}, s.err
	}
	return io.NopCloser(strings.NewReader("body:" + key)), s.contentType, s.size, s.lastModified, nil
}

func TestStableMediaURLAndOpenStableMedia(t *testing.T) {
	ctx := context.Background()
	mediaCache := newFakeMediaCache()

	url1, err := StableMediaURL(ctx, mediaCache, "attachment", "a1", "attachments/a1", "cat pic.png", "image/png", 123)
	if err != nil {
		t.Fatalf("StableMediaURL first: %v", err)
	}
	url2, err := StableMediaURL(ctx, mediaCache, "attachment", "a1", "attachments/a1", "cat pic.png", "image/png", 123)
	if err != nil {
		t.Fatalf("StableMediaURL second: %v", err)
	}
	if url1 == "" || url1 != url2 {
		t.Fatalf("stable URLs = %q and %q, want identical non-empty", url1, url2)
	}

	parts := strings.Split(url1, "/")
	token := parts[len(parts)-2]
	lastModified := time.Now().Truncate(time.Millisecond)
	media, err := OpenStableMedia(ctx, mediaCache, fakeMediaObjectStore{lastModified: lastModified}, token)
	if err != nil {
		t.Fatalf("OpenStableMedia: %v", err)
	}
	defer func() { _ = media.Body.Close() }()
	if media.ContentType != "image/png" || media.Size != 123 || media.Filename != "cat pic.png" || !media.LastModified.Equal(lastModified) {
		t.Fatalf("media metadata = %+v, want cached fallbacks", media)
	}
}

func TestStableMediaURLAndOpenStableMediaErrors(t *testing.T) {
	ctx := context.Background()
	if _, err := StableMediaURL(ctx, nil, "attachment", "a1", "key", "file", "", 0); err == nil {
		t.Fatal("expected nil cache error")
	}
	if _, err := OpenStableMedia(ctx, nil, fakeMediaObjectStore{}, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("nil cache OpenStableMedia err = %v, want ErrNotFound", err)
	}

	mediaCache := newFakeMediaCache()
	if _, err := OpenStableMedia(ctx, mediaCache, fakeMediaObjectStore{}, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing token err = %v, want ErrNotFound", err)
	}

	mediaCache.items["media:token:bad-cache"] = "not-a-record"
	if _, err := OpenStableMedia(ctx, mediaCache, fakeMediaObjectStore{}, "bad-cache"); err == nil {
		t.Fatalf("bad cache err = %v, want wrapped cache decode error", err)
	}

	mediaCache.items["media:token:object-fails"] = mediaRecord{Token: "object-fails", S3Key: "missing-object"}
	if _, err := OpenStableMedia(ctx, mediaCache, fakeMediaObjectStore{err: errors.New("s3 down")}, "object-fails"); err == nil {
		t.Fatal("expected object load error")
	}
}
