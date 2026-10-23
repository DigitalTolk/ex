// Package search wraps the small set of OpenSearch operations the app
// uses (index, delete, get and search documents, bulk writes, alias-swap
// index rebuilds) on top of github.com/opensearch-project/opensearch-go/v4.
// The library builds every request, runs the transport — SigV4 signing via
// its signer/awsv2 package, retries with backoff on 429/502/503/504 and on
// connection errors, connection pooling — parses cluster errors, and drives
// bulk writes through its BulkIndexer; this file only maps responses onto the
// shapes the app needs. Going via interfaces keeps tests free of a real
// cluster: handler / service tests stub the Searcher interface, and the live
// Client is driven by httptest here and by a real OpenSearch container in the
// integration suite.
package search

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"github.com/opensearch-project/opensearch-go/v4/opensearchtransport"
	"github.com/opensearch-project/opensearch-go/v4/opensearchutil"
	"github.com/opensearch-project/opensearch-go/v4/signer"
	"github.com/opensearch-project/opensearch-go/v4/signer/awsv2"
)

const (
	// requestTimeout bounds each attempt of a request (retries get their own).
	requestTimeout = 30 * time.Second
	// maxRetries is how often the transport retries a request that hit a
	// connection error or a 429/502/503/504.
	maxRetries = 3
	// retryBackoffBase/Max shape the exponential retry backoff.
	retryBackoffBase = 200 * time.Millisecond
	retryBackoffMax  = 5 * time.Second
	// bulkFlushBytes is large enough that a caller's batch normally goes out
	// as ONE _bulk request; bigger batches are split by the indexer.
	bulkFlushBytes = 10 << 20
	// bulkMaxAttempts bounds how often items the cluster rejected with a
	// per-item 429 (es_rejected_execution_exception) are resubmitted.
	bulkMaxAttempts = 4
	// bulkMaxReportedFailures caps how many per-item errors a bulk error
	// spells out; the count always covers all of them.
	bulkMaxReportedFailures = 5
)

// retryBackoff is the wait before retry `attempt` (1-based): exponential,
// capped, with jitter so many clients don't retry in lockstep. A seam so
// tests that drive retries don't spend real time waiting.
var retryBackoff = func(attempt int) time.Duration {
	d := min(retryBackoffBase<<(attempt-1), retryBackoffMax)
	return d/2 + rand.N(d/2)
}

// newTransport is a seam over opensearchtransport.New: with the fixed
// configuration built here it cannot fail, but its error contract is the
// library's, so the arm stays and is exercised through this seam.
var newTransport = opensearchtransport.New

// Client talks to OpenSearch. A nil *Client is a valid no-op client, so the
// app runs without search configured (search routes then return empty
// results and indexers do nothing).
type Client struct {
	api *opensearchapi.Client
}

// NewClient returns a Client pointed at baseURL (e.g.
// "http://opensearch:9200"). Returns nil for an empty baseURL so the caller
// can opt out of search entirely. A malformed URL is logged and also yields
// nil (search disabled); the server goes through NewClientFromConfig, which
// reports that as an error instead.
func NewClient(baseURL string) *Client {
	c, err := newClient(baseURL, nil)
	if err != nil {
		slog.Error("search: invalid OpenSearch configuration; search disabled", "error", err)
		return nil
	}
	return c
}

// newClient builds the library client: one seed URL, the tuned HTTP
// transport, retries with backoff, and no background traffic — the
// node-stats poller and health checks are for self-managed multi-node
// clusters and would only probe a managed endpoint that may not allow them.
func newClient(baseURL string, sgn signer.Signer) (*Client, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return nil, nil
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("search: parse url: %w", err)
	}
	tp, err := newTransport(opensearchtransport.Config{
		URLs:      []*url.URL{u},
		Signer:    sgn,
		Transport: newHTTPTransport(),
		RetryOnStatus: []int{
			http.StatusTooManyRequests, http.StatusBadGateway,
			http.StatusServiceUnavailable, http.StatusGatewayTimeout,
		},
		MaxRetries:        maxRetries,
		RetryBackoff:      func(attempt int) time.Duration { return retryBackoff(attempt) },
		RequestTimeout:    requestTimeout,
		NodeStatsInterval: -1,
		HealthCheck:       opensearchtransport.NoOpHealthCheck,
	})
	if err != nil {
		return nil, fmt.Errorf("search: build transport: %w", err)
	}
	return &Client{api: opensearchapi.NewFromClient(&opensearch.Client{Transport: tp})}, nil
}

// newHTTPTransport mirrors http.DefaultTransport but keeps far more idle
// connections per host: every search, index write and bulk request goes to
// the same cluster endpoint, and the default of 2 idle connections per host
// made concurrent traffic churn through fresh TCP/TLS handshakes.
func newHTTPTransport() *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

// AWSSigning configures SigV4 signing for managed AWS OpenSearch.
// Service is "es" for OpenSearch Service domains and "aoss" for
// OpenSearch Serverless collections. Credentials are loaded from the
// SDK's default chain (env vars → IRSA → EC2/ECS task role → shared
// config) so callers running on AWS just supply the region.
type AWSSigning struct {
	Region  string
	Service string
}

// loadAWSConfig is a seam over awsconfig.LoadDefaultConfig so the
// config-load failure branch in NewAWSClient can be exercised in tests
// (the real loader almost never errors with a valid in-process call).
var loadAWSConfig = awsconfig.LoadDefaultConfig

// NewAWSClient returns a Client that signs every request with SigV4
// against the configured AWS region/service. Same nil-on-empty-URL
// contract as NewClient. service defaults to "es".
func NewAWSClient(ctx context.Context, baseURL string, signing AWSSigning) (*Client, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, nil
	}
	awsCfg, err := loadAWSConfig(ctx, awsconfig.WithRegion(signing.Region))
	if err != nil {
		return nil, fmt.Errorf("search: load aws config: %w", err)
	}
	// NewSignerWithService only rejects an empty service, defaulted here.
	sgn := must(awsv2.NewSignerWithService(awsCfg, cmp.Or(signing.Service, "es")))
	return newClient(baseURL, sgn)
}

// ClientConfig carries the OpenSearch connection settings (mirrors the
// OPENSEARCH_* env vars) so the server and the migrate CLI share ONE
// constructor and the SigV4-vs-plain selection can't drift between them.
type ClientConfig struct {
	URL        string
	AWSRegion  string
	AWSService string
}

// NewClientFromConfig builds the client from configuration: SigV4-signed
// when an AWS region is set, plain otherwise, nil (no error) when no URL
// is configured — callers degrade to no-ops exactly like NewClient. A
// malformed URL is an error.
func NewClientFromConfig(ctx context.Context, cfg ClientConfig) (*Client, error) {
	if cfg.AWSRegion != "" {
		return NewAWSClient(ctx, cfg.URL, AWSSigning{
			Region:  cfg.AWSRegion,
			Service: cfg.AWSService,
		})
	}
	return newClient(cfg.URL, nil)
}

// perform runs req through the library (request building, signing,
// retries) and decodes a 2xx body into out when out is non-nil. A non-2xx
// answer comes back as the cluster's parsed error together with its status,
// so callers can treat a specific status (404) as a non-error. The status is
// 0 when no response arrived.
func perform[T any](ctx context.Context, c *Client, method string, req opensearch.Request, out *T) (int, error) {
	resp, err := opensearch.Do(ctx, c.api.Client, method, req, out)
	if err != nil {
		return 0, err
	}
	if resp.IsError() {
		return resp.StatusCode, opensearch.ParseError(resp)
	}
	return resp.StatusCode, nil
}

// send is perform for calls whose response body is not needed.
func (c *Client) send(ctx context.Context, method string, req opensearch.Request) (int, error) {
	return perform[opensearch.NoBody](ctx, c, method, req, nil)
}

// EnsureIndices creates each indexed-resource mapping if missing.
// Existing indices are left as-is; reindexing is a separate flow. Safe
// to call on every server start. (A rebuilt index is a physical
// `<name>-r<nanos>` behind an alias called `<name>` — the HEAD check
// matches aliases too, so this never fights PromoteIndex.)
func (c *Client) EnsureIndices(ctx context.Context) error {
	if c == nil {
		return nil
	}
	for name, body := range indexMappings {
		exists, err := c.indexExists(ctx, name)
		if err != nil {
			return fmt.Errorf("search: head %s: %w", name, err)
		}
		if exists {
			continue
		}
		if err := c.createIndex(ctx, name, body); err != nil {
			return fmt.Errorf("search: create %s: %w", name, err)
		}
	}
	return nil
}

func (c *Client) indexExists(ctx context.Context, name string) (bool, error) {
	status, err := c.send(ctx, http.MethodHead, opensearchapi.IndicesExistsReq{Indices: []string{name}})
	if status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}

func (c *Client) createIndex(ctx context.Context, name, body string) error {
	_, err := c.send(ctx, http.MethodPut, opensearchapi.IndicesCreateReq{Index: name, Body: strings.NewReader(body)})
	return err
}

// BeginIndexRebuild creates a fresh physical index carrying the CURRENT
// mapping for logical index `name`, named `<name>-r<unix-nanos>`, and
// returns that staging name. The live index (or alias) keeps serving
// reads and writes untouched; the caller bulk-populates the staging
// index, then PromoteIndex atomically swaps the logical name onto it —
// there is never a window where `name` doesn't resolve (the old
// delete-then-create rebuild 404'd every concurrent search and a crash
// mid-way left NO index until the next server start). Returns an error
// for an unknown logical name so a typo can't stage anything.
func (c *Client) BeginIndexRebuild(ctx context.Context, name string) (string, error) {
	if c == nil {
		return "", nil
	}
	body, ok := indexMappings[name]
	if !ok {
		return "", fmt.Errorf("search: unknown index %q", name)
	}
	// Stamp the schema generation so the promoted index advertises its version
	// and won't be seen as stale on the next boot. Only versioned indices
	// (users/channels) carry `_meta`; the rest stage their raw mapping.
	if version, versioned := desiredSchemaVersion[name]; versioned {
		stamped, err := stampSchemaMeta(body, version)
		if err != nil {
			return "", err
		}
		body = stamped
	}
	staging := fmt.Sprintf("%s-r%d", name, time.Now().UnixNano())
	if err := c.createIndex(ctx, staging, body); err != nil {
		return "", fmt.Errorf("search: create %s: %w", staging, err)
	}
	return staging, nil
}

// PromoteIndex atomically points logical index `name` at the freshly
// built `staging` index and retires the previous backing. All three
// possible live states are handled:
//   - alias `name` → old physical index: one atomic _aliases call moves
//     the alias, then the orphaned physical index is deleted;
//   - legacy real index named `name` (pre-alias deployments): the atomic
//     _aliases call uses remove_index, deleting the legacy index and
//     adding the alias in a single cluster-state update;
//   - nothing live yet: the alias is simply added.
//
// In every case concurrent searches and writes against `name` never 404.
func (c *Client) PromoteIndex(ctx context.Context, name, staging string) error {
	if c == nil {
		return nil
	}
	old, err := c.aliasBacking(ctx, name)
	if err != nil {
		return fmt.Errorf("search: resolve alias %s: %w", name, err)
	}
	add := map[string]any{"add": map[string]any{"index": staging, "alias": name}}
	var actions []map[string]any
	switch {
	case old != "":
		actions = []map[string]any{
			{"remove": map[string]any{"index": old, "alias": name}},
			add,
		}
	default:
		exists, err := c.indexExists(ctx, name)
		if err != nil {
			return fmt.Errorf("search: head %s: %w", name, err)
		}
		if exists {
			actions = []map[string]any{
				{"remove_index": map[string]any{"index": name}},
				add,
			}
		} else {
			actions = []map[string]any{add}
		}
	}
	payload := must(json.Marshal(map[string]any{"actions": actions}))
	if _, err := c.send(ctx, http.MethodPost, opensearchapi.AliasesReq{Body: bytes.NewReader(payload)}); err != nil {
		return fmt.Errorf("search: swap alias %s -> %s: %w", name, staging, err)
	}
	if old != "" {
		// The old physical index is unreferenced now; cleanup is
		// best-effort — an orphan wastes disk but the swap already
		// succeeded and the logical name is healthy.
		if err := c.deleteIndex(ctx, old); err != nil {
			slog.WarnContext(ctx, "search: promote: deleting retired index failed", "index", old, "error", err)
		}
	}
	return nil
}

// AbortIndexRebuild deletes an abandoned staging index after a failed
// rebuild. Best-effort: at worst the staging index lingers as
// unreferenced garbage, and the live index was never touched.
func (c *Client) AbortIndexRebuild(ctx context.Context, staging string) {
	if c == nil || staging == "" {
		return
	}
	if err := c.deleteIndex(ctx, staging); err != nil {
		slog.WarnContext(ctx, "search: abort rebuild: deleting staging index failed", "index", staging, "error", err)
	}
}

// aliasBacking returns the physical index that alias `name` points at,
// or "" when no such alias exists (legacy real index, or nothing).
func (c *Client) aliasBacking(ctx context.Context, name string) (string, error) {
	var out map[string]struct {
		Aliases map[string]any `json:"aliases"`
	}
	status, err := perform(ctx, c, http.MethodGet, opensearchapi.AliasGetReq{Alias: []string{name}}, &out)
	if status == http.StatusNotFound {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	for physical := range out {
		return physical, nil
	}
	return "", nil
}

// deleteIndex removes an entire index. A 404 (already gone) is treated
// as success so recreate is idempotent.
func (c *Client) deleteIndex(ctx context.Context, name string) error {
	status, err := c.send(ctx, http.MethodDelete, opensearchapi.IndicesDeleteReq{Indices: []string{name}})
	if status == http.StatusNotFound {
		return nil
	}
	return err
}

// GetDoc fetches a single document's _source. Returns (nil, nil) on
// 404 so the caller can treat "doesn't exist yet" as an empty map.
func (c *Client) GetDoc(ctx context.Context, index, id string) (map[string]any, error) {
	if c == nil {
		return nil, nil
	}
	var envelope struct {
		Source map[string]any `json:"_source"`
	}
	status, err := perform(ctx, c, http.MethodGet, opensearchapi.DocumentGetReq{Index: index, DocumentID: id}, &envelope)
	if status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("search: get %s/%s: %w", index, id, err)
	}
	return envelope.Source, nil
}

// IndexDoc upserts a single document into `index`, keyed on `id`.
// No refresh is requested: individual writes don't need to be
// immediately searchable; the next periodic refresh (1s default) is
// sufficient.
func (c *Client) IndexDoc(ctx context.Context, index, id string, doc any) error {
	if c == nil {
		return nil
	}
	body, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("search: marshal doc: %w", err)
	}
	if _, err := c.send(ctx, http.MethodPut, opensearchapi.IndexReq{Index: index, DocumentID: id, Body: bytes.NewReader(body)}); err != nil {
		return fmt.Errorf("search: index %s/%s: %w", index, id, err)
	}
	return nil
}

// DeleteDoc removes a single document. Missing-doc is not an error.
func (c *Client) DeleteDoc(ctx context.Context, index, id string) error {
	if c == nil {
		return nil
	}
	status, err := c.send(ctx, http.MethodDelete, opensearchapi.DocumentDeleteReq{Index: index, DocumentID: id})
	if status == http.StatusNotFound {
		return nil
	}
	return err
}

// BulkEntry is one document of a Bulk write: `(id, doc)`. Used by the
// reindex flow; for one-off writes use IndexDoc.
type BulkEntry struct {
	ID  string
	Doc any
}

// Bulk indexes many documents through the library's BulkIndexer. Every
// entry must be acknowledged by the cluster: a per-item failure comes back
// as an error naming the document and the cluster's reason (e.g. a
// mapper_parsing_exception), partial successes are retained. Items the
// cluster rejects with a per-item 429 (its write queue is full) are
// resubmitted with backoff; a whole request answered with 429 is retried
// by the transport.
func (c *Client) Bulk(ctx context.Context, index string, entries []BulkEntry) error {
	if c == nil || len(entries) == 0 {
		return nil
	}
	bodies := make([][]byte, len(entries))
	for i, e := range entries {
		b, err := json.Marshal(e.Doc)
		if err != nil {
			return fmt.Errorf("search: bulk doc %s: %w", e.ID, err)
		}
		bodies[i] = b
	}
	pending := make([]int, len(entries))
	for i := range pending {
		pending[i] = i
	}
	for attempt := 1; ; attempt++ {
		throttled, err := c.bulkRound(ctx, index, entries, bodies, pending)
		if err != nil {
			return err
		}
		if len(throttled) == 0 {
			return nil
		}
		if attempt == bulkMaxAttempts {
			return fmt.Errorf("search: bulk %s: %d items still rejected with 429 after %d attempts", index, len(throttled), attempt)
		}
		if err := sleepCtx(ctx, retryBackoff(attempt)); err != nil {
			return fmt.Errorf("search: bulk %s: %w", index, err)
		}
		pending = throttled
	}
}

// bulkRound writes the `pending` entries once and returns the ones the
// cluster rejected with a per-item 429, to be retried.
func (c *Client) bulkRound(ctx context.Context, index string, entries []BulkEntry, bodies [][]byte, pending []int) ([]int, error) {
	var (
		mu        sync.Mutex
		acked     int
		throttled []int
		failures  []error
		reqErr    error
	)
	// One worker, so a caller's batch goes out in order as one request.
	// NewBulkIndexer only errors when it has to build its own client.
	bi := must(opensearchutil.NewBulkIndexer(opensearchutil.BulkIndexerConfig{
		Client:     c.api,
		Context:    ctx,
		NumWorkers: 1,
		FlushBytes: bulkFlushBytes,
	}))
	var addErr error
	for _, i := range pending {
		id := entries[i].ID
		// Add only fails once ctx is done; keep the first such error.
		addErr = cmp.Or(addErr, bi.Add(ctx, opensearchutil.BulkIndexerItem{
			Index:      index,
			Action:     "index",
			DocumentID: id,
			Body:       bytes.NewReader(bodies[i]),
			OnSuccess: func(context.Context, opensearchutil.BulkIndexerItem, opensearchapi.BulkRespItem) {
				mu.Lock()
				defer mu.Unlock()
				acked++
			},
			OnFailure: func(_ context.Context, _ opensearchutil.BulkIndexerItem, res opensearchapi.BulkRespItem, err error) {
				mu.Lock()
				defer mu.Unlock()
				acked++
				switch {
				case err != nil:
					// The whole request failed; every item reports the same error.
					reqErr = cmp.Or(reqErr, err)
				case res.Status == http.StatusTooManyRequests:
					throttled = append(throttled, i)
				default:
					failures = append(failures, bulkItemError(id, res))
				}
			},
		}))
	}
	closeErr := bi.Close(ctx)
	// A Close cut short by ctx can leave a worker still reporting results.
	mu.Lock()
	defer mu.Unlock()
	if err := cmp.Or(addErr, closeErr, reqErr); err != nil {
		return nil, fmt.Errorf("search: bulk %s: %w", index, err)
	}
	if len(failures) > 0 {
		shown := failures[:min(len(failures), bulkMaxReportedFailures)]
		return nil, fmt.Errorf("search: bulk %s: %d of %d items failed: %w", index, len(failures), len(pending), errors.Join(shown...))
	}
	if acked < len(pending) {
		return nil, fmt.Errorf("search: bulk %s: cluster acknowledged %d of %d items", index, acked, len(pending))
	}
	return throttled, nil
}

// bulkItemError names a failed bulk item and the cluster's reason for it.
func bulkItemError(id string, res opensearchapi.BulkRespItem) error {
	if res.Error == nil {
		return fmt.Errorf("%s: status %d", id, res.Status)
	}
	return fmt.Errorf("%s: status %d: %s: %s", id, res.Status, res.Error.Type, res.Error.Reason)
}

// sleepCtx waits d, or until ctx is done.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type SearchHit struct {
	ID     string         `json:"id"`
	Score  float64        `json:"score"`
	Source map[string]any `json:"_source"`
}

// AggBucket is one entry from an OpenSearch terms-aggregation bucket
// list — a value (e.g. an authorId) and the number of result-set
// documents carrying it. Used by the frontend to populate filter
// dropdowns from the actual hit set.
type AggBucket struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// SearchResult is the trimmed shape callers actually need: total hit
// count, the hit list, and any per-field aggregation buckets that
// were requested in the query body.
type SearchResult struct {
	Total int                    `json:"total"`
	Hits  []SearchHit            `json:"hits"`
	Aggs  map[string][]AggBucket `json:"aggs,omitempty"`
}

// Search runs a query DSL body against `index` and returns the
// flattened hits. The body is the standard query DSL `{ "query":
// {...}, "size": ..., ... }` JSON.
func (c *Client) Search(ctx context.Context, index string, body any) (*SearchResult, error) {
	if c == nil {
		return &SearchResult{}, nil
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("search: marshal query: %w", err)
	}
	// `hits.total.value` plus `hits.hits[]` of `{_id, _score, _source}`.
	var envelope struct {
		Hits struct {
			Total struct {
				Value int `json:"value"`
			} `json:"total"`
			Hits []struct {
				ID     string         `json:"_id"`
				Score  float64        `json:"_score"`
				Source map[string]any `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
		Aggregations map[string]struct {
			Buckets []struct {
				Key      string `json:"key"`
				DocCount int    `json:"doc_count"`
			} `json:"buckets"`
		} `json:"aggregations"`
	}
	req := opensearchapi.SearchReq{Indices: []string{index}, Body: bytes.NewReader(raw)}
	if _, err := perform(ctx, c, http.MethodPost, req, &envelope); err != nil {
		return nil, fmt.Errorf("search: query %s: %w", index, err)
	}
	out := &SearchResult{Total: envelope.Hits.Total.Value, Hits: make([]SearchHit, 0, len(envelope.Hits.Hits))}
	for _, h := range envelope.Hits.Hits {
		out.Hits = append(out.Hits, SearchHit{ID: h.ID, Score: h.Score, Source: h.Source})
	}
	if len(envelope.Aggregations) > 0 {
		out.Aggs = make(map[string][]AggBucket, len(envelope.Aggregations))
		for name, agg := range envelope.Aggregations {
			buckets := make([]AggBucket, 0, len(agg.Buckets))
			for _, b := range agg.Buckets {
				buckets = append(buckets, AggBucket{Key: b.Key, Count: b.DocCount})
			}
			out.Aggs[name] = buckets
		}
	}
	return out, nil
}

// ClusterHealth returns the cluster's health snapshot. Used by the
// admin status panel — shape matches OpenSearch's /_cluster/health.
func (c *Client) ClusterHealth(ctx context.Context) (map[string]any, error) {
	if c == nil {
		return nil, nil
	}
	out := map[string]any{}
	if _, err := perform(ctx, c, http.MethodGet, opensearchapi.ClusterHealthReq{}, &out); err != nil {
		return nil, fmt.Errorf("search: cluster health: %w", err)
	}
	return out, nil
}

// IndexStat is the per-index summary the admin UI cares about.
type IndexStat struct {
	Name      string `json:"name"`
	Health    string `json:"health"`
	Status    string `json:"status"`
	Docs      int    `json:"docs"`
	StoreSize string `json:"storeSize"`
}

// IndexStats walks the search indices and returns a docs/size summary
// for each. Indices that don't exist yet are reported as "missing"
// instead of erroring so the admin UI can still render before the
// first reindex.
func (c *Client) IndexStats(ctx context.Context) ([]IndexStat, error) {
	if c == nil {
		return nil, nil
	}
	// Wildcard patterns never 404 on a missing index (an exact name would),
	// and also catch the `<name>-r<nanos>` physical index behind an alias.
	req := opensearchapi.CatIndicesReq{Indices: []string{
		IndexUsers + "*", IndexChannels + "*", IndexMessages + "*", IndexFiles + "*",
	}}
	var rows []struct {
		Index     string `json:"index"`
		Health    string `json:"health"`
		Status    string `json:"status"`
		DocsCount string `json:"docs.count"`
		StoreSize string `json:"store.size"`
	}
	if _, err := perform(ctx, c, http.MethodGet, req, &rows); err != nil {
		return nil, fmt.Errorf("search: cat indices: %w", err)
	}
	byName := map[string]IndexStat{}
	for _, r := range rows {
		docs := 0
		if r.DocsCount != "" {
			_, _ = fmt.Sscanf(r.DocsCount, "%d", &docs)
		}
		byName[r.Index] = IndexStat{
			Name: r.Index, Health: r.Health, Status: r.Status,
			Docs: docs, StoreSize: r.StoreSize,
		}
	}
	// Always return every known index in a stable order so the UI
	// can render rows even when an index hasn't been created yet. After
	// an alias-swap rebuild the physical row is named `<name>-r<nanos>`,
	// so fall back to prefix-matching and keep reporting the logical name.
	out := make([]IndexStat, 0, 4)
	for _, name := range []string{IndexUsers, IndexChannels, IndexMessages, IndexFiles} {
		s, ok := byName[name]
		if !ok {
			for physical, ps := range byName {
				if strings.HasPrefix(physical, name+"-r") {
					s, ok = ps, true
					s.Name = name
					break
				}
			}
		}
		if ok {
			out = append(out, s)
		} else {
			out = append(out, IndexStat{Name: name, Health: "missing"})
		}
	}
	return out, nil
}

// IndexSchemaVersion reads the `_meta.schemaVersion` stamped into logical index
// `name`'s live mapping. Returns (version, true, nil) when a stamp is present,
// and (0, false, nil) when the index exists but carries no stamp (a
// pre-versioning or freshly-created-empty index) or doesn't exist yet — both of
// which the caller treats as "stale, rebuild". The GET resolves through the
// alias, so the body is keyed by the physical `<name>-r<nanos>` index; an alias
// backs exactly one physical index, so the single entry is unambiguous.
func (c *Client) IndexSchemaVersion(ctx context.Context, name string) (int, bool, error) {
	if c == nil {
		return 0, false, nil
	}
	var out map[string]struct {
		Mappings struct {
			Meta struct {
				SchemaVersion *int `json:"schemaVersion"`
			} `json:"_meta"`
		} `json:"mappings"`
	}
	status, err := perform(ctx, c, http.MethodGet, opensearchapi.MappingGetReq{Indices: []string{name}}, &out)
	if status == http.StatusNotFound {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("search: mapping %s: %w", name, err)
	}
	for _, entry := range out {
		if entry.Mappings.Meta.SchemaVersion != nil {
			return *entry.Mappings.Meta.SchemaVersion, true, nil
		}
	}
	return 0, false, nil
}
