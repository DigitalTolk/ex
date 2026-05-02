package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakeGiphySettingsStore lets the test seed an API key without spinning
// up DynamoDB.
type fakeGiphySettingsStore struct {
	ws *model.WorkspaceSettings
}

func (f *fakeGiphySettingsStore) GetSettings(_ context.Context) (*model.WorkspaceSettings, error) {
	return f.ws, nil
}
func (f *fakeGiphySettingsStore) PutSettings(_ context.Context, ws *model.WorkspaceSettings) error {
	f.ws = ws
	return nil
}

// newGiphyTestService builds a GiphyService whose settings come from an
// in-memory fake and whose upstream is the supplied httptest.Server.
func newGiphyTestService(apiKey string, srv *httptest.Server) *GiphyService {
	settings := NewSettingsService(&fakeGiphySettingsStore{ws: &model.WorkspaceSettings{GiphyAPIKey: apiKey}})
	return NewGiphyService(settings).WithBaseURL(srv.URL)
}

const sampleGiphyBody = `{"data":[{"id":"abc123","title":"Cat dance","images":{"original":{"url":"https://media.giphy.com/abc.gif","width":"480","height":"320"}}}],"pagination":{"total_count":1,"count":1,"offset":0},"meta":{"status":200,"msg":"OK","response_id":"r1"}}`

// passThroughEnvelope verifies the raw Giphy response shape made it
// through the proxy unchanged — frontend's Grid expects exactly this.
func passThroughEnvelope(t *testing.T, raw []byte) {
	t.Helper()
	var out struct {
		Data       []map[string]any `json:"data"`
		Pagination map[string]any   `json:"pagination"`
		Meta       map[string]any   `json:"meta"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode: %v; body=%s", err, string(raw))
	}
	if len(out.Data) == 0 {
		t.Errorf("expected non-empty data, got %s", string(raw))
	}
	if out.Pagination == nil {
		t.Errorf("missing pagination envelope: %s", string(raw))
	}
	if out.Meta == nil {
		t.Errorf("missing meta envelope: %s", string(raw))
	}
}

func TestGiphy_Search_OK(t *testing.T) {
	var capturedQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			t.Errorf("path = %q, want /search", r.URL.Path)
		}
		capturedQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(sampleGiphyBody))
	}))
	defer srv.Close()

	g := newGiphyTestService("k-1", srv)
	out, err := g.Search(context.Background(), "cat", 25, 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	passThroughEnvelope(t, out)
	if !strings.Contains(string(out), "abc123") {
		t.Errorf("missing gif id in passthrough: %s", string(out))
	}
	if !strings.Contains(capturedQuery, "api_key=k-1") {
		t.Errorf("missing api key in upstream query: %s", capturedQuery)
	}
	if !strings.Contains(capturedQuery, "rating=g") {
		t.Errorf("expected rating=g, got %s", capturedQuery)
	}
}

func TestGiphy_Search_EmptyQuery_ShortCircuits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Errorf("upstream should not be called for empty query")
	}))
	defer srv.Close()

	g := newGiphyTestService("k-1", srv)
	out, err := g.Search(context.Background(), "", 25, 0)
	if err != nil {
		t.Fatalf("Search empty: %v", err)
	}
	// Synthetic empty envelope — the Grid will render "no results".
	var got struct {
		Data []any `json:"data"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Data) != 0 {
		t.Errorf("empty query returned %d items", len(got.Data))
	}
}

func TestGiphy_Trending_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/trending" {
			t.Errorf("path = %q, want /trending", r.URL.Path)
		}
		_, _ = w.Write([]byte(sampleGiphyBody))
	}))
	defer srv.Close()

	g := newGiphyTestService("k-1", srv)
	out, err := g.Trending(context.Background(), 25, 0)
	if err != nil {
		t.Fatalf("Trending: %v", err)
	}
	passThroughEnvelope(t, out)
}

func TestGiphy_NotConfigured(t *testing.T) {
	g := newGiphyTestService("", httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})))
	defer g.http.CloseIdleConnections()
	_, err := g.Search(context.Background(), "cat", 25, 0)
	if !errors.Is(err, ErrGiphyNotConfigured) {
		t.Fatalf("err = %v, want ErrGiphyNotConfigured", err)
	}
	_, err = g.Trending(context.Background(), 25, 0)
	if !errors.Is(err, ErrGiphyNotConfigured) {
		t.Fatalf("trending err = %v, want ErrGiphyNotConfigured", err)
	}
}

func TestGiphy_Upstream401_TreatedAsNotConfigured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	g := newGiphyTestService("bad-key", srv)
	_, err := g.Search(context.Background(), "cat", 25, 0)
	if !errors.Is(err, ErrGiphyNotConfigured) {
		t.Fatalf("err = %v, want ErrGiphyNotConfigured", err)
	}
}

func TestGiphy_Upstream500_PropagatesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`upstream busted`))
	}))
	defer srv.Close()

	g := newGiphyTestService("k-1", srv)
	_, err := g.Search(context.Background(), "cat", 25, 0)
	if err == nil {
		t.Fatal("expected error on 500")
	}
	if errors.Is(err, ErrGiphyNotConfigured) {
		t.Errorf("500 should not map to NotConfigured")
	}
}

func TestGiphy_LimitNormalisation(t *testing.T) {
	var captured string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"data":[],"meta":{"status":200,"msg":"OK","response_id":""},"pagination":{"total_count":0,"count":0,"offset":0}}`))
	}))
	defer srv.Close()

	g := newGiphyTestService("k-1", srv)
	if _, err := g.Search(context.Background(), "cat", 0, -5); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if !strings.Contains(captured, "limit=25") {
		t.Errorf("limit=0 should default to 25, got %s", captured)
	}
	if !strings.Contains(captured, "offset=0") {
		t.Errorf("negative offset should clamp to 0, got %s", captured)
	}

	if _, err := g.Search(context.Background(), "cat", 999, 0); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if !strings.Contains(captured, "limit=25") {
		t.Errorf("limit=999 should clamp to default 25, got %s", captured)
	}
}

func TestGiphy_ContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
			_, _ = w.Write([]byte(sampleGiphyBody))
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	g := newGiphyTestService("k-1", srv).WithHTTPClient(&http.Client{Timeout: 100 * time.Millisecond})
	_, err := g.Search(context.Background(), "cat", 25, 0)
	if err == nil {
		t.Fatal("expected timeout error")
	}
}
