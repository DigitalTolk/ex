package search

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClient_Search_DecodesAggregationBuckets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"hits": {"total": {"value": 0}, "hits": []},
			"aggregations": {
				"byUser":   {"buckets": [{"key": "u-1", "doc_count": 12}, {"key": "u-2", "doc_count": 3}]},
				"byParent": {"buckets": [{"key": "ch-1", "doc_count": 5}]}
			}
		}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	res, err := c.Search(context.Background(), "ex_messages", map[string]any{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if res.Aggs == nil {
		t.Fatal("expected aggs in result")
	}
	if len(res.Aggs["byUser"]) != 2 || res.Aggs["byUser"][0].Key != "u-1" || res.Aggs["byUser"][0].Count != 12 {
		t.Errorf("byUser buckets = %+v", res.Aggs["byUser"])
	}
	if len(res.Aggs["byParent"]) != 1 || res.Aggs["byParent"][0].Key != "ch-1" {
		t.Errorf("byParent buckets = %+v", res.Aggs["byParent"])
	}
}

func TestClient_GetDoc_PropagatesUnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.GetDoc(context.Background(), "ex_files", "any"); err == nil {
		t.Fatal("expected error for non-2xx response")
	}
}

func TestClient_GetDoc_NilClient(t *testing.T) {
	var c *Client
	got, err := c.GetDoc(context.Background(), "ex_files", "x")
	if err != nil || got != nil {
		t.Errorf("nil client must yield (nil, nil), got (%v, %v)", got, err)
	}
}

func TestClient_GetDoc_ReturnsSourceOrNil(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ex_files/_doc/a-1":
			_, _ = w.Write([]byte(`{"_source":{"id":"a-1","filename":"design.pdf","parentIds":["ch-1"]}}`))
		case "/ex_files/_doc/missing":
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)

	got, err := c.GetDoc(context.Background(), "ex_files", "a-1")
	if err != nil {
		t.Fatalf("GetDoc(a-1): %v", err)
	}
	if got["filename"] != "design.pdf" {
		t.Errorf("filename = %v", got["filename"])
	}

	missing, err := c.GetDoc(context.Background(), "ex_files", "missing")
	if err != nil {
		t.Fatalf("GetDoc(missing): %v", err)
	}
	if missing != nil {
		t.Errorf("missing doc should return nil map, got %v", missing)
	}
}

func TestNewClient_EmptyURL(t *testing.T) {
	if NewClient("") != nil {
		t.Fatal("NewClient(\"\") should return nil so callers can opt out of search")
	}
	if NewClient("   ") != nil {
		t.Fatal("NewClient with whitespace-only URL should return nil")
	}
}

// A trailing slash on the configured URL must not leak into request paths
// ("//ex_users/_doc/u-1" is a different route).
func TestNewClient_TrimsTrailingSlash(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	c := NewClient(srv.URL + "/")
	if err := c.IndexDoc(context.Background(), IndexUsers, "u-1", map[string]any{"id": "u-1"}); err != nil {
		t.Fatalf("IndexDoc: %v", err)
	}
	if gotPath != "/"+IndexUsers+"/_doc/u-1" {
		t.Errorf("path = %q, want %q", gotPath, "/"+IndexUsers+"/_doc/u-1")
	}
}

// A nil client (search not configured) is a no-op everywhere, including
// index setup at boot.
func TestClient_EnsureIndices_NilClientIsNoop(t *testing.T) {
	var c *Client
	if err := c.EnsureIndices(context.Background()); err != nil {
		t.Fatalf("nil-client EnsureIndices = %v, want nil", err)
	}
}

func TestClient_EnsureIndices_CreatesMissing(t *testing.T) {
	created := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodHead:
			// Pretend none of the indices exist yet.
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			created[r.URL.Path[1:]] = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected method %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.EnsureIndices(context.Background()); err != nil {
		t.Fatalf("EnsureIndices: %v", err)
	}
	for name := range indexMappings {
		if !created[name] {
			t.Errorf("EnsureIndices did not create %q", name)
		}
	}
}

func TestClient_EnsureIndices_SkipsExisting(t *testing.T) {
	var puts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodHead:
			w.WriteHeader(http.StatusOK) // already exists
		case http.MethodPut:
			puts = append(puts, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.EnsureIndices(context.Background()); err != nil {
		t.Fatalf("EnsureIndices: %v", err)
	}
	// No index is created; only the messages settings and mapping updates are put.
	want := []string{"/" + IndexMessages + "/_settings", "/" + IndexMessages + "/_mapping"}
	if len(puts) != 2 || puts[0] != want[0] || puts[1] != want[1] {
		t.Errorf("PUTs = %v, want %v", puts, want)
	}
}

func TestClient_EnsureIndices_UpdateErrorsPropagate(t *testing.T) {
	for suffix, want := range map[string]string{"/_settings": "update settings", "/_mapping": "update mapping"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodHead || !strings.HasSuffix(r.URL.Path, suffix) {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusBadRequest)
		}))
		c := NewClient(srv.URL)
		if err := c.EnsureIndices(context.Background()); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: want %q error, got %v", suffix, want, err)
		}
		srv.Close()
	}
}

func TestClient_EnsureIndices_HEADErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.EnsureIndices(context.Background()); err == nil {
		t.Fatal("expected error from HEAD 500, got nil")
	}
}

func TestClient_IndexDoc_PUTsToCorrectURL(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.IndexDoc(context.Background(), IndexUsers, "u-1", map[string]any{"id": "u-1", "displayName": "Alice"}); err != nil {
		t.Fatalf("IndexDoc: %v", err)
	}
	if gotPath != "/"+IndexUsers+"/_doc/u-1" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["id"] != "u-1" {
		t.Errorf("body id = %v, want u-1", gotBody["id"])
	}
}

func TestClient_IndexDoc_NilClientIsNoop(t *testing.T) {
	var c *Client
	if err := c.IndexDoc(context.Background(), IndexUsers, "id", map[string]any{}); err != nil {
		t.Errorf("nil-client IndexDoc returned %v, want nil", err)
	}
}

func TestClient_DeleteDoc_404IsNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.DeleteDoc(context.Background(), IndexUsers, "missing"); err != nil {
		t.Errorf("DeleteDoc on 404: %v, want nil (idempotent delete)", err)
	}
}

func TestClient_DeleteDoc_500Errors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.DeleteDoc(context.Background(), IndexUsers, "x"); err == nil {
		t.Fatal("expected error from 500 delete")
	}
}

func TestClient_DeleteDoc_NilClientIsNoop(t *testing.T) {
	var c *Client
	if err := c.DeleteDoc(context.Background(), IndexUsers, "id"); err != nil {
		t.Errorf("nil-client DeleteDoc returned %v, want nil", err)
	}
}

func TestClient_Bulk_NoopOnEmpty(t *testing.T) {
	c := NewClient("http://unused.test")
	if err := c.Bulk(context.Background(), IndexUsers, nil); err != nil {
		t.Errorf("empty Bulk: %v", err)
	}
}

func TestClient_Bulk_ParsesPerItemErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		// 4 NDJSON lines = 2 entries.
		if strings.Count(string(body), "\n") != 4 {
			t.Errorf("bulk body line count = %d, want 4", strings.Count(string(body), "\n"))
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"errors":true,"items":[]}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	err := c.Bulk(context.Background(), IndexUsers, []BulkEntry{
		{ID: "1", Doc: map[string]any{"a": 1}},
		{ID: "2", Doc: map[string]any{"a": 2}},
	})
	if err == nil {
		t.Fatal("expected error when ES reports `errors:true`")
	}
}

func TestClient_Bulk_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errors":false,"items":[{"index":{"_id":"1","status":201,"result":"created"}}]}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	err := c.Bulk(context.Background(), IndexUsers, []BulkEntry{
		{ID: "1", Doc: map[string]any{"a": 1}},
	})
	if err != nil {
		t.Errorf("Bulk happy path: %v", err)
	}
}

func TestClient_Bulk_5xx(t *testing.T) {
	noRetryDelay(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	err := c.Bulk(context.Background(), IndexUsers, []BulkEntry{{ID: "1", Doc: 1}})
	if err == nil {
		t.Fatal("expected error from 502")
	}
}

// shrinkBulk lowers bulkFlushBytes for one test.
func shrinkBulk(t *testing.T, n int) {
	t.Helper()
	old := bulkFlushBytes
	bulkFlushBytes = n
	t.Cleanup(func() { bulkFlushBytes = old })
}

func created(string) int { return http.StatusCreated }

// Regression: one _bulk request for all of a parent's messages went over
// OpenSearch's request size limit and failed with 413. A request stops
// growing once it reaches bulkFlushBytes, and every entry is sent once.
func TestClient_Bulk_SplitsBySize(t *testing.T) {
	shrinkBulk(t, 300)
	b := &bulkCluster{respond: func(_ int, ids []string) string { return bulkResponse(ids, created) }}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()
	var entries []BulkEntry
	for i := 0; i < 10; i++ {
		entries = append(entries, BulkEntry{ID: fmt.Sprintf("m%d", i), Doc: map[string]any{"body": strings.Repeat("x", 50)}})
	}
	if err := NewClient(srv.URL).Bulk(context.Background(), IndexMessages, entries); err != nil {
		t.Fatalf("Bulk: %v", err)
	}
	bodies := b.rawBodies()
	if len(bodies) < 3 {
		t.Fatalf("requests = %d, want the entries split over several", len(bodies))
	}
	for _, body := range bodies {
		// Everything before the request's last entry (action + document line)
		// was under the cap, or the request would have gone out sooner.
		lines := strings.SplitAfter(body, "\n")
		if before := len(strings.Join(lines[:len(lines)-3], "")); before >= bulkFlushBytes {
			t.Errorf("request kept growing past the cap: %d bytes before its last entry", before)
		}
	}
	sent := map[string]int{}
	for _, ids := range b.calls() {
		for _, id := range ids {
			sent[id]++
		}
	}
	for _, e := range entries {
		if sent[e.ID] != 1 {
			t.Errorf("entry %s sent %d times, want 1", e.ID, sent[e.ID])
		}
	}
}

// Per-item errors in one request don't stop the next; they are reported
// once everything has been sent.
func TestClient_Bulk_SplitItemErrors(t *testing.T) {
	shrinkBulk(t, 100)
	b := &bulkCluster{respond: func(n int, ids []string) string {
		return bulkResponse(ids, func(string) int {
			if n == 1 {
				return http.StatusBadRequest
			}
			return http.StatusCreated
		})
	}}
	srv := httptest.NewServer(b.handler(t))
	defer srv.Close()
	entries := []BulkEntry{
		{ID: "a", Doc: map[string]any{"body": strings.Repeat("x", 60)}},
		{ID: "b", Doc: map[string]any{"body": strings.Repeat("x", 60)}},
	}
	err := NewClient(srv.URL).Bulk(context.Background(), IndexMessages, entries)
	if err == nil || !strings.Contains(err.Error(), "1 of 2 items failed") {
		t.Errorf("err = %v, want the first request's failed item reported", err)
	}
	if got := len(b.calls()); got != 2 {
		t.Errorf("requests = %d, want 2", got)
	}
}

// Regression: a whole _bulk request OpenSearch answered with 429 (shedding
// load) failed the parent's indexing. Once the transport's own retries are
// spent, the request is resubmitted on bulkRetryDelays until it goes through
// or they run out.
func TestClient_Bulk_RetriesThrottledRequest(t *testing.T) {
	noRetryDelay(t)
	tries := maxRetries + 1 // per round: the request and the transport's retries
	structured := `{"error":{"type":"too_many_requests","reason":"slow down"},"status":429}`
	for _, tc := range []struct {
		name      string
		body      string
		throttled int
		wantCalls int
		wantErr   bool
	}{
		{"recovers", structured, tries, tries + 1, false},
		{"recovers from a plain 429", `{"message":"Too Many Requests"}`, tries, tries + 1, false},
		{"gives up", structured, 1000, tries * (len(bulkRetryDelays) + 1), true},
	} {
		b := &bulkCluster{
			respond: func(_ int, ids []string) string { return bulkResponse(ids, created) },
			throttle: func(n int) string {
				if n <= tc.throttled {
					return tc.body
				}
				return ""
			},
		}
		srv := httptest.NewServer(b.handler(t))
		err := NewClient(srv.URL).Bulk(context.Background(), IndexMessages, entriesFor("a"))
		srv.Close()
		if (err != nil) != tc.wantErr || (err != nil && !strings.Contains(err.Error(), "429")) {
			t.Errorf("%s: err = %v, want error %v", tc.name, err, tc.wantErr)
		}
		if got := len(b.calls()); got != tc.wantCalls {
			t.Errorf("%s: requests = %d, want %d", tc.name, got, tc.wantCalls)
		}
	}
}

func TestClient_Search_FlattensESEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"hits": {
				"total": {"value": 2},
				"hits": [
					{"_id": "u-1", "_score": 1.5, "_source": {"displayName": "Alice"}},
					{"_id": "u-2", "_score": 1.2, "_source": {"displayName": "Bob"}}
				]
			}
		}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	res, err := c.Search(context.Background(), IndexUsers, map[string]any{"query": map[string]any{"match_all": map[string]any{}}})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if res.Total != 2 || len(res.Hits) != 2 {
		t.Fatalf("got total=%d hits=%d, want 2/2", res.Total, len(res.Hits))
	}
	if res.Hits[0].ID != "u-1" || res.Hits[0].Source["displayName"] != "Alice" {
		t.Errorf("hit[0] = %+v", res.Hits[0])
	}
}

func TestClient_Search_NilClientReturnsEmpty(t *testing.T) {
	var c *Client
	res, err := c.Search(context.Background(), IndexUsers, nil)
	if err != nil {
		t.Fatalf("nil-client Search: %v", err)
	}
	if res == nil || res.Total != 0 || len(res.Hits) != 0 {
		t.Errorf("got %+v, want empty", res)
	}
}

func TestClient_IndexDoc_PropagatesHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.IndexDoc(context.Background(), IndexUsers, "id", map[string]any{}); err == nil {
		t.Fatal("expected error from 400")
	}
}

func TestClient_EnsureIndices_UnexpectedHEADStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.EnsureIndices(context.Background()); err == nil {
		t.Fatal("expected error from unexpected HEAD status")
	}
}

func TestClient_EnsureIndices_PUTErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.EnsureIndices(context.Background()); err == nil {
		t.Fatal("expected error from PUT 500")
	}
}

func TestClient_Search_DecodeErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.Search(context.Background(), IndexUsers, nil); err == nil {
		t.Fatal("expected decode error")
	}
}

func TestClient_Bulk_DecodeErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	err := c.Bulk(context.Background(), IndexUsers, []BulkEntry{{ID: "1", Doc: 1}})
	if err == nil {
		t.Fatal("expected decode error")
	}
}

func TestClient_ClusterHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_cluster/health" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"cluster_name":"ex","status":"yellow","number_of_nodes":1}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	got, err := c.ClusterHealth(context.Background())
	if err != nil {
		t.Fatalf("ClusterHealth: %v", err)
	}
	if got["status"] != "yellow" {
		t.Errorf("status = %v", got["status"])
	}
}

func TestClient_ClusterHealth_NilClientReturnsNil(t *testing.T) {
	var c *Client
	got, err := c.ClusterHealth(context.Background())
	if err != nil || got != nil {
		t.Errorf("nil-client ClusterHealth = %v, %v", got, err)
	}
}

func TestClient_IndexStats_FillsMissingIndices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/_cat/indices/") {
			t.Errorf("path = %q", r.URL.Path)
		}
		// Return only one of the four indices — the other three
		// should appear as "missing" in the result.
		_, _ = w.Write([]byte(`[
			{"index":"ex_users","health":"green","status":"open","docs.count":"42","store.size":"12kb"}
		]`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	stats, err := c.IndexStats(context.Background())
	if err != nil {
		t.Fatalf("IndexStats: %v", err)
	}
	if len(stats) != 4 {
		t.Fatalf("len = %d, want 4 (always returns one row per known index)", len(stats))
	}
	if stats[0].Name != IndexUsers || stats[0].Docs != 42 || stats[0].Health != "green" {
		t.Errorf("users row = %+v", stats[0])
	}
	if stats[1].Name != IndexChannels || stats[1].Health != "missing" {
		t.Errorf("channels row = %+v", stats[1])
	}
	if stats[2].Name != IndexMessages || stats[2].Health != "missing" {
		t.Errorf("messages row = %+v", stats[2])
	}
}

func TestClient_IndexStats_NilClientReturnsNil(t *testing.T) {
	var c *Client
	got, err := c.IndexStats(context.Background())
	if err != nil || got != nil {
		t.Errorf("nil-client IndexStats = %v, %v", got, err)
	}
}

func TestClient_IndexStats_5xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.IndexStats(context.Background()); err == nil {
		t.Fatal("expected error from 500")
	}
}

func TestClient_Search_4xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad query"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.Search(context.Background(), IndexUsers, nil); err == nil {
		t.Fatal("expected error from 400")
	}
}

func TestNewAWSClient_EmptyURLReturnsNil(t *testing.T) {
	c, err := NewAWSClient(context.Background(), "", AWSSigning{Region: "us-east-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c != nil {
		t.Fatal("empty URL must return nil client (opt-out parity with NewClient)")
	}
}

// awsSignedClient builds a SigV4-signing Client pointed at srv through the
// real NewAWSClient path, with static test credentials so the test is fully
// hermetic (no env-var lookup, no IMDS calls).
func awsSignedClient(t *testing.T, srv *httptest.Server, service string) *Client {
	t.Helper()
	fakeAWSConfig(t, staticCreds())
	c, err := NewAWSClient(context.Background(), srv.URL, AWSSigning{Region: "us-east-1", Service: service})
	if err != nil {
		t.Fatalf("NewAWSClient: %v", err)
	}
	return c
}

func TestSigV4_AddsAuthorizationAndPayloadHeaders(t *testing.T) {
	var captured *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Clone(context.Background())
		_, _ = w.Write([]byte(`{"hits":{"total":{"value":0},"hits":[]}}`))
	}))
	defer srv.Close()

	c := awsSignedClient(t, srv, "es")
	if _, err := c.Search(context.Background(), IndexUsers, map[string]any{"query": map[string]any{"match_all": map[string]any{}}}); err != nil {
		t.Fatalf("Search: %v", err)
	}

	if captured == nil {
		t.Fatal("server did not receive the request")
	}
	authz := captured.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "AWS4-HMAC-SHA256 ") {
		t.Errorf("Authorization = %q, want AWS4-HMAC-SHA256 prefix", authz)
	}
	if !strings.Contains(authz, "Credential=AKIATESTACCESS/") {
		t.Errorf("Authorization missing credential scope: %q", authz)
	}
	if !strings.Contains(authz, "/us-east-1/es/aws4_request") {
		t.Errorf("Authorization missing region/service scope: %q", authz)
	}
	if captured.Header.Get("X-Amz-Date") == "" {
		t.Error("X-Amz-Date header missing")
	}
	if got := captured.Header.Get("X-Amz-Content-Sha256"); got == "" || got == emptySHA256 {
		t.Errorf("X-Amz-Content-Sha256 = %q — the request body must be hashed for SigV4", got)
	}
}

// SigV4 of a body-less request hashes the empty string. Drift here would
// invalidate every signed HEAD/GET call (EnsureIndices, GetDoc, IndexStats,
// ClusterHealth).
const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestSigV4_GETUsesEmptyPayloadHash(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-Amz-Content-Sha256")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := awsSignedClient(t, srv, "es")
	if _, err := c.ClusterHealth(context.Background()); err != nil {
		t.Fatalf("ClusterHealth: %v", err)
	}
	if got != emptySHA256 {
		t.Errorf("X-Amz-Content-Sha256 = %q, want %q", got, emptySHA256)
	}
}

func TestSigV4_BodyArrivesIntactAfterSigning(t *testing.T) {
	// Signing reads the body to compute the SHA256, then must reseat
	// it — otherwise the request goes out with no body and the cluster
	// rejects it with a 400.
	var receivedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		receivedBody = string(b)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := awsSignedClient(t, srv, "es")
	doc := map[string]any{"id": "u-1", "displayName": "Alice"}
	if err := c.IndexDoc(context.Background(), IndexUsers, "u-1", doc); err != nil {
		t.Fatalf("IndexDoc: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(receivedBody), &parsed); err != nil {
		t.Fatalf("body not valid JSON %q: %v", receivedBody, err)
	}
	if parsed["id"] != "u-1" || parsed["displayName"] != "Alice" {
		t.Errorf("body = %+v, want id=u-1 displayName=Alice", parsed)
	}
}

func TestSigV4_DefaultsServiceToES(t *testing.T) {
	srv, authz := headerRecorder(t)
	c := awsSignedClient(t, srv, "")
	if _, err := c.ClusterHealth(context.Background()); err != nil {
		t.Fatalf("ClusterHealth: %v", err)
	}
	if !strings.Contains(*authz, "/us-east-1/es/aws4_request") {
		t.Errorf("Authorization scope = %q, want the default es service", *authz)
	}
}

func TestSigV4_HonoursAOSSService(t *testing.T) {
	srv, authz := headerRecorder(t)
	c := awsSignedClient(t, srv, "aoss")
	if _, err := c.ClusterHealth(context.Background()); err != nil {
		t.Fatalf("ClusterHealth: %v", err)
	}
	if !strings.Contains(*authz, "/us-east-1/aoss/aws4_request") {
		t.Errorf("Authorization scope = %q, want aoss service in scope", *authz)
	}
}
