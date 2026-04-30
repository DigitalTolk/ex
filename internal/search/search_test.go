package search

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

type stubRunner struct {
	called struct {
		index string
		body  any
	}
	res *SearchResult
	err error
}

func (s *stubRunner) Search(_ context.Context, index string, body any) (*SearchResult, error) {
	s.called.index = index
	s.called.body = body
	if s.res == nil {
		s.res = &SearchResult{}
	}
	return s.res, s.err
}

func TestService_Users_EmptyQueryShortCircuits(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	res, err := svc.Users(context.Background(), "  ", 10)
	if err != nil {
		t.Fatal(err)
	}
	if r.called.index != "" {
		t.Error("ES should not be queried for empty input")
	}
	if len(res.Hits) != 0 {
		t.Errorf("hits = %d, want 0", len(res.Hits))
	}
}

func TestService_Users_BuildsMultiMatch(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Users(context.Background(), "alice", 5); err != nil {
		t.Fatal(err)
	}
	if r.called.index != IndexUsers {
		t.Errorf("index = %q", r.called.index)
	}
	body := r.called.body.(map[string]any)
	if body["size"] != 5 {
		t.Errorf("size = %v", body["size"])
	}
	mm := body["query"].(map[string]any)["multi_match"].(map[string]any)
	if mm["query"] != "alice" {
		t.Errorf("query = %v", mm["query"])
	}
}

func TestService_Channels_ExcludesArchived(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Channels(context.Background(), "general", 10); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must_not"].([]any)
	if len(must) != 1 {
		t.Errorf("expected one must_not (archived=true), got %v", must)
	}
}

func TestService_Channels_EmptyQueryShortCircuits(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	res, _ := svc.Channels(context.Background(), "", 0)
	if r.called.index != "" {
		t.Error("ES should not be queried for empty input")
	}
	if len(res.Hits) != 0 {
		t.Error("expected empty hits")
	}
}

func TestService_Messages_NoAllowedParentsShortCircuits(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	res, err := svc.Messages(context.Background(), MessageQuery{Q: "anything", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if r.called.index != "" {
		t.Error("ES should not be queried when user has no readable parents")
	}
	if len(res.Hits) != 0 {
		t.Errorf("hits = %d, want 0", len(res.Hits))
	}
}

func TestService_Messages_BodyMatchWithRBACFilter(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{Q: "deploy plan", AllowedParentIDs: []string{"ch-1", "conv-1"}, Limit: 10}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	bool_ := body["query"].(map[string]any)["bool"].(map[string]any)
	must := bool_["must"].([]any)
	bm := must[0].(map[string]any)["match"].(map[string]any)["body"].(map[string]any)
	if bm["query"] != "deploy plan" || bm["operator"] != "and" {
		t.Errorf("body match = %+v", bm)
	}
	filter := bool_["filter"].([]any)
	terms := filter[0].(map[string]any)["terms"].(map[string]any)["parentId"].([]any)
	want := []any{"ch-1", "conv-1"}
	if !reflect.DeepEqual(terms, want) {
		t.Errorf("RBAC parentId filter = %v, want %v", terms, want)
	}
}

func TestService_Messages_HashtagQueryRoutesToTagsField(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{Q: "#BUG", AllowedParentIDs: []string{"ch-1"}, Limit: 10}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	should := must[0].(map[string]any)["bool"].(map[string]any)["should"].([]any)
	// First should-clause is a term match on tags (lowercased).
	term := should[0].(map[string]any)["term"].(map[string]any)["tags"]
	if term != "bug" {
		t.Errorf("tags term = %v, want \"bug\"", term)
	}
}

func TestService_Messages_RequestsAggregations(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"ch-1"}, Limit: 5}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	aggs, ok := body["aggs"].(map[string]any)
	if !ok {
		t.Fatalf("missing aggs: %+v", body)
	}
	for _, name := range []string{"byUser", "byParent"} {
		bucket, ok := aggs[name].(map[string]any)
		if !ok {
			t.Errorf("missing aggs.%s: %+v", name, aggs)
			continue
		}
		if _, ok := bucket["terms"]; !ok {
			t.Errorf("aggs.%s missing terms clause: %+v", name, bucket)
		}
	}
}

func TestService_Messages_AllowsFilterOnlyQuery(t *testing.T) {
	// q="" + from set ("all messages by user X") must NOT short-circuit
	// — the backend should run a match_all under the filters.
	r := &stubRunner{}
	svc := &Service{r: r}
	res, err := svc.Messages(context.Background(), MessageQuery{
		AllowedParentIDs: []string{"ch-1"},
		FromUserID:       "u-99",
		Limit:            10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.called.index != IndexMessages {
		t.Fatalf("expected ES query for empty-q + from, got %q", r.called.index)
	}
	if res == nil {
		t.Fatal("expected non-nil result")
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	if _, ok := must[0].(map[string]any)["match_all"]; !ok {
		t.Errorf("filter-only query must use match_all, got %+v", must[0])
	}
}

func TestService_Messages_StillShortCircuitsWithoutQueryOrFilter(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	res, err := svc.Messages(context.Background(), MessageQuery{AllowedParentIDs: []string{"ch-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.called.index != "" {
		t.Errorf("ES must not be queried when no q and no filter — got %q", r.called.index)
	}
	if len(res.Hits) != 0 {
		t.Errorf("expected empty hits, got %d", len(res.Hits))
	}
}

func TestService_Messages_PropagatesRunnerErr(t *testing.T) {
	r := &stubRunner{err: errors.New("es down")}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"ch-1"}}); err == nil {
		t.Fatal("expected error")
	}
}

func TestNoopSearcher_AllOpsReturnEmpty(t *testing.T) {
	n := noopSearcher{}
	if r, _ := n.Users(context.Background(), "x", 0); len(r.Hits) != 0 {
		t.Error("Users not empty")
	}
	if r, _ := n.Channels(context.Background(), "x", 0); len(r.Hits) != 0 {
		t.Error("Channels not empty")
	}
	if r, _ := n.Messages(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"a"}}); len(r.Hits) != 0 {
		t.Error("Messages not empty")
	}
	if r, _ := n.Files(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"a"}}); len(r.Hits) != 0 {
		t.Error("Files not empty")
	}
}

func TestService_Files_AppliesFromInAndSort(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Files(context.Background(), MessageQuery{
		Q:                "shared.pdf",
		AllowedParentIDs: []string{"ch-1", "ch-2"},
		FromUserID:       "u-1",
		InParentID:       "ch-1",
		Sort:             SortOldest,
		Limit:            5,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	filters := body["query"].(map[string]any)["bool"].(map[string]any)["filter"].([]any)
	if len(filters) < 3 {
		t.Fatalf("expected >=3 filters (parents/from/in), got %d", len(filters))
	}
	sort := body["sort"].([]any)
	first := sort[0].(map[string]any)["createdAt"].(map[string]any)
	if first["order"] != "asc" {
		t.Errorf("SortOldest must order createdAt asc, got %v", sort)
	}
}

func TestService_Files_QueriesFilesIndexWithFilenameMatchAndRBAC(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Files(context.Background(), MessageQuery{Q: "design.pdf", AllowedParentIDs: []string{"ch-1", "ch-2"}, Limit: 10}); err != nil {
		t.Fatal(err)
	}
	if r.called.index != IndexFiles {
		t.Errorf("Files() must hit ex_files, got %q", r.called.index)
	}
	body := r.called.body.(map[string]any)
	bool_ := body["query"].(map[string]any)["bool"].(map[string]any)
	must := bool_["must"].([]any)
	bm := must[0].(map[string]any)["match"].(map[string]any)["filename"].(map[string]any)
	if bm["query"] != "design.pdf" {
		t.Errorf("filename match = %+v", bm)
	}
	filters := bool_["filter"].([]any)
	terms := filters[0].(map[string]any)["terms"].(map[string]any)["parentIds"].([]any)
	want := []any{"ch-1", "ch-2"}
	if !reflect.DeepEqual(terms, want) {
		t.Errorf("RBAC parentIds filter = %v, want %v", terms, want)
	}
}

func TestService_Messages_AppliesFromInAndSort(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{
		Q:                "hello",
		AllowedParentIDs: []string{"ch-1", "ch-2"},
		FromUserID:       "u-99",
		InParentID:       "ch-1",
		Sort:             SortNewest,
		Limit:            10,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	filters := body["query"].(map[string]any)["bool"].(map[string]any)["filter"].([]any)
	// terms (parents) + term (authorId) + term (parentId in)
	if len(filters) < 3 {
		t.Fatalf("expected >=3 filters, got %d", len(filters))
	}
	sort := body["sort"].([]any)
	first := sort[0].(map[string]any)["createdAt"].(map[string]any)
	if first["order"] != "desc" {
		t.Errorf("SortNewest must order createdAt desc, got %v", sort)
	}
}

func TestNewService_NilClientReturnsNoop(t *testing.T) {
	s := NewService(nil)
	if _, ok := s.(noopSearcher); !ok {
		t.Errorf("got %T, want noopSearcher", s)
	}
}

func TestNewService_NonNilClientReturnsLiveService(t *testing.T) {
	c := NewClient("http://example.test")
	s := NewService(c)
	if _, ok := s.(*Service); !ok {
		t.Errorf("got %T, want *Service", s)
	}
}

func TestNewIndexer_NonNilClientReturnsLive(t *testing.T) {
	c := NewClient("http://example.test")
	idx := NewIndexer(c)
	if _, ok := idx.(*LiveIndexer); !ok {
		t.Errorf("got %T, want *LiveIndexer", idx)
	}
}

func TestClampLimit(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, 20}, {-5, 20}, {1, 1}, {50, 50}, {200, 100},
	}
	for _, c := range cases {
		if got := clampLimit(c.in); got != c.want {
			t.Errorf("clampLimit(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestExtractTagToken(t *testing.T) {
	if extractTagToken("nothing here") != "" {
		t.Error("expected empty for non-hashtag input")
	}
	if extractTagToken("#FOO bar") != "foo" {
		t.Error("expected lowercased first hashtag")
	}
	if extractTagToken("#  spaces") != "" {
		t.Error("standalone # should not be treated as a tag")
	}
}

func TestNormalizeFuzzy(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// User-reported case: emphasis-elongation collapsed so the
		// query lines up with the indexed term.
		{"Noiceeee", "Noice"},
		// Single trailing emphasis run.
		{"soooo", "so"},
		// Multiple runs in one word.
		{"yessssnoooo", "yesno"},
		// Legitimate doubles preserved.
		{"letter", "letter"},
		{"happy", "happy"},
		{"book", "book"},
		// Empty / short inputs.
		{"", ""},
		{"a", "a"},
		{"aa", "aa"},
		// Exactly 3 collapses to 1.
		{"aaa", "a"},
		// Mixed case is preserved.
		{"NOoooo", "NOo"},
		// Whitespace untouched.
		{"hi    there", "hi there"},
	}
	for _, c := range cases {
		if got := normalizeFuzzy(c.in); got != c.want {
			t.Errorf("normalizeFuzzy(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestService_Messages_NoiceeeeMatchesNoice(t *testing.T) {
	// The user-facing fuzzy contract: searching "Noiceeee" must reach
	// OpenSearch with a query body that allows the index entry "Noice"
	// to match. We verify two things:
	//   1. The query string sent has been normalized to "Noice" so a
	//      doc storing "Noice" is reachable via standard analysis.
	//   2. fuzziness=AUTO is set so 1–2 edit typos also match.
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{
		Q: "Noiceeee", AllowedParentIDs: []string{"ch-1"}, Limit: 10,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	match := must[0].(map[string]any)["match"].(map[string]any)["body"].(map[string]any)
	if match["query"] != "Noice" {
		t.Errorf("normalized query = %v, want %q", match["query"], "Noice")
	}
	if match["fuzziness"] != "AUTO" {
		t.Errorf("fuzziness = %v, want AUTO", match["fuzziness"])
	}
}

func TestService_Users_FuzzyMatchEmitsAutoFuzziness(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Users(context.Background(), "aliceeeee", 5); err != nil {
		t.Fatal(err)
	}
	mm := r.called.body.(map[string]any)["query"].(map[string]any)["multi_match"].(map[string]any)
	if mm["query"] != "alice" {
		t.Errorf("normalized query = %v, want %q", mm["query"], "alice")
	}
	if mm["fuzziness"] != "AUTO" {
		t.Errorf("fuzziness = %v, want AUTO", mm["fuzziness"])
	}
}

func TestService_Channels_FuzzyMatchEmitsAutoFuzziness(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Channels(context.Background(), "generaaaal", 10); err != nil {
		t.Fatal(err)
	}
	must := r.called.body.(map[string]any)["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	mm := must[0].(map[string]any)["multi_match"].(map[string]any)
	if mm["query"] != "general" {
		t.Errorf("normalized query = %v, want %q", mm["query"], "general")
	}
	if mm["fuzziness"] != "AUTO" {
		t.Errorf("fuzziness = %v, want AUTO", mm["fuzziness"])
	}
}

func TestService_Files_FuzzyFilenameMatch(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Files(context.Background(), MessageQuery{
		Q: "reportttt", AllowedParentIDs: []string{"ch-1"}, Limit: 5,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	match := must[0].(map[string]any)["match"].(map[string]any)["filename"].(map[string]any)
	if match["query"] != "report" {
		t.Errorf("normalized filename query = %v, want %q", match["query"], "report")
	}
	if match["fuzziness"] != "AUTO" {
		t.Errorf("fuzziness = %v, want AUTO", match["fuzziness"])
	}
}

func TestHasWildcard(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"plain", false},
		{"Noice*", true},
		{"a?b", true},
		{"", false},
		{"*", true},
	}
	for _, c := range cases {
		if got := hasWildcard(c.in); got != c.want {
			t.Errorf("hasWildcard(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestService_Messages_WildcardRoutesToSimpleQueryString(t *testing.T) {
	// User-facing wildcard contract: "Noice*" must reach OpenSearch
	// as a prefix-search shape so docs like "Noice", "Noiceparty",
	// "Noice meeting" all match. We use simple_query_string because
	// it's permissive (no syntax errors on user input) and supports
	// `*`/`?` natively without dropping field weights.
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{
		Q: "Noice*", AllowedParentIDs: []string{"ch-1"}, Limit: 10,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	sqs, ok := must[0].(map[string]any)["simple_query_string"].(map[string]any)
	if !ok {
		t.Fatalf("expected simple_query_string for wildcard query, got %v", must[0])
	}
	if sqs["query"] != "Noice*" {
		t.Errorf("query = %v, want %q", sqs["query"], "Noice*")
	}
	fields := sqs["fields"].([]string)
	if len(fields) != 1 || fields[0] != "body" {
		t.Errorf("fields = %v, want [body]", fields)
	}
	if sqs["default_operator"] != "AND" {
		t.Errorf("default_operator = %v, want AND", sqs["default_operator"])
	}
}

func TestService_Users_WildcardRoutesToSimpleQueryString(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Users(context.Background(), "ali*", 10); err != nil {
		t.Fatal(err)
	}
	sqs, ok := r.called.body.(map[string]any)["query"].(map[string]any)["simple_query_string"].(map[string]any)
	if !ok {
		t.Fatalf("expected simple_query_string at top level for wildcard user search")
	}
	if sqs["query"] != "ali*" {
		t.Errorf("query = %v, want %q", sqs["query"], "ali*")
	}
	fields := sqs["fields"].([]string)
	if len(fields) != 2 || fields[0] != "displayName^3" || fields[1] != "email" {
		t.Errorf("fields = %v, want [displayName^3 email]", fields)
	}
}

func TestService_Channels_WildcardRoutesToSimpleQueryString(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Channels(context.Background(), "gen*", 10); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	bool_ := body["query"].(map[string]any)["bool"].(map[string]any)
	must := bool_["must"].([]any)
	sqs, ok := must[0].(map[string]any)["simple_query_string"].(map[string]any)
	if !ok {
		t.Fatalf("expected simple_query_string in must clause for wildcard channel search")
	}
	if sqs["query"] != "gen*" {
		t.Errorf("query = %v", sqs["query"])
	}
	// archived=true exclusion still applies.
	mustNot := bool_["must_not"].([]any)
	if len(mustNot) != 1 {
		t.Errorf("must_not = %v, want archived filter", mustNot)
	}
}

func TestService_Files_WildcardRoutesToSimpleQueryString(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Files(context.Background(), MessageQuery{
		Q: "rep*", AllowedParentIDs: []string{"ch-1"}, Limit: 5,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	sqs, ok := must[0].(map[string]any)["simple_query_string"].(map[string]any)
	if !ok {
		t.Fatalf("expected simple_query_string for wildcard file search")
	}
	if sqs["query"] != "rep*" {
		t.Errorf("query = %v", sqs["query"])
	}
	if sqs["fields"].([]string)[0] != "filename" {
		t.Errorf("fields = %v", sqs["fields"])
	}
}

func TestService_Messages_WildcardCombinedWithElongation(t *testing.T) {
	// "Noiceeee*" → normalized "Noice*" before reaching OpenSearch,
	// so the prefix is the cleaned-up form, not the elongated typo.
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{
		Q: "Noiceeee*", AllowedParentIDs: []string{"ch-1"}, Limit: 10,
	}); err != nil {
		t.Fatal(err)
	}
	must := r.called.body.(map[string]any)["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	sqs := must[0].(map[string]any)["simple_query_string"].(map[string]any)
	if sqs["query"] != "Noice*" {
		t.Errorf("normalized wildcard query = %v, want %q", sqs["query"], "Noice*")
	}
}

func TestService_Messages_HashtagBranchKeepsExactTagButFuzzyBody(t *testing.T) {
	// Tag tokens are exact-match (`tags` is a `keyword` field). The
	// fallback body match alongside the term must still benefit from
	// fuzzy matching though, so a typed "#bug fixxxx" still finds
	// "fix" hits next to the exact #bug tag hits.
	r := &stubRunner{}
	svc := &Service{r: r}
	if _, err := svc.Messages(context.Background(), MessageQuery{
		Q: "#bug fixxxx", AllowedParentIDs: []string{"ch-1"}, Limit: 10,
	}); err != nil {
		t.Fatal(err)
	}
	body := r.called.body.(map[string]any)
	must := body["query"].(map[string]any)["bool"].(map[string]any)["must"].([]any)
	bool_ := must[0].(map[string]any)["bool"].(map[string]any)
	should := bool_["should"].([]any)
	tagTerm := should[0].(map[string]any)["term"].(map[string]any)["tags"]
	if tagTerm != "bug" {
		t.Errorf("tag term = %v, want %q", tagTerm, "bug")
	}
	bodyMatch := should[1].(map[string]any)["match"].(map[string]any)["body"].(map[string]any)
	if bodyMatch["query"] != "#bug fix" {
		t.Errorf("normalized body query = %v, want %q", bodyMatch["query"], "#bug fix")
	}
	if bodyMatch["fuzziness"] != "AUTO" {
		t.Errorf("fuzziness = %v, want AUTO", bodyMatch["fuzziness"])
	}
}
