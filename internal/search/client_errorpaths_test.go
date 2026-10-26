package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// noRetryDelay drops the retry backoff for one test, so driving the
// transport's retry path (connection errors, 429/5xx) costs no wall-clock
// time. Tests in this package never run in parallel.
func noRetryDelay(t *testing.T) {
	t.Helper()
	orig, origBulk := retryBackoff, bulkRetryDelays
	t.Cleanup(func() { retryBackoff, bulkRetryDelays = orig, origBulk })
	retryBackoff = func(int) time.Duration { return 0 }
	bulkRetryDelays = make([]time.Duration, len(origBulk))
}

// unreachable points the client at a closed port so every request fails
// at the transport layer (after the transport's retries), exercising each
// method's request-error branch.
func TestClient_Unreachable_AllMethods(t *testing.T) {
	noRetryDelay(t)
	c := NewClient("http://127.0.0.1:1")
	ctx := context.Background()

	if _, err := c.indexExists(ctx, "idx"); err == nil {
		t.Error("indexExists: expected error")
	}
	if _, err := c.GetDoc(ctx, "idx", "id"); err == nil {
		t.Error("GetDoc: expected error")
	}
	if err := c.IndexDoc(ctx, "idx", "id", map[string]any{"x": 1}); err == nil {
		t.Error("IndexDoc: expected error")
	}
	if err := c.DeleteDoc(ctx, "idx", "id"); err == nil {
		t.Error("DeleteDoc: expected error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected error")
	}
	if _, err := c.ClusterHealth(ctx); err == nil {
		t.Error("ClusterHealth: expected error")
	}
	if err := c.deleteIndex(ctx, "idx"); err == nil {
		t.Error("deleteIndex: expected error")
	}
}

// decodeError returns 200 with a non-JSON body so the response-decode
// branch of the read methods is exercised.
func TestClient_DecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{not json"))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	ctx := context.Background()

	if _, err := c.GetDoc(ctx, "idx", "id"); err == nil {
		t.Error("GetDoc: expected decode error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected decode error")
	}
	if _, err := c.ClusterHealth(ctx); err == nil {
		t.Error("ClusterHealth: expected decode error")
	}
}

// serverError returns 500 so the unexpected-status branches fire.
func TestClient_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	ctx := context.Background()

	if err := c.IndexDoc(ctx, "idx", "id", map[string]any{"x": 1}); err == nil {
		t.Error("IndexDoc: expected status error")
	}
	if err := c.DeleteDoc(ctx, "idx", "id"); err == nil {
		t.Error("DeleteDoc: expected status error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected status error")
	}
	if err := c.deleteIndex(ctx, "idx"); err == nil {
		t.Error("deleteIndex: expected status error")
	}
}
