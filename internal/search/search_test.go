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
