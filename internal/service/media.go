package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/store"
	"encoding/json"
)

// MediaURLCache is the Redis-shaped cache used to map stable browser media
// URLs to object storage keys. It is deliberately not durable application
// data: if it expires, the next metadata fetch issues a new stable URL.
type MediaURLCache interface {
	Get(ctx context.Context, key string, dest interface{}) error
	Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error
}

type MediaObjectStore interface {
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
}

type mediaRecord struct {
	Token       string `json:"token"`
	S3Key       string `json:"s3Key"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

const mediaURLTTL = 30 * 24 * time.Hour

func StableMediaURL(ctx context.Context, c MediaURLCache, namespace, id, s3Key, filename, contentType string, size int64) (string, error) {
	if c == nil {
		return "", errors.New("media cache not configured")
	}
	recordKey := "media:" + namespace + ":" + id
	var rec mediaRecord
	if err := c.Get(ctx, recordKey, &rec); err == nil && rec.Token != "" {
		return mediaPath(rec.Token, rec.Filename), nil
	}
	token, err := randomMediaToken()
	if err != nil {
		return "", err
	}
	rec = mediaRecord{
		Token:       token,
		S3Key:       s3Key,
		Filename:    filename,
		ContentType: contentType,
		Size:        size,
	}
	if err := c.Set(ctx, "media:token:"+token, rec, mediaURLTTL); err != nil {
		return "", err
	}
	if err := c.Set(ctx, recordKey, rec, mediaURLTTL); err != nil {
		return "", err
	}
	return mediaPath(token, filename), nil
}

func mediaPath(token, filename string) string {
	return "/api/v1/media/" + url.PathEscape(token) + "/" + url.PathEscape(filename)
}

func randomMediaToken() (string, error) {
	var b [24]byte
	if _, err := randRead(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

type MediaObject struct {
	Body         io.ReadCloser
	ContentType  string
	Filename     string
	Size         int64
	LastModified time.Time
}

func OpenStableMedia(ctx context.Context, c MediaURLCache, objects MediaObjectStore, token string) (*MediaObject, error) {
	if c == nil || objects == nil {
		return nil, store.ErrNotFound
	}
	var rec mediaRecord
	if err := c.Get(ctx, "media:token:"+token, &rec); err != nil {
		if errors.Is(err, cache.ErrCacheMiss) {
			return nil, store.ErrNotFound
		}
		return nil, fmt.Errorf("media: token: %w", err)
	}
	body, contentType, size, lastModified, err := objects.GetObject(ctx, rec.S3Key)
	if err != nil {
		return nil, fmt.Errorf("media: object: %w", err)
	}
	if contentType == "" {
		contentType = rec.ContentType
	}
	if size <= 0 {
		size = rec.Size
	}
	return &MediaObject{
		Body:         body,
		ContentType:  contentType,
		Filename:     rec.Filename,
		Size:         size,
		LastModified: lastModified,
	}, nil
}

// MediaURLBatchCache is the optional batching capability of a MediaURLCache
// (implemented by the Redis cache). Callers type-assert it and fall back to
// per-item Get/Set when absent, mirroring the batchUserStore pattern.
type MediaURLBatchCache interface {
	GetManyJSON(ctx context.Context, keys []string) ([][]byte, error)
	SetManyJSON(ctx context.Context, keys []string, values []any, ttl time.Duration) error
}

// MediaURLRequest is one item for StableMediaURLs.
type MediaURLRequest struct {
	ID          string
	S3Key       string
	Filename    string
	ContentType string
	Size        int64
}

// StableMediaURLs resolves many stable media URLs at once: one MGET for the
// existing records and one pipelined write for the misses' token+record rows
// — instead of the 1..3 Redis round trips PER item that made avatar
// resolution dominate /users/batch and /conversations. Falls back to the
// per-item path when the cache doesn't batch. Per-item failures drop that
// entry (same best-effort contract as StableMediaURL callers).
func StableMediaURLs(ctx context.Context, c MediaURLCache, namespace string, reqs []MediaURLRequest) map[string]string {
	out := make(map[string]string, len(reqs))
	if c == nil || len(reqs) == 0 {
		return out
	}
	bc, ok := c.(MediaURLBatchCache)
	if !ok {
		for _, r := range reqs {
			if u, err := StableMediaURL(ctx, c, namespace, r.ID, r.S3Key, r.Filename, r.ContentType, r.Size); err == nil {
				out[r.ID] = u
			}
		}
		return out
	}

	keys := make([]string, len(reqs))
	for i, r := range reqs {
		keys[i] = "media:" + namespace + ":" + r.ID
	}
	vals, err := bc.GetManyJSON(ctx, keys)
	if err != nil {
		return out // cache down: URLs are cosmetic, callers tolerate absence
	}
	var missKeys []string
	var missValues []any
	var minted []string // request IDs whose URLs depend on the pipelined write
	for i, raw := range vals {
		if raw != nil {
			var rec mediaRecord
			if err := json.Unmarshal(raw, &rec); err == nil && rec.Token != "" {
				out[reqs[i].ID] = mediaPath(rec.Token, rec.Filename)
				continue
			}
		}
		token, err := randomMediaToken()
		if err != nil {
			continue
		}
		rec := mediaRecord{
			Token:       token,
			S3Key:       reqs[i].S3Key,
			Filename:    reqs[i].Filename,
			ContentType: reqs[i].ContentType,
			Size:        reqs[i].Size,
		}
		missKeys = append(missKeys, "media:token:"+token, keys[i])
		missValues = append(missValues, rec, rec)
		minted = append(minted, reqs[i].ID)
		out[reqs[i].ID] = mediaPath(token, rec.Filename)
	}
	if len(missKeys) > 0 {
		if err := bc.SetManyJSON(ctx, missKeys, missValues, mediaURLTTL); err != nil {
			// The tokens never persisted → the URLs we just minted would 404.
			// Drop those entries; the next fetch re-mints.
			for _, id := range minted {
				delete(out, id)
			}
		}
	}
	return out
}
