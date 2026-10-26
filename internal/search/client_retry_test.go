package search

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// bulkCluster fakes the _bulk endpoint: respond builds each response from
// the 1-based request number and the document IDs that request carried.
type bulkCluster struct {
	mu       sync.Mutex
	requests [][]string // document IDs per request
	bodies   []string   // raw body per request
	respond  func(n int, ids []string) string
	// throttle, when set and non-empty for a request, answers that whole
	// request with 429 and this body instead.
	throttle func(n int) string
}

func (b *bulkCluster) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_bulk" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var ids []string
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if _, rest, ok := strings.Cut(line, `"_id":"`); ok {
				id, _, _ := strings.Cut(rest, `"`)
				ids = append(ids, id)
			}
		}
		b.mu.Lock()
		b.requests = append(b.requests, ids)
		b.bodies = append(b.bodies, string(raw))
		n := len(b.requests)
		b.mu.Unlock()
		if b.throttle != nil {
			if body := b.throttle(n); body != "" {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(body))
				return
			}
		}
		_, _ = w.Write([]byte(b.respond(n, ids)))
	}
}

func (b *bulkCluster) calls() [][]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([][]string(nil), b.requests...)
}

func (b *bulkCluster) rawBodies() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.bodies...)
}

// bulkResponse renders a _bulk response; status maps a document ID to its
// item status (default 201), reason gives a failed item's error reason.
func bulkResponse(ids []string, status func(id string) int) string {
	items := make([]string, 0, len(ids))
	failed := false
	for _, id := range ids {
		st := status(id)
		switch {
		case st == http.StatusTooManyRequests:
			failed = true
			items = append(items, fmt.Sprintf(`{"index":{"_id":%q,"status":429,"error":{"type":"es_rejected_execution_exception","reason":"write queue full"}}}`, id))
		case st >= 300:
			failed = true
			items = append(items, fmt.Sprintf(`{"index":{"_id":%q,"status":%d,"error":{"type":"mapper_parsing_exception","reason":"failed to parse field [createdAt] of %s"}}}`, id, st, id))
		default:
			items = append(items, fmt.Sprintf(`{"index":{"_id":%q,"status":201,"result":"created"}}`, id))
		}
	}
	return fmt.Sprintf(`{"took":1,"errors":%t,"items":[%s]}`, failed, strings.Join(items, ","))
}

func entriesFor(ids ...string) []BulkEntry {
	out := make([]BulkEntry, len(ids))
	for i, id := range ids {
		out[i] = BulkEntry{ID: id, Doc: map[string]any{"id": id}}
	}
	return out
}

// Regression: a failed bulk item used to surface as an opaque "per-item
// errors"; the error must name the document and the cluster's reason.
func TestClient_Bulk_ReportsTheRealItemError(t *testing.T) {
	b := &bulkCluster{respond: func(_ int, ids []string) string {
		return bulkResponse(ids, func(id string) int {
			if id == "m2" {
				return http.StatusBadRequest
			}
			return http.StatusCreated
		})
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()

	err := NewClient(srv.URL).Bulk(context.Background(), IndexMessages, entriesFor("m1", "m2"))
	if err == nil {
		t.Fatal("expected the failed item to surface")
	}
	for _, want := range []string{"1 of 2 items failed", "m2: status 400: mapper_parsing_exception: failed to parse field [createdAt] of m2"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}

// A thousand broken documents must not produce a thousand-line error: the
// count covers all of them, the detail only the first few.
func TestClient_Bulk_CapsReportedItemErrors(t *testing.T) {
	b := &bulkCluster{respond: func(_ int, ids []string) string {
		return bulkResponse(ids, func(string) int { return http.StatusBadRequest })
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()

	ids := []string{"d0", "d1", "d2", "d3", "d4", "d5", "d6"}
	err := NewClient(srv.URL).Bulk(context.Background(), IndexMessages, entriesFor(ids...))
	if err == nil || !strings.Contains(err.Error(), "7 of 7 items failed") {
		t.Fatalf("error = %v, want the full failure count", err)
	}
	if !strings.Contains(err.Error(), "d4: status 400") || strings.Contains(err.Error(), "d5:") {
		t.Errorf("error = %q, want detail for the first %d items only", err, bulkMaxReportedFailures)
	}
}

// An item can fail with a status but no error object; it still fails.
func TestClient_Bulk_ItemFailureWithoutErrorObject(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errors":true,"items":[{"index":{"_id":"x","status":500}}]}`))
	}))
	defer srv.Close()
	err := NewClient(srv.URL).Bulk(context.Background(), IndexUsers, entriesFor("x"))
	if err == nil || !strings.Contains(err.Error(), "x: status 500") {
		t.Fatalf("error = %v, want the bare item status", err)
	}
}

// Regression: items the cluster rejects with a per-item 429 (write queue
// full) are resubmitted — only those — instead of failing the whole batch.
func TestClient_Bulk_RetriesThrottledItems(t *testing.T) {
	noRetryDelay(t)
	b := &bulkCluster{respond: func(n int, ids []string) string {
		return bulkResponse(ids, func(id string) int {
			if n == 1 && id == "u2" {
				return http.StatusTooManyRequests
			}
			return http.StatusCreated
		})
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()

	if err := NewClient(srv.URL).Bulk(context.Background(), IndexUsers, entriesFor("u1", "u2", "u3")); err != nil {
		t.Fatalf("Bulk: %v", err)
	}
	calls := b.calls()
	if len(calls) != 2 || strings.Join(calls[0], ",") != "u1,u2,u3" || strings.Join(calls[1], ",") != "u2" {
		t.Fatalf("requests = %v, want the batch then only the throttled u2", calls)
	}
}

// Items that stay throttled give up once bulkRetryDelays are spent.
func TestClient_Bulk_ThrottledItemsGiveUp(t *testing.T) {
	noRetryDelay(t)
	b := &bulkCluster{respond: func(_ int, ids []string) string {
		return bulkResponse(ids, func(string) int { return http.StatusTooManyRequests })
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()

	err := NewClient(srv.URL).Bulk(context.Background(), IndexUsers, entriesFor("u1"))
	if err == nil || !strings.Contains(err.Error(), "429") {
		t.Fatalf("error = %v, want the throttling to surface", err)
	}
	if got, want := len(b.calls()), len(bulkRetryDelays)+1; got != want {
		t.Fatalf("requests = %d, want %d attempts", got, want)
	}
}

// The wait between throttled rounds honours the caller's context.
func TestClient_Bulk_BackoffHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	orig := sleepCtx
	t.Cleanup(func() { sleepCtx = orig })
	sleepCtx = func(ctx context.Context, _ time.Duration) error {
		cancel() // the caller gives up while we wait
		return orig(ctx, time.Hour)
	}
	b := &bulkCluster{respond: func(_ int, ids []string) string {
		return bulkResponse(ids, func(string) int { return http.StatusTooManyRequests })
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()

	err := NewClient(srv.URL).Bulk(ctx, IndexUsers, entriesFor("u1"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if got := len(b.calls()); got != 1 {
		t.Fatalf("requests = %d, want 1 (no retry after cancellation)", got)
	}
}

// A caller that already gave up gets its context error, not a write.
func TestClient_Bulk_CancelledContext(t *testing.T) {
	b := &bulkCluster{respond: func(_ int, ids []string) string {
		return bulkResponse(ids, func(string) int { return http.StatusCreated })
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := NewClient(srv.URL).Bulk(ctx, IndexUsers, entriesFor("u1", "u2")); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

// Regression: a request the cluster answers with 429 (or 502/503/504) is
// retried by the transport instead of failing the search outright.
func TestClient_RetriesThrottledRequest(t *testing.T) {
	noRetryDelay(t)
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"type":"too_many_requests","reason":"slow down"},"status":429}`))
			return
		}
		_, _ = w.Write([]byte(`{"hits":{"total":{"value":1},"hits":[{"_id":"u-1","_score":1,"_source":{"id":"u-1"}}]}}`))
	}))
	defer srv.Close()

	res, err := NewClient(srv.URL).Search(context.Background(), IndexUsers, map[string]any{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if res.Total != 1 || calls != 2 {
		t.Fatalf("total=%d after %d requests, want 1 after a retried 429", res.Total, calls)
	}
}

// The production backoff grows exponentially, is capped, and is jittered
// within [d/2, d).
func TestRetryBackoff_ExponentialCappedJittered(t *testing.T) {
	for attempt := 1; attempt <= 8; attempt++ {
		d := min(retryBackoffBase<<(attempt-1), retryBackoffMax)
		for range 20 {
			got := retryBackoff(attempt)
			if got < d/2 || got >= d {
				t.Fatalf("retryBackoff(%d) = %v, want within [%v, %v)", attempt, got, d/2, d)
			}
		}
	}
}
