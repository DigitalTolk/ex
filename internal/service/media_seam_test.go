package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

// setNthErrCache fails the Nth call to Set (1-based), succeeding otherwise.
type setNthErrCache struct {
	*mockCache
	failOn int
	calls  int
}

func (c *setNthErrCache) Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error {
	c.calls++
	if c.calls == c.failOn {
		return errors.New("boom")
	}
	return c.mockCache.Set(ctx, key, val, ttl)
}

func TestStableMediaURL_SecondSetError(t *testing.T) {
	c := &setNthErrCache{mockCache: newMockCache(), failOn: 2}
	if _, err := StableMediaURL(context.Background(), c, "ns", "id", "key", "f.png", "image/png", 1); err == nil {
		t.Fatal("expected error when second cache Set fails")
	}
}

func TestRandomMediaToken_ReadError(t *testing.T) {
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { randRead = orig }()

	c := newMockCache()
	if _, err := StableMediaURL(context.Background(), c, "ns", "id", "key", "f.png", "image/png", 1); err == nil {
		t.Fatal("expected error when randRead fails")
	}
}
