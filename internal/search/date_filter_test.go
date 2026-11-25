package search

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func lastFilter(t *testing.T, r *stubRunner) map[string]any {
	t.Helper()
	filters := r.called.body.(map[string]any)["query"].(map[string]any)["bool"].(map[string]any)["filter"].([]any)
	return filters[len(filters)-1].(map[string]any)
}

// The date modifiers become one range filter on createdAt, in filter
// context (cached, unscored), in the instants the client sent, as UTC.
func TestService_DateRangeFilter(t *testing.T) {
	berlin := time.FixedZone("CET", 3600)
	after := time.Date(2026, 11, 20, 0, 0, 0, 0, berlin)
	before := time.Date(2026, 11, 21, 0, 0, 0, 0, berlin)
	want := map[string]any{"range": map[string]any{"createdAt": map[string]any{
		"format": "strict_date_time",
		"gte":    "2026-11-19T23:00:00.000Z",
		"lt":     "2026-11-20T23:00:00.000Z",
	}}}

	for name, run := range map[string]func(*Service, MessageQuery) (*SearchResult, error){
		"messages": func(s *Service, q MessageQuery) (*SearchResult, error) { return s.Messages(context.Background(), q) },
		"files":    func(s *Service, q MessageQuery) (*SearchResult, error) { return s.Files(context.Background(), q) },
	} {
		t.Run(name, func(t *testing.T) {
			r := &stubRunner{}
			if _, err := run(&Service{r: r}, MessageQuery{Q: "deploy", AllowedParentIDs: []string{"ch-1"}, After: after, Before: before}); err != nil {
				t.Fatal(err)
			}
			if got := lastFilter(t, r); !reflect.DeepEqual(got, want) {
				t.Fatalf("date filter = %v, want %v", got, want)
			}
		})
	}
}

func TestService_DateRangeFilter_OneSided(t *testing.T) {
	r := &stubRunner{}
	day := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	if _, err := (&Service{r: r}).Messages(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"ch-1"}, Before: day}); err != nil {
		t.Fatal(err)
	}
	rng := lastFilter(t, r)["range"].(map[string]any)["createdAt"].(map[string]any)
	if _, has := rng["gte"]; has || rng["lt"] != "2026-11-20T00:00:00.000Z" {
		t.Fatalf("before-only range = %v", rng)
	}
	if _, err := (&Service{r: r}).Messages(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"ch-1"}, After: day}); err != nil {
		t.Fatal(err)
	}
	rng = lastFilter(t, r)["range"].(map[string]any)["createdAt"].(map[string]any)
	if _, has := rng["lt"]; has || rng["gte"] != "2026-11-20T00:00:00.000Z" {
		t.Fatalf("after-only range = %v", rng)
	}
}

// A date alone is enough to search ("everything from yesterday"), and no
// date adds no filter.
func TestService_DateOnlySearchRuns_NoDateNoFilter(t *testing.T) {
	r := &stubRunner{}
	svc := &Service{r: r}
	day := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	if _, err := svc.Messages(context.Background(), MessageQuery{AllowedParentIDs: []string{"ch-1"}, After: day}); err != nil || r.called.index != IndexMessages {
		t.Fatalf("date-only message search did not run: %v %q", err, r.called.index)
	}
	r.called.index = ""
	if _, err := svc.Files(context.Background(), MessageQuery{AllowedParentIDs: []string{"ch-1"}, Before: day}); err != nil || r.called.index != IndexFiles {
		t.Fatalf("date-only file search did not run: %v %q", err, r.called.index)
	}
	if _, err := svc.Messages(context.Background(), MessageQuery{Q: "x", AllowedParentIDs: []string{"ch-1"}}); err != nil {
		t.Fatal(err)
	}
	if _, isRange := lastFilter(t, r)["range"]; isRange {
		t.Fatal("no date must add no range filter")
	}
}
