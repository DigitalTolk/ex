package search

import (
	"context"
	"strings"
)

// SortMode names the supported result orderings. "" means "relevance"
// (the OpenSearch default _score sort).
const (
	SortRelevance = ""
	SortNewest    = "newest"
	SortOldest    = "oldest"
)

// MessageQuery bundles the optional filters Messages and Files accept.
// AllowedParentIDs is mandatory — empty means "no scope" and yields
// zero results.
type MessageQuery struct {
	Q                string
	AllowedParentIDs []string
	// FromUserID, when set, filters to messages written by that user.
	FromUserID string
	// InParentID, when set, narrows further than AllowedParentIDs to
	// the single parent (must be a member of AllowedParentIDs to have
	// any effect — the AllowedParentIDs filter still applies).
	InParentID string
	Sort       string
	Limit      int
}

// Searcher is the read side. Tests stub this directly so they don't
// need a live cluster.
type Searcher interface {
	Users(ctx context.Context, q string, limit int) (*SearchResult, error)
	Channels(ctx context.Context, q string, limit int) (*SearchResult, error)
	// Messages searches message bodies, restricted to the parent IDs
	// the caller is allowed to read. Hashtag queries (`#foo`) are
	// detected in the input string and routed to the `tags` keyword
	// field for an exact match.
	Messages(ctx context.Context, opts MessageQuery) (*SearchResult, error)
	// Files searches attachment filenames on indexed messages,
	// restricted to AllowedParentIDs. Same RBAC as Messages.
	Files(ctx context.Context, opts MessageQuery) (*SearchResult, error)
}

// queryRunner is the slice of Client.Search the Service uses, so tests
// can plug in a stub.
type queryRunner interface {
	Search(ctx context.Context, index string, body any) (*SearchResult, error)
}

// Service is the production Searcher.
type Service struct {
	r queryRunner
}

// NewService returns a Searcher backed by the given Client. nil-client
// returns a no-op Searcher so callers don't need to special-case the
// "search not configured" path.
func NewService(c *Client) Searcher {
	if c == nil {
		return noopSearcher{}
	}
	return &Service{r: c}
}

// Users runs a multi-field match against displayName + email.
func (s *Service) Users(ctx context.Context, q string, limit int) (*SearchResult, error) {
	q = normalizeFuzzy(strings.TrimSpace(q))
	if q == "" {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}
	body := map[string]any{
		"size":  clampLimit(limit),
		"query": fieldMust(q, "displayName^3", "email"),
	}
	return s.r.Search(ctx, IndexUsers, body)
}

// Channels matches name (boosted) + description, with a filter that
// excludes archived channels.
func (s *Service) Channels(ctx context.Context, q string, limit int) (*SearchResult, error) {
	q = normalizeFuzzy(strings.TrimSpace(q))
	if q == "" {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}
	body := map[string]any{
		"size": clampLimit(limit),
		"query": map[string]any{
			"bool": map[string]any{
				"must": []any{fieldMust(q, "name^3", "description")},
				"must_not": []any{
					map[string]any{"term": map[string]any{"archived": true}},
				},
			},
		},
	}
	return s.r.Search(ctx, IndexChannels, body)
}

// Messages runs a full-text query against the message body, gated by a
// `terms` filter on parentId so users only see hits in channels /
// conversations they belong to. If `q` looks like a hashtag query
// (`#foo`), the term is also matched against the `tags` keyword
// field for exact-match boost. Empty `q` is allowed when `from` or
// `in` is set — "all messages by user X" is a useful query.
func (s *Service) Messages(ctx context.Context, opts MessageQuery) (*SearchResult, error) {
	rawQ := strings.TrimSpace(opts.Q)
	if len(opts.AllowedParentIDs) == 0 {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}
	if rawQ == "" && opts.FromUserID == "" && opts.InParentID == "" {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}
	must := messageMust(rawQ)
	return s.r.Search(ctx, IndexMessages, buildMessageBody(must, opts))
}

// messageMust builds the OpenSearch `must` clause for a body search.
// Hashtag queries route to the keyword `tags` field (exact match — no
// fuzziness, no normalization). Wildcards in the query (`*` / `?`)
// route to a simple_query_string so users can prefix-search ("Noice*").
// Otherwise a fuzzy AND match against the body, with runs of 3+
// identical characters collapsed so "Noiceeee" matches "Noice".
func messageMust(q string) any {
	if q == "" {
		return map[string]any{"match_all": map[string]any{}}
	}
	norm := normalizeFuzzy(q)
	if tag := extractTagToken(q); tag != "" {
		return map[string]any{
			"bool": map[string]any{
				"should": []any{
					map[string]any{"term": map[string]any{"tags": tag}},
					fieldMust(norm, "body"),
				},
				"minimum_should_match": 1,
			},
		}
	}
	return fieldMust(norm, "body")
}

// Files queries the dedicated ex_files index. RBAC re-uses the same
// AllowedParentIDs gate as Messages — the file doc carries every
// parent ID it has been shared in. Empty `q` is allowed when filters
// are set so "all files from user X" works without requiring text.
func (s *Service) Files(ctx context.Context, opts MessageQuery) (*SearchResult, error) {
	q := strings.TrimSpace(opts.Q)
	if len(opts.AllowedParentIDs) == 0 {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}
	if q == "" && opts.FromUserID == "" && opts.InParentID == "" {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}
	filters := []any{
		map[string]any{"terms": map[string]any{"parentIds": stringSliceToAny(opts.AllowedParentIDs)}},
	}
	if opts.FromUserID != "" {
		filters = append(filters, map[string]any{"term": map[string]any{"sharedBy": opts.FromUserID}})
	}
	if opts.InParentID != "" {
		filters = append(filters, map[string]any{"term": map[string]any{"parentIds": opts.InParentID}})
	}
	var fileMust any = map[string]any{"match_all": map[string]any{}}
	if q != "" {
		fileMust = fieldMust(normalizeFuzzy(q), "filename")
	}
	body := map[string]any{
		"size": clampLimit(opts.Limit),
		"query": map[string]any{
			"bool": map[string]any{
				"must":   []any{fileMust},
				"filter": filters,
			},
		},
		"sort": buildSort(opts.Sort),
		"aggs": map[string]any{
			"byParent": map[string]any{
				"terms": map[string]any{"field": "parentIds", "size": 20},
			},
			"byUser": map[string]any{
				"terms": map[string]any{"field": "sharedBy", "size": 20},
			},
		},
	}
	return s.r.Search(ctx, IndexFiles, body)
}

// buildSort returns the OpenSearch `sort` clause for a result set.
// Default ("") is relevance — _score desc with createdAt desc as a
// tiebreaker. Newest/oldest pin to createdAt only so paging through
// chronological results is stable.
func buildSort(mode string) []any {
	switch mode {
	case SortNewest:
		return []any{map[string]any{"createdAt": map[string]any{"order": "desc"}}}
	case SortOldest:
		return []any{map[string]any{"createdAt": map[string]any{"order": "asc"}}}
	}
	return []any{
		map[string]any{"_score": map[string]any{"order": "desc"}},
		map[string]any{"createdAt": map[string]any{"order": "desc"}},
	}
}

// buildMessageBody assembles the OpenSearch request body for a
// message-index query.
func buildMessageBody(must any, opts MessageQuery) map[string]any {
	filters := []any{
		map[string]any{"terms": map[string]any{"parentId": stringSliceToAny(opts.AllowedParentIDs)}},
	}
	if opts.FromUserID != "" {
		filters = append(filters, map[string]any{"term": map[string]any{"authorId": opts.FromUserID}})
	}
	if opts.InParentID != "" {
		filters = append(filters, map[string]any{"term": map[string]any{"parentId": opts.InParentID}})
	}
	return map[string]any{
		"size": clampLimit(opts.Limit),
		"query": map[string]any{
			"bool": map[string]any{
				"must":   []any{must},
				"filter": filters,
			},
		},
		"sort": buildSort(opts.Sort),
		// Aggregations populate the From/In filter dropdowns from the
		// hit set so the user only ever sees options that actually
		// match the current query.
		"aggs": map[string]any{
			"byParent": map[string]any{
				"terms": map[string]any{"field": "parentId", "size": 20},
			},
			"byUser": map[string]any{
				"terms": map[string]any{"field": "authorId", "size": 20},
			},
		},
	}
}

// noopSearcher returns empty results for all queries — used when
// search isn't configured so the routes still respond cleanly.
type noopSearcher struct{}

func (noopSearcher) Users(context.Context, string, int) (*SearchResult, error) {
	return &SearchResult{Hits: []SearchHit{}}, nil
}
func (noopSearcher) Channels(context.Context, string, int) (*SearchResult, error) {
	return &SearchResult{Hits: []SearchHit{}}, nil
}
func (noopSearcher) Messages(context.Context, MessageQuery) (*SearchResult, error) {
	return &SearchResult{Hits: []SearchHit{}}, nil
}
func (noopSearcher) Files(context.Context, MessageQuery) (*SearchResult, error) {
	return &SearchResult{Hits: []SearchHit{}}, nil
}

func clampLimit(n int) int {
	if n <= 0 {
		return 20
	}
	if n > 100 {
		return 100
	}
	return n
}

func extractTagToken(q string) string {
	// Treat the FIRST token starting with `#` as the hashtag query. If
	// no such token exists, return "" and the caller falls back to a
	// plain body match.
	for _, f := range strings.Fields(q) {
		if strings.HasPrefix(f, "#") && len(f) > 1 {
			return strings.ToLower(strings.TrimPrefix(f, "#"))
		}
	}
	return ""
}

func stringSliceToAny(in []string) []any {
	out := make([]any, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}

// hasWildcard returns true if the query contains a wildcard character
// understood by simple_query_string (`*` for any sequence, `?` for one
// character). Used to route wildcard queries through a different
// OpenSearch query shape than the standard fuzzy match.
func hasWildcard(q string) bool {
	return strings.ContainsAny(q, "*?")
}

// fieldMust builds the OpenSearch `must` clause for one or more text
// fields. Plain queries use `match` (one field) or `multi_match` (many)
// with fuzziness=AUTO; queries containing `*`/`?` route to
// `simple_query_string` so users can prefix-search ("Noice*"). All
// paths assume `q` has already been normalized for elongation.
func fieldMust(q string, fields ...string) any {
	if hasWildcard(q) {
		return map[string]any{
			"simple_query_string": map[string]any{
				"query":            q,
				"fields":           fields,
				"default_operator": "AND",
			},
		}
	}
	if len(fields) == 1 {
		return map[string]any{
			"match": map[string]any{
				fields[0]: map[string]any{
					"query":     q,
					"operator":  "and",
					"fuzziness": "AUTO",
				},
			},
		}
	}
	return map[string]any{
		"multi_match": map[string]any{
			"query":     q,
			"fields":    fields,
			"type":      "best_fields",
			"fuzziness": "AUTO",
		},
	}
}

// normalizeFuzzy collapses runs of 3+ identical characters in the
// query to a single character, so emphasis-spelling like "Noiceeee"
// matches "Noice". Legitimate doubles ("letter", "happy") stay
// unchanged. Combined with `fuzziness: "AUTO"` on the match query,
// this gives the searcher both elongation tolerance and 1–2 edit
// typo tolerance.
//
// Mirror in frontend/src/lib/fuzzy.ts — keep both implementations
// behaviourally identical so client- and server-side filters agree.
func normalizeFuzzy(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	out := make([]rune, 0, len(runes))
	for i := 0; i < len(runes); {
		c := runes[i]
		j := i + 1
		for j < len(runes) && runes[j] == c {
			j++
		}
		if j-i >= 3 {
			out = append(out, c)
		} else {
			out = append(out, runes[i:j]...)
		}
		i = j
	}
	return string(out)
}
