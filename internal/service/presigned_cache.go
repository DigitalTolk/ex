package service

import (
	"context"
	"sync"
	"time"
)

// presignedURLCacheTTL is intentionally short. Presigned URLs can include
// temporary AWS session tokens whose lifetime may be shorter than the requested
// X-Amz-Expires value; caching signed URLs for hours can keep serving an
// already-expired security token. A few minutes still dedupes hot render loops
// without outliving normal credential refresh windows.
const presignedURLCacheTTL = 5 * time.Minute

// presignedURLCache memoises presigned GET URLs by their underlying S3 key
// for a TTL window. Without it every avatar / attachment / emoji fetch
// generated a fresh URL on each request — the URL changes (signing date
// is part of the query string) so the browser would treat each as a new
// resource and re-download the bytes from S3 instead of reusing its
// cached image. We hand the same URL back for the duration of the TTL
// so the browser cache key stays stable and image traffic drops to ~zero.
//
// The cache window is intentionally shorter than the presigned URL's own
// expiry so a cached URL is always still valid when re-issued. Because
// the URL is keyed by the S3 object key (and presigned URLs are scoped
// to a single object), cache reuse across users is correct: every user
// who can see a given object would have been issued an equivalent URL.
type presignedURLCache struct {
	ttl     time.Duration
	maxSize int
	mu      sync.Mutex
	items   map[presignedKey]presignedEntry
}

// presignedCacheMaxSize bounds the in-memory cache so a long-running
// process doesn't accumulate dead entries — with a 20h TTL and no
// eviction every distinct S3 key seen in 20h would otherwise sit in
// memory permanently. Sized for a typical workspace's avatar +
// attachment + emoji set; the eldest entry is evicted FIFO when full.
const presignedCacheMaxSize = 10000

type presignedKey struct {
	op  string // "get" / "download" — separate variants per S3 key
	key string
	// extra distinguishes presigned-download URLs by filename so two
	// attachments sharing one object key (dedup) but rendered with
	// different filenames don't collide.
	extra string
}

type presignedEntry struct {
	url       string
	expiresAt time.Time
}

func newPresignedURLCache(ttl time.Duration) *presignedURLCache {
	if ttl <= 0 || ttl > presignedURLCacheTTL {
		ttl = presignedURLCacheTTL
	}
	return &presignedURLCache{ttl: ttl, maxSize: presignedCacheMaxSize, items: map[presignedKey]presignedEntry{}}
}

// getOrSign returns a cached URL for k or calls sign and stores its
// result. ttl on the entry is short enough that the underlying presigned
// URL is still valid when handed out; sign is responsible for asking
// the signer for a long-lived URL.
func (c *presignedURLCache) getOrSign(ctx context.Context, k presignedKey, sign func(context.Context) (string, error)) (string, error) {
	if c == nil {
		return sign(ctx)
	}
	now := time.Now()
	c.mu.Lock()
	if e, ok := c.items[k]; ok {
		if e.expiresAt.After(now) {
			c.mu.Unlock()
			return e.url, nil
		}
		// Expired — drop in place so map size reflects live entries.
		delete(c.items, k)
	}
	c.mu.Unlock()
	// Sign outside the lock so concurrent misses for different keys
	// don't serialize on the network call.
	url, err := sign(ctx)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	if c.maxSize > 0 && len(c.items) >= c.maxSize {
		c.evictOneLocked(now)
	}
	c.items[k] = presignedEntry{url: url, expiresAt: now.Add(c.ttl)}
	c.mu.Unlock()
	return url, nil
}

// evictOneLocked drops one entry to make room for a new write. Prefers
// any expired entry (a single linear pass through the map); if none is
// expired it drops an arbitrary entry — Go map iteration order is
// randomised so this is a fair-ish eviction without per-entry LRU
// bookkeeping. Caller holds c.mu.
func (c *presignedURLCache) evictOneLocked(now time.Time) {
	for k, e := range c.items {
		if !e.expiresAt.After(now) {
			delete(c.items, k)
			return
		}
	}
	for k := range c.items {
		delete(c.items, k)
		return
	}
}

// invalidate drops any cached URL for the given S3 key (all variants).
// Call when the underlying object has been deleted/replaced so a stale
// (but still presigned-valid) URL doesn't keep getting handed out.
func (c *presignedURLCache) invalidate(key string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.items {
		if k.key == key {
			delete(c.items, k)
		}
	}
}
