package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// After an alias-swap rebuild the physical index is `<name>-r<nanos>`;
// IndexStats must fall back to prefix-matching and report the logical name.
func TestSearchCov_IndexStats_RolledPhysicalIndex(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{"index":"` + IndexMessages + `-r1756900000000000000","health":"green","status":"open","docs.count":"7","store.size":"9kb"}
		]`))
	}))
	defer srv.Close()

	stats, err := NewClient(srv.URL).IndexStats(context.Background())
	if err != nil {
		t.Fatalf("IndexStats: %v", err)
	}
	if len(stats) != 4 {
		t.Fatalf("len = %d, want 4", len(stats))
	}
	var msgRow *IndexStat
	for i := range stats {
		if stats[i].Name == IndexMessages {
			msgRow = &stats[i]
		}
	}
	if msgRow == nil || msgRow.Health != "green" || msgRow.Docs != 7 {
		t.Fatalf("rolled index not resolved to logical name: %+v", stats)
	}
}
