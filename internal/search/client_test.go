package search

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
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

func TestNewClient_TrimsTrailingSlash(t *testing.T) {
	c := NewClient("http://example.test/")
	if c == nil || c.baseURL != "http://example.test" {
		t.Errorf("baseURL = %q, want %q", c.baseURL, "http://example.test")
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
	created := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodHead:
			w.WriteHeader(http.StatusOK) // already exists
		case http.MethodPut:
			created++
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.EnsureIndices(context.Background()); err != nil {
		t.Fatalf("EnsureIndices: %v", err)
	}
	if created != 0 {
		t.Errorf("expected 0 PUT (indices already exist), got %d", created)
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
		_, _ = w.Write([]byte(`{"errors":false,"items":[]}`))
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

// awsSignedClient builds a Client whose transport is the SigV4 signer
// pointed at srv, using static test credentials so the test is fully
// hermetic (no env-var lookup, no IMDS calls).
func awsSignedClient(srv *httptest.Server, service string) *Client {
	creds := credentials.NewStaticCredentialsProvider("AKIATESTACCESS", "secretkeydonotuse", "")
	return &Client{
		baseURL: strings.TrimRight(srv.URL, "/"),
		http: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &sigV4Transport{
				inner:   http.DefaultTransport,
				signer:  v4.NewSigner(),
				creds:   aws.CredentialsProvider(creds),
				region:  "us-east-1",
				service: service,
			},
		},
	}
}

func TestSigV4Transport_AddsAuthorizationAndPayloadHeaders(t *testing.T) {
	var captured *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Clone(context.Background())
		_, _ = w.Write([]byte(`{"hits":{"total":{"value":0},"hits":[]}}`))
	}))
	defer srv.Close()

	c := awsSignedClient(srv, "es")
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
	if got := captured.Header.Get("X-Amz-Content-Sha256"); got == "" {
		t.Error("X-Amz-Content-Sha256 header missing — body must be hashed for SigV4")
	}
}

func TestSigV4Transport_GETUsesEmptyPayloadHash(t *testing.T) {
	// SigV4 of GET (no body) hashes the empty string. Confirm we send
	// that exact constant — drift here would invalidate every signed
	// HEAD/GET call (EnsureIndices, GetDoc, IndexStats, ClusterHealth).
	const wantEmptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-Amz-Content-Sha256")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := awsSignedClient(srv, "es")
	if _, err := c.ClusterHealth(context.Background()); err != nil {
		t.Fatalf("ClusterHealth: %v", err)
	}
	if got != wantEmptyHash {
		t.Errorf("X-Amz-Content-Sha256 = %q, want %q", got, wantEmptyHash)
	}
}

func TestSigV4Transport_BodyArrivesIntactAfterSigning(t *testing.T) {
	// Signing reads the body to compute the SHA256, then must reseat
	// it — otherwise the downstream RoundTripper sends a request with
	// no body and the cluster rejects with a 400.
	var receivedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		receivedBody = string(b)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := awsSignedClient(srv, "es")
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

func TestSigV4Transport_DefaultsServiceToES(t *testing.T) {
	c, err := NewAWSClient(context.Background(), "https://example.test", AWSSigning{Region: "us-east-1"})
	if err != nil {
		t.Fatalf("NewAWSClient: %v", err)
	}
	if c == nil {
		t.Fatal("expected client, got nil")
	}
	transport, ok := c.http.Transport.(*sigV4Transport)
	if !ok {
		t.Fatalf("transport = %T, want *sigV4Transport", c.http.Transport)
	}
	if transport.service != "es" {
		t.Errorf("default service = %q, want es", transport.service)
	}
	if transport.region != "us-east-1" {
		t.Errorf("region = %q", transport.region)
	}
}

func TestSigV4Transport_HonoursAOSSService(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := awsSignedClient(srv, "aoss")
	if _, err := c.ClusterHealth(context.Background()); err != nil {
		t.Fatalf("ClusterHealth: %v", err)
	}
	if !strings.Contains(got, "/us-east-1/aoss/aws4_request") {
		t.Errorf("Authorization scope = %q, want aoss service in scope", got)
	}
}
