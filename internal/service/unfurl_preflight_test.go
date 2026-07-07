package service

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The pre-flight target check turns "user pasted an intranet link" from a
// recurring APM error (dial failure inside the traced HTTP client) into a
// quiet WARN + skipped preview: no outbound request may even start.

func TestPreflightPublicTarget(t *testing.T) {
	ctx := context.Background()

	t.Run("private-resolving host is blocked", func(t *testing.T) {
		// localhost deterministically resolves to loopback everywhere.
		err := preflightPublicTarget(ctx, "https://localhost/internal/page")
		if err == nil || !strings.Contains(err.Error(), "blocked private IP") {
			t.Fatalf("err = %v, want blocked private IP", err)
		}
	})

	t.Run("unresolvable host surfaces a resolve error", func(t *testing.T) {
		// RFC 2606 reserves .invalid — it never resolves.
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		err := preflightPublicTarget(ctx, "https://nope.invalid/x")
		if err == nil || !strings.Contains(err.Error(), "resolve") {
			t.Fatalf("err = %v, want resolve error", err)
		}
	})

	t.Run("public target passes", func(t *testing.T) {
		// TEST-NET-3 is classified public by isPublicIP, and an IP-literal
		// host resolves without touching the network — deterministic.
		if err := preflightPublicTarget(ctx, "https://203.0.113.5/page"); err != nil {
			t.Fatalf("public target must pass pre-flight, got %v", err)
		}
	})

	t.Run("unparsable url is rejected", func(t *testing.T) {
		if err := preflightPublicTarget(ctx, "http://%zz"); err == nil {
			t.Fatal("expected parse error")
		}
	})
}

func TestUnfurlPreflightBlocksBeforeAnyRequest(t *testing.T) {
	// Production-shaped service (validation ON). The transport panics if any
	// request escapes — proving the private target is rejected pre-flight,
	// with no HTTP client span for APM to error-tag.
	svc := NewUnfurlService(newMockCache())
	svc.client = &http.Client{
		Transport: panickyTransport{},
		Timeout:   time.Second,
	}
	_, err := svc.fetchAndScrape(context.Background(), "https://localhost/internal")
	if err == nil || !strings.Contains(err.Error(), "blocked private IP") {
		t.Fatalf("err = %v, want blocked private IP", err)
	}
}

func TestUnfurlPreflightSkippedOnCacheHit(t *testing.T) {
	// A cached preview must serve WITHOUT paying a DNS lookup or any request.
	cache := newMockCache()
	svc := NewUnfurlService(cache)
	svc.client = &http.Client{Transport: panickyTransport{}, Timeout: time.Second}
	cached := &UnfurlPreview{URL: "https://localhost/cached", Title: "Cached"}
	if err := cache.Set(context.Background(), "unfurl:https://localhost/cached", cached, time.Hour); err != nil {
		t.Fatalf("seed cache: %v", err)
	}
	got, err := svc.fetchAndScrape(context.Background(), "https://localhost/cached")
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Title != "Cached" {
		t.Fatalf("Title = %q, want cached preview", got.Title)
	}
}

type panickyTransport struct{}

func (panickyTransport) RoundTrip(*http.Request) (*http.Response, error) {
	panic("no HTTP request may be issued for a pre-flight-blocked target")
}
