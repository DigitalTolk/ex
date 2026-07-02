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

	"github.com/DigitalTolk/ex/internal/model"
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

func TestSearch_UserAutocompletePrefix_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	ctx := context.Background()
	idx := NewIndexer(c)
	svc := NewService(c)

	users := []*model.User{
		{ID: "au1", DisplayName: "Muhammad Abdur Rehman", Email: "abdur@example.com"},
		{ID: "au2", DisplayName: "Alice Anderson", Email: "alice@example.com"},
		{ID: "au3", DisplayName: "Foo Bar123", Email: "bar123@example.com"},
	}
	for _, u := range users {
		if err := idx.IndexUser(ctx, u); err != nil {
			t.Fatalf("IndexUser %s: %v", u.ID, err)
		}
	}
	refreshIndex(t, c, IndexUsers)

	cases := []struct {
		name string
		q    string
		want string // the ID that MUST be present
	}{
		// The #2 bug: a mid-name substring/prefix must match.
		{"prefix of middle token", "abd", "au1"},
		{"prefix of last token", "reh", "au1"},
		{"prefix of first token", "muh", "au1"},
		// The #4 bug: a true INFIX (not a token prefix) must match — "123" is in
		// the MIDDLE/end of "bar123", never a prefix, so this only works with
		// plain n-grams (edge n-grams would miss it).
		{"infix number inside a token", "123", "au3"},
		{"infix letters+digits inside a token", "ar12", "au3"},
		// Full-token exact still works.
		{"exact token", "Rehman", "au1"},
		// Typo tolerance (fuzziness AUTO) still works.
		{"typo", "Muhamad", "au1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := svc.Users(ctx, tc.q, 10)
			if err != nil {
				t.Fatalf("Users(%q): %v", tc.q, err)
			}
			if !hitIDs(res)[tc.want] {
				t.Fatalf("Users(%q) = %v, want %s present", tc.q, res.Hits, tc.want)
			}
		})
	}

	// Negative control: an unrelated prefix must NOT surface au1.
	res, err := svc.Users(ctx, "zzz", 10)
	if err != nil {
		t.Fatalf("Users(zzz): %v", err)
	}
	if hitIDs(res)["au1"] {
		t.Fatalf("Users(zzz) unexpectedly matched au1: %v", res.Hits)
	}
}

// The n-gram autocomplete subfield indexes grams of 2..10 chars. These
// tests pin the max_gram boundary — a 10-char infix matches, an 11+-char
// mid-token substring does NOT (it exceeds every indexed gram and is too
// many edits for the fuzzy fallback) — and prove the lowercase+ngram
// chain handles non-Latin scripts. Anyone tuning the analyzer (min/max
// gram, search_analyzer) trips these instead of silently breaking search.
func TestSearch_AutocompleteNgramBoundaryAndNonLatin_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	ctx := context.Background()
	idx := NewIndexer(c)
	svc := NewService(c)

	users := []*model.User{
		// One 16-char token so mid-token substrings of length 10 vs 11
		// straddle max_gram without full-token or fuzzy interference.
		{ID: "ng1", DisplayName: "abcdefghijklmnop", Email: "ng1@example.com"},
		{ID: "ng2", DisplayName: "Михаил Петров", Email: "mikhail@example.com"},
	}
	for _, u := range users {
		if err := idx.IndexUser(ctx, u); err != nil {
			t.Fatalf("IndexUser %s: %v", u.ID, err)
		}
	}
	refreshIndex(t, c, IndexUsers)

	t.Run("10-char infix matches (max_gram boundary)", func(t *testing.T) {
		res, err := svc.Users(ctx, "efghijklmn", 10) // chars 5-14 of the token
		if err != nil {
			t.Fatalf("Users: %v", err)
		}
		if !hitIDs(res)["ng1"] {
			t.Fatalf("10-char infix must match via the ngram subfield, got %v", res.Hits)
		}
	})
	t.Run("11-char mid-token substring misses (documented max_gram limit)", func(t *testing.T) {
		// 11 chars exceeds max_gram=10, and 5 edits from the full token is
		// beyond fuzziness AUTO — so this documented limitation returns
		// nothing (and must not error). If a mapping change makes this
		// match, update the docs in index.go alongside this test.
		res, err := svc.Users(ctx, "efghijklmno", 10)
		if err != nil {
			t.Fatalf("Users: %v", err)
		}
		if hitIDs(res)["ng1"] {
			t.Fatalf("11-char mid-token substring unexpectedly matched — max_gram semantics changed, update index.go docs: %v", res.Hits)
		}
	})
	t.Run("cyrillic prefix and infix", func(t *testing.T) {
		for _, q := range []string{"Мих", "иха"} {
			res, err := svc.Users(ctx, q, 10)
			if err != nil {
				t.Fatalf("Users(%q): %v", q, err)
			}
			if !hitIDs(res)["ng2"] {
				t.Fatalf("Users(%q) = %v, want ng2 — lowercase+ngram must handle Cyrillic", q, res.Hits)
			}
		}
	})
}

func TestSearch_ChannelAutocompleteAndScoping_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	ctx := context.Background()
	idx := NewIndexer(c)
	svc := NewService(c)

	channels := []*model.Channel{
		{ID: "ac1", Name: "engineering", Slug: "engineering", Type: model.ChannelTypePublic},
		{ID: "ac2", Name: "engineering-private", Slug: "engineering-private", Type: model.ChannelTypePrivate},
		{ID: "ac3", Name: "random", Slug: "random", Type: model.ChannelTypePublic, Archived: true},
	}
	for _, ch := range channels {
		if err := idx.IndexChannel(ctx, ch); err != nil {
			t.Fatalf("IndexChannel %s: %v", ch.ID, err)
		}
	}
	refreshIndex(t, c, IndexChannels)

	// Prefix "eng" must match both engineering channels via the ngram
	// subfield.
	res, err := svc.Channels(ctx, ChannelQuery{Q: "eng", Limit: 10})
	if err != nil {
		t.Fatalf("Channels(eng): %v", err)
	}
	if ids := hitIDs(res); !ids["ac1"] || !ids["ac2"] {
		t.Fatalf("Channels(eng) = %v, want ac1 and ac2", res.Hits)
	}

	// Access scoping: restricting to ac1 drops the private ac2 even
	// though it matches the query.
	res, err = svc.Channels(ctx, ChannelQuery{Q: "eng", AllowedChannelIDs: []string{"ac1"}, Limit: 10})
	if err != nil {
		t.Fatalf("Channels(eng, scoped): %v", err)
	}
	if ids := hitIDs(res); !ids["ac1"] || ids["ac2"] {
		t.Fatalf("scoped Channels(eng) = %v, want only ac1", res.Hits)
	}
}

func TestSearch_RecreateUsersChannelsDropsOrphan_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	ctx := context.Background()
	idx := NewIndexer(c)
	svc := NewService(c)

	// Seed a ghost directly into the index — simulates a user deleted
	// from DynamoDB whose search doc was never removed.
	if err := idx.IndexUser(ctx, &model.User{ID: "ghost-1", DisplayName: "Ghostly Presence"}); err != nil {
		t.Fatalf("seed ghost: %v", err)
	}
	refreshIndex(t, c, IndexUsers)
	before, err := svc.Users(ctx, "ghostly", 10)
	if err != nil {
		t.Fatalf("pre-search: %v", err)
	}
	if !hitIDs(before)["ghost-1"] {
		t.Fatal("precondition: ghost should be searchable before recreate")
	}

	// The canonical source no longer contains the ghost — only a live user.
	src := &fakeSources{
		users:    []*model.User{{ID: "live-1", DisplayName: "Ghostly Twin"}},
		channels: []*model.Channel{{ID: "keep-1", Name: "kept"}},
	}
	if _, _, err := RecreateUsersChannels(ctx, c, src); err != nil {
		t.Fatalf("RecreateUsersChannels: %v", err)
	}
	refreshIndex(t, c, IndexUsers)

	afterRes, err := svc.Users(ctx, "ghostly", 10)
	if err != nil {
		t.Fatalf("post-search: %v", err)
	}
	after := hitIDs(afterRes)
	if after["ghost-1"] {
		t.Fatal("ghost-1 must be gone after recreate reindex")
	}
	if !after["live-1"] {
		t.Fatal("live-1 must be present after recreate reindex")
	}
	// The rebuilt index still carries the autocomplete analyzer: a prefix
	// query resolves the freshly reindexed user.
	prefixRes, err := svc.Users(ctx, "gho", 10)
	if err != nil {
		t.Fatalf("prefix-search: %v", err)
	}
	if !hitIDs(prefixRes)["live-1"] {
		t.Fatal("prefix 'gho' should match live-1 on the recreated index")
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

// A rebuild must be repeatable and zero-downtime: the first run promotes
// a legacy real index onto an alias (atomic remove_index), the second
// swaps alias → alias and deletes the retired physical index. The
// logical name keeps answering searches and writes across both, and
// IndexStats keeps reporting the logical name.
func TestSearch_RebuildRepeatable_AliasSwap_RealEngine(t *testing.T) {
	c := newSearchClient(t)
	ctx := context.Background()
	svc := NewService(c)

	src := &fakeSources{
		users:    []*model.User{{ID: "swap-u1", DisplayName: "Swapelina Vex"}},
		channels: []*model.Channel{{ID: "swap-c1", Name: "swapchannel"}},
	}
	for run := 1; run <= 2; run++ {
		users, channels, err := RecreateUsersChannels(ctx, c, src)
		if err != nil {
			t.Fatalf("run %d: RecreateUsersChannels: %v", run, err)
		}
		if users != 1 || channels != 1 {
			t.Fatalf("run %d: counts = %d/%d, want 1/1", run, users, channels)
		}
		refreshIndex(t, c, IndexUsers)
		res, err := svc.Users(ctx, "swapelina", 10)
		if err != nil {
			t.Fatalf("run %d: search through logical name: %v", run, err)
		}
		if !hitIDs(res)["swap-u1"] {
			t.Fatalf("run %d: swap-u1 missing after rebuild: %v", run, res.Hits)
		}
		backing, err := c.aliasBacking(ctx, IndexUsers)
		if err != nil || backing == "" {
			t.Fatalf("run %d: expected %s to be an alias, backing=%q err=%v", run, IndexUsers, backing, err)
		}
	}

	// Writes through the logical (aliased) name still land.
	if err := NewIndexer(c).IndexUser(ctx, &model.User{ID: "post-swap", DisplayName: "Postswap Person"}); err != nil {
		t.Fatalf("IndexDoc through alias: %v", err)
	}
	refreshIndex(t, c, IndexUsers)
	res, err := svc.Users(ctx, "postswap", 10)
	if err != nil || !hitIDs(res)["post-swap"] {
		t.Fatalf("post-swap write not searchable through alias: %v %v", res, err)
	}

	// IndexStats maps the physical `<name>-r<nanos>` row back to the
	// logical name so the admin UI keeps rendering stable rows.
	stats, err := c.IndexStats(ctx)
	if err != nil {
		t.Fatalf("IndexStats: %v", err)
	}
	var userStat *IndexStat
	for i := range stats {
		if stats[i].Name == IndexUsers {
			userStat = &stats[i]
		}
	}
	if userStat == nil || userStat.Health == "missing" || userStat.Docs < 1 {
		t.Fatalf("IndexStats must report the aliased %s as live, got %+v", IndexUsers, stats)
	}
}
