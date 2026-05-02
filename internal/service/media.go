package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/store"
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
	if _, err := rand.Read(b[:]); err != nil {
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
