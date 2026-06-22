//go:build integration

package search

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// A single real OpenSearch container backs this suite. Previously the search
// client was only ever tested against an httptest server that returned canned
// "hits" regardless of the request — so the index mappings and the query DSL
// were never validated against a real engine. A wrong analyzer (text vs
// keyword) or a malformed query would pass the fake yet return nothing in
// production. These tests close that gap.
var (
	osURL   string
	osReady bool
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	req := testcontainers.ContainerRequest{
		// Match the docker-compose stack's image so tests run what prod runs.
		Image:        "opensearchproject/opensearch:3.6.0",
		ExposedPorts: []string{"9200/tcp"},
		Env: map[string]string{
			"discovery.type":              "single-node",
			"DISABLE_SECURITY_PLUGIN":     "true",
			"DISABLE_INSTALL_DEMO_CONFIG": "true",
			"OPENSEARCH_JAVA_OPTS":        "-Xms512m -Xmx512m",
			"bootstrap.memory_lock":       "false",
		},
		WaitingFor: wait.ForHTTP("/_cluster/health").
			WithPort("9200/tcp").
			WithStatusCodeMatcher(func(status int) bool { return status == http.StatusOK }).
			WithStartupTimeout(180 * time.Second),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		log.Printf("search integration tests will skip: docker/opensearch unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "9200"); perr == nil {
			osURL = fmt.Sprintf("http://%s:%s", host, port.Port())
			osReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

func newSearchClient(t *testing.T) *Client {
	t.Helper()
	if !osReady {
		t.Skip("skipping: Docker / OpenSearch not available")
	}
	c := NewClient(osURL)
	if err := c.EnsureIndices(context.Background()); err != nil {
		t.Fatalf("EnsureIndices against real OpenSearch: %v", err)
	}
	return c
}

func refreshIndex(t *testing.T, c *Client, index string) {
	t.Helper()
	// IndexDoc writes with refresh=false, so force a refresh to make docs
	// searchable before asserting.
	if err := c.do(context.Background(), http.MethodPost, "/"+index+"/_refresh", nil, nil); err != nil {
		t.Fatalf("refresh %s: %v", index, err)
	}
}

func hitIDs(res *SearchResult) map[string]bool {
	ids := map[string]bool{}
	for _, h := range res.Hits {
		if id, ok := h.Source["id"].(string); ok {
			ids[id] = true
		}
	}
	return ids
}

func TestSearch_MessageMappingAndQuery_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	ctx := context.Background()

	docs := []map[string]any{
		{"id": "m1", "parentId": "ch1", "parentType": "channel", "authorId": "u1", "body": "deploy the kraken to production"},
		{"id": "m2", "parentId": "ch1", "parentType": "channel", "authorId": "u2", "body": "lunch plans for friday"},
		{"id": "m3", "parentId": "ch2", "parentType": "channel", "authorId": "u1", "body": "the DEPLOY pipeline is finally green"},
	}
	for _, d := range docs {
		if err := c.IndexDoc(ctx, IndexMessages, d["id"].(string), d); err != nil {
			t.Fatalf("IndexDoc %s: %v", d["id"], err)
		}
	}
	refreshIndex(t, c, IndexMessages)

	// `body` is a `text` field: a match query is tokenized + case-folded, so
	// "deploy" hits m1 and the uppercase "DEPLOY" in m3, but not m2. This is
	// exactly the analyzer behavior the canned httptest server could never
	// verify — if `body` were accidentally a `keyword`, this would fail.
	res, err := c.Search(ctx, IndexMessages, map[string]any{
		"query": map[string]any{"match": map[string]any{"body": "deploy"}},
	})
	if err != nil {
		t.Fatalf("text match search: %v", err)
	}
	if ids := hitIDs(res); !ids["m1"] || !ids["m3"] || ids["m2"] {
		t.Fatalf("match body:deploy returned %v, want {m1, m3} (tokenized + case-insensitive)", ids)
	}

	// `parentId` is a `keyword` field: a term filter is an exact match, so
	// scoping to ch1 keeps m1 and drops m3.
	res, err = c.Search(ctx, IndexMessages, map[string]any{
		"query": map[string]any{"bool": map[string]any{
			"must":   map[string]any{"match": map[string]any{"body": "deploy"}},
			"filter": map[string]any{"term": map[string]any{"parentId": "ch1"}},
		}},
	})
	if err != nil {
		t.Fatalf("filtered search: %v", err)
	}
	if ids := hitIDs(res); !ids["m1"] || ids["m3"] {
		t.Fatalf("filter parentId=ch1 returned %v, want only m1", ids)
	}

	// Negative control: a term in no document returns zero hits — proof we're
	// querying a real engine, not a stub that always says "hits".
	res, err = c.Search(ctx, IndexMessages, map[string]any{
		"query": map[string]any{"match": map[string]any{"body": "rumpelstiltskin"}},
	})
	if err != nil {
		t.Fatalf("negative search: %v", err)
	}
	if res.Total != 0 || len(res.Hits) != 0 {
		t.Fatalf("absent-term query returned %d hits, want 0", res.Total)
	}
}

func TestSearch_EnsureIndicesIsIdempotent_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	// EnsureIndices ran once in newSearchClient; a second call must be a no-op
	// (the indices already exist) rather than erroring.
	if err := c.EnsureIndices(context.Background()); err != nil {
		t.Fatalf("EnsureIndices second call should be idempotent: %v", err)
	}
}
