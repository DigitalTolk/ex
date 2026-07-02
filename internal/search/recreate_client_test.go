package search

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestClient_BeginIndexRebuild_CreatesStagingWithMapping(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	var createBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		methods = append(methods, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodPut {
			b, _ := io.ReadAll(r.Body)
			createBody = string(b)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)

	staging, err := c.BeginIndexRebuild(context.Background(), IndexUsers)
	if err != nil {
		t.Fatalf("BeginIndexRebuild: %v", err)
	}
	if !strings.HasPrefix(staging, IndexUsers+"-r") || staging == IndexUsers {
		t.Fatalf("staging = %q, want a fresh %s-r<nanos> physical index", staging, IndexUsers)
	}
	// Exactly ONE call: the staging PUT. The live index is never deleted
	// here — that was the old delete-then-create window.
	if len(methods) != 1 || methods[0] != "PUT /"+staging {
		t.Fatalf("methods = %v, want only PUT /%s", methods, staging)
	}
	// The staging index carries the current autocomplete mapping (n-gram
	// infix analyzer + the raised max_ngram_diff it requires).
	if !strings.Contains(createBody, "autocomplete") || !strings.Contains(createBody, `"ngram"`) || !strings.Contains(createBody, "max_ngram_diff") {
		t.Fatalf("staging body missing n-gram autocomplete analyzer: %s", createBody)
	}
}

func TestClient_BeginIndexRebuild_UnknownIndex(t *testing.T) {
	c := NewClient("http://example.test")
	if _, err := c.BeginIndexRebuild(context.Background(), "ex_bogus"); err == nil {
		t.Fatal("expected error for unknown index name")
	}
}

func TestClient_BeginIndexRebuild_NilClient(t *testing.T) {
	var c *Client
	staging, err := c.BeginIndexRebuild(context.Background(), IndexUsers)
	if err != nil || staging != "" {
		t.Fatalf("nil client should no-op, got (%q, %v)", staging, err)
	}
	if err := c.PromoteIndex(context.Background(), IndexUsers, "x"); err != nil {
		t.Fatalf("nil client PromoteIndex should no-op, got %v", err)
	}
	c.AbortIndexRebuild(context.Background(), "x") // must not panic
}

func TestClient_BeginIndexRebuild_CreateErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.BeginIndexRebuild(context.Background(), IndexChannels); err == nil {
		t.Fatal("expected error when staging create returns 400")
	}
}

// promoteServer fakes the three cluster states PromoteIndex handles and
// records the request sequence + the _aliases action payload.
type promoteServer struct {
	mu          sync.Mutex
	calls       []string
	aliasedTo   string // physical index behind the alias ("" → no alias)
	legacyIndex bool   // HEAD /<name> answers 200 (real index, no alias)
	actionsBody string
	deleteFails bool
}

func (p *promoteServer) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.calls = append(p.calls, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/_alias/"):
			if p.aliasedTo == "" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			name := strings.TrimPrefix(r.URL.Path, "/_alias/")
			_ = json.NewEncoder(w).Encode(map[string]any{
				p.aliasedTo: map[string]any{"aliases": map[string]any{name: map[string]any{}}},
			})
		case r.Method == http.MethodHead:
			if p.legacyIndex {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusNotFound)
			}
		case r.Method == http.MethodPost && r.URL.Path == "/_aliases":
			b, _ := io.ReadAll(r.Body)
			p.actionsBody = string(b)
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodDelete:
			if p.deleteFails {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusTeapot)
		}
	}
}

func TestClient_PromoteIndex_LegacyIndex_AtomicRemoveIndex(t *testing.T) {
	// Pre-alias deployment: `ex_users` is a REAL index. The swap must be
	// one atomic _aliases call using remove_index — never a separate
	// DELETE that would open a no-index window.
	p := &promoteServer{legacyIndex: true}
	srv := httptest.NewServer(p.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL)

	if err := c.PromoteIndex(context.Background(), IndexUsers, IndexUsers+"-r42"); err != nil {
		t.Fatalf("PromoteIndex: %v", err)
	}
	if !strings.Contains(p.actionsBody, `"remove_index"`) ||
		!strings.Contains(p.actionsBody, `"`+IndexUsers+`-r42"`) ||
		!strings.Contains(p.actionsBody, `"alias":"`+IndexUsers+`"`) {
		t.Fatalf("_aliases body = %s, want atomic remove_index + add", p.actionsBody)
	}
	for _, call := range p.calls {
		if strings.HasPrefix(call, "DELETE ") {
			t.Fatalf("legacy promote must not issue a standalone DELETE (calls: %v)", p.calls)
		}
	}
}

func TestClient_PromoteIndex_AliasMove_SwapsThenDeletesOld(t *testing.T) {
	p := &promoteServer{aliasedTo: IndexUsers + "-r1"}
	srv := httptest.NewServer(p.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL)

	if err := c.PromoteIndex(context.Background(), IndexUsers, IndexUsers+"-r2"); err != nil {
		t.Fatalf("PromoteIndex: %v", err)
	}
	if !strings.Contains(p.actionsBody, `"remove"`) || !strings.Contains(p.actionsBody, IndexUsers+"-r1") {
		t.Fatalf("_aliases body = %s, want remove of the old backing", p.actionsBody)
	}
	// The retired physical index is deleted only AFTER the atomic swap.
	var swapAt, deleteAt int
	for i, call := range p.calls {
		if call == "POST /_aliases" {
			swapAt = i
		}
		if call == "DELETE /"+IndexUsers+"-r1" {
			deleteAt = i
		}
	}
	if deleteAt == 0 || deleteAt < swapAt {
		t.Fatalf("calls = %v, want the old index deleted after the alias swap", p.calls)
	}
}

func TestClient_PromoteIndex_FreshCluster_AddsAlias(t *testing.T) {
	p := &promoteServer{}
	srv := httptest.NewServer(p.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL)

	if err := c.PromoteIndex(context.Background(), IndexChannels, IndexChannels+"-r7"); err != nil {
		t.Fatalf("PromoteIndex: %v", err)
	}
	if strings.Contains(p.actionsBody, "remove") {
		t.Fatalf("_aliases body = %s, want a bare add on a fresh cluster", p.actionsBody)
	}
	if !strings.Contains(p.actionsBody, `"add"`) {
		t.Fatalf("_aliases body = %s, want an add action", p.actionsBody)
	}
}

func TestClient_PromoteIndex_OldDeleteFailureIsNotFatal(t *testing.T) {
	// The swap already succeeded; a failed cleanup of the retired index
	// must not fail the promote (it only orphans disk).
	p := &promoteServer{aliasedTo: IndexUsers + "-r1", deleteFails: true}
	srv := httptest.NewServer(p.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.PromoteIndex(context.Background(), IndexUsers, IndexUsers+"-r2"); err != nil {
		t.Fatalf("PromoteIndex must tolerate retired-index delete failure, got %v", err)
	}
}

func TestClient_PromoteIndex_ErrorBranches(t *testing.T) {
	t.Run("alias lookup 500", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		if err := NewClient(srv.URL).PromoteIndex(context.Background(), IndexUsers, "s"); err == nil {
			t.Fatal("expected alias-lookup error")
		}
	})
	t.Run("alias decode error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		}))
		defer srv.Close()
		if err := NewClient(srv.URL).PromoteIndex(context.Background(), IndexUsers, "s"); err == nil {
			t.Fatal("expected alias decode error")
		}
	})
	t.Run("head error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				w.WriteHeader(http.StatusNotFound) // no alias
				return
			}
			w.WriteHeader(http.StatusInternalServerError) // HEAD blows up
		}))
		defer srv.Close()
		if err := NewClient(srv.URL).PromoteIndex(context.Background(), IndexUsers, "s"); err == nil {
			t.Fatal("expected head error")
		}
	})
	t.Run("swap rejected", func(t *testing.T) {
		p := &promoteServer{legacyIndex: true}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			p.handler(t)(w, r)
		}))
		defer srv.Close()
		if err := NewClient(srv.URL).PromoteIndex(context.Background(), IndexUsers, "s"); err == nil {
			t.Fatal("expected swap error")
		}
	})
	t.Run("request build error", func(t *testing.T) {
		if err := badURLClient().PromoteIndex(context.Background(), IndexUsers, "s"); err == nil {
			t.Fatal("expected request-build error from aliasBacking")
		}
	})
	t.Run("transport error", func(t *testing.T) {
		c := NewClient("http://127.0.0.1:1")
		if err := c.PromoteIndex(context.Background(), IndexUsers, "s"); err == nil {
			t.Fatal("expected transport error from aliasBacking")
		}
	})
}

func TestClient_AbortIndexRebuild(t *testing.T) {
	var mu sync.Mutex
	var deletes []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodDelete {
			deletes = append(deletes, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)

	c.AbortIndexRebuild(context.Background(), IndexUsers+"-r9")
	if len(deletes) != 1 || deletes[0] != "/"+IndexUsers+"-r9" {
		t.Fatalf("deletes = %v, want the staging index dropped", deletes)
	}
	// Empty staging and delete failures are silent no-ops — the live
	// index was never touched.
	c.AbortIndexRebuild(context.Background(), "")
	NewClient("http://127.0.0.1:1").AbortIndexRebuild(context.Background(), "ex_users-r9")
	if len(deletes) != 1 {
		t.Fatalf("deletes = %v, want no additional calls", deletes)
	}
}
