package service

import (
	"context"
	"errors"
	"testing"
)

func TestStableMediaURL_NilCache(t *testing.T) {
	if _, err := StableMediaURL(context.Background(), nil, "ns", "id", "key", "f.png", "image/png", 1); err == nil {
		t.Fatal("expected error for nil cache")
	}
}

func TestStableMediaURL_SetError(t *testing.T) {
	c := newMockCache()
	c.setErr = errors.New("boom")
	if _, err := StableMediaURL(context.Background(), c, "ns", "id", "key", "f.png", "image/png", 1); err == nil {
		t.Fatal("expected error when cache Set fails")
	}
}

func TestOpenStableMedia_NilDeps(t *testing.T) {
	if _, err := OpenStableMedia(context.Background(), nil, nil, "tok"); err == nil {
		t.Fatal("expected error/not-found for nil deps")
	}
}
