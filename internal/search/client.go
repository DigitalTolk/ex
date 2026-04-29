// Package search wraps the small set of OpenSearch operations the app
// uses (index a document, delete a document, search) over stdlib
// net/http. The wire protocol matches Elasticsearch 7.x for these
// endpoints, so dropping in a different OS-API-compatible engine
// (e.g. self-hosted Elasticsearch) only changes the URL. Going via
// an interface keeps tests free of a real cluster dependency: handler
// / service tests stub the Searcher interface, and the live Client is
// itself driven by httptest.
package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client talks to Elasticsearch. Construction is intentionally
// idempotent — passing an empty BaseURL returns nil so callers can
// run the app without ES configured (search routes will then return
// 503 / no-op indexers).
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient returns a Client pointed at baseURL (e.g.
// "http://opensearch:9200"). Returns nil for an empty baseURL so
// the caller can opt out of search entirely.
func NewClient(baseURL string) *Client {
	if strings.TrimSpace(baseURL) == "" {
		return nil
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// EnsureIndices creates each indexed-resource mapping if missing.
// Existing indices are left as-is; reindexing is a separate flow. Safe
// to call on every server start.
func (c *Client) EnsureIndices(ctx context.Context) error {
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
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, c.baseURL+"/"+name, nil)
	if err != nil {
		return false, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK {
		return true, nil
	}
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	return false, fmt.Errorf("unexpected status %d", resp.StatusCode)
}

func (c *Client) createIndex(ctx context.Context, name, body string) error {
	return c.do(ctx, http.MethodPut, "/"+name, strings.NewReader(body), nil)
}

// GetDoc fetches a single document's _source. Returns (nil, nil) on
// 404 so the caller can treat "doesn't exist yet" as an empty map.
func (c *Client) GetDoc(ctx context.Context, index, id string) (map[string]any, error) {
	if c == nil {
		return nil, nil
	}
	path := "/" + index + "/_doc/" + id
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode >= 400 {
		return nil, c.errorFromResponse(resp)
	}
	var envelope struct {
		Source map[string]any `json:"_source"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("search: get decode: %w", err)
	}
	return envelope.Source, nil
}

// IndexDoc upserts a single document into `index`, keyed on `id`.
// Refresh is set to false because individual writes don't need to be
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
	path := "/" + index + "/_doc/" + id
	return c.do(ctx, http.MethodPut, path, bytes.NewReader(body), nil)
}

// DeleteDoc removes a single document. Missing-doc is not an error.
func (c *Client) DeleteDoc(ctx context.Context, index, id string) error {
	if c == nil {
		return nil
	}
	path := "/" + index + "/_doc/" + id
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	return c.errorFromResponse(resp)
}

// Bulk indexes many documents in a single round-trip. Each entry is
// `(id, doc)`. Used by the reindex flow; for one-off writes use IndexDoc.
type BulkEntry struct {
	ID  string
	Doc any
}

// Bulk performs a single _bulk index operation (NDJSON body, action
// header + doc per pair of lines). Failures inside the bulk body
// (per-item) are reported through the returned error; the operation
// as a whole is best-effort and partial successes are retained.
func (c *Client) Bulk(ctx context.Context, index string, entries []BulkEntry) error {
	if c == nil || len(entries) == 0 {
		return nil
	}
	var buf bytes.Buffer
	for _, e := range entries {
		// Per-line {"index": {...}} action header.
		header := map[string]map[string]string{
			"index": {"_index": index, "_id": e.ID},
		}
		if err := json.NewEncoder(&buf).Encode(header); err != nil {
			return fmt.Errorf("search: bulk header: %w", err)
		}
		if err := json.NewEncoder(&buf).Encode(e.Doc); err != nil {
			return fmt.Errorf("search: bulk doc: %w", err)
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/_bulk", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return c.errorFromResponse(resp)
	}
	var out struct {
		Errors bool `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("search: bulk decode: %w", err)
	}
	if out.Errors {
		return errors.New("search: bulk had per-item errors")
	}
	return nil
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
// {...}, "size": ..., ... }` JSON shared between OpenSearch and ES.
func (c *Client) Search(ctx context.Context, index string, body any) (*SearchResult, error) {
	if c == nil {
		return &SearchResult{}, nil
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("search: marshal query: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/"+index+"/_search", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return nil, c.errorFromResponse(resp)
	}
	// Envelope is identical between OpenSearch 2.x and Elasticsearch
	// 7.x for the search response shape — `hits.total.value` plus
	// `hits.hits[]` of `{_id, _score, _source}`.
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
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("search: decode response: %w", err)
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

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, into any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return c.errorFromResponse(resp)
	}
	if into != nil {
		return json.NewDecoder(resp.Body).Decode(into)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// ClusterHealth returns the cluster's health snapshot. Used by the
// admin status panel — shape matches OpenSearch's /_cluster/health.
func (c *Client) ClusterHealth(ctx context.Context) (map[string]any, error) {
	if c == nil {
		return nil, nil
	}
	out := map[string]any{}
	if err := c.do(ctx, http.MethodGet, "/_cluster/health", nil, &out); err != nil {
		return nil, err
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
// for each. Indices that don't exist yet are reported with zero docs
// instead of erroring so the admin UI can still render before the
// first reindex.
func (c *Client) IndexStats(ctx context.Context) ([]IndexStat, error) {
	if c == nil {
		return nil, nil
	}
	// /_cat/indices supports a comma-separated index list with
	// `?expand_wildcards=open,closed&format=json` for stable JSON.
	pattern := IndexUsers + "," + IndexChannels + "," + IndexMessages + "," + IndexFiles
	path := "/_cat/indices/" + pattern + "?format=json&ignore_unavailable=true"
	var rows []struct {
		Index     string `json:"index"`
		Health    string `json:"health"`
		Status    string `json:"status"`
		DocsCount string `json:"docs.count"`
		StoreSize string `json:"store.size"`
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &rows); err != nil {
		return nil, err
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
	// can render rows even when an index hasn't been created yet.
	out := make([]IndexStat, 0, 4)
	for _, name := range []string{IndexUsers, IndexChannels, IndexMessages, IndexFiles} {
		if s, ok := byName[name]; ok {
			out = append(out, s)
		} else {
			out = append(out, IndexStat{Name: name, Health: "missing"})
		}
	}
	return out, nil
}

func (c *Client) errorFromResponse(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return fmt.Errorf("search: %s %s: %d %s", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode, string(body))
}
