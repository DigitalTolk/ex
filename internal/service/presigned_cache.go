package service

import (
	"context"
	"sync"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
	"golang.org/x/sync/singleflight"
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
//
// Concurrent misses for one variant share a single sign, and variants are
// indexed by S3 key so invalidate touches only that key's entries.
type presignedURLCache struct {
	urls  *expirable.LRU[presignedKey, string]
	signs singleflight.Group

	// mu guards variants: S3 key → its cached variants. Lock order is the
	// LRU's lock, then mu (the LRU calls forget holding its own), so nothing
	// here calls into urls while holding mu.
	mu       sync.Mutex
	variants map[string]map[presignedKey]struct{}
}

// presignedCacheMaxSize bounds the in-memory cache so a long-running
// process doesn't accumulate dead entries. Sized for a typical workspace's
// avatar + attachment + emoji set; the least recently used entry is evicted
// when full, and expired entries are swept in the background.
const presignedCacheMaxSize = 10000

type presignedKey struct {
	op  string // "get" / "download" — separate variants per S3 key
	key string
	// extra distinguishes presigned-download URLs by filename so two
	// attachments sharing one object key (dedup) but rendered with
	// different filenames don't collide.
	extra string
}

// flightKey is k as a singleflight key; NUL never appears in an S3 key, an op
// or a filename header value, so distinct variants never share a flight.
func (k presignedKey) flightKey() string {
	return k.op + "\x00" + k.key + "\x00" + k.extra
}

func newPresignedURLCache(ttl time.Duration) *presignedURLCache {
	return newSizedPresignedURLCache(presignedCacheMaxSize, presignedTTL(ttl))
}

// presignedTTL clamps a requested entry lifetime to presignedURLCacheTTL,
// which is also the default for a non-positive request.
func presignedTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 || ttl > presignedURLCacheTTL {
		return presignedURLCacheTTL
	}
	return ttl
}

// newSizedPresignedURLCache builds a cache of at most size entries living
// ttl each (0: no expiry — tests only).
func newSizedPresignedURLCache(size int, ttl time.Duration) *presignedURLCache {
	c := &presignedURLCache{variants: map[string]map[presignedKey]struct{}{}}
	c.urls = expirable.NewLRU(size, c.forget, ttl)
	return c
}

// getOrSign returns a cached URL for k or calls sign and stores its
// result. ttl on the entry is short enough that the underlying presigned
// URL is still valid when handed out; sign is responsible for asking
// the signer for a long-lived URL.
//
// Concurrent misses for k wait on one sign. It runs detached from the first
// caller's cancellation so that caller giving up can't fail the others;
// presigning is local work bounded by the SDK's own credential timeouts.
func (c *presignedURLCache) getOrSign(ctx context.Context, k presignedKey, sign func(context.Context) (string, error)) (string, error) {
	if c == nil {
		return sign(ctx)
	}
	if url, ok := c.urls.Get(k); ok {
		return url, nil
	}
	url, err, _ := c.signs.Do(k.flightKey(), func() (any, error) {
		url, err := sign(context.WithoutCancel(ctx))
		if err != nil {
			return "", err
		}
		c.urls.Add(k, url)
		c.mu.Lock()
		set := c.variants[k.key]
		if set == nil {
			set = map[presignedKey]struct{}{}
			c.variants[k.key] = set
		}
		set[k] = struct{}{}
		c.mu.Unlock()
		return url, nil
	})
	if err != nil {
		return "", err
	}
	return url.(string), nil
}

// forget drops an evicted or removed entry from the variant index. The LRU
// calls it holding its own lock.
func (c *presignedURLCache) forget(k presignedKey, _ string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.variants[k.key], k)
	if len(c.variants[k.key]) == 0 {
		delete(c.variants, k.key)
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
	set := c.variants[key]
	delete(c.variants, key)
	c.mu.Unlock()
	for k := range set {
		c.urls.Remove(k)
	}
}
