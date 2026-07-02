package search

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestClient_RecreateIndex_DeletesThenCreatesWithMapping(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	var createBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		methods = append(methods, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodDelete:
			// Simulate "already gone" — recreate must treat 404 as OK.
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			createBody = string(b)
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)

	if err := c.RecreateIndex(context.Background(), IndexUsers); err != nil {
		t.Fatalf("RecreateIndex: %v", err)
	}
	if len(methods) != 2 ||
		methods[0] != "DELETE /"+IndexUsers ||
		methods[1] != "PUT /"+IndexUsers {
		t.Fatalf("methods = %v, want DELETE then PUT on /%s", methods, IndexUsers)
	}
	// The recreate PUT carries the current autocomplete mapping (n-gram infix
	// analyzer + the raised max_ngram_diff it requires).
	if !strings.Contains(createBody, "autocomplete") || !strings.Contains(createBody, `"ngram"`) || !strings.Contains(createBody, "max_ngram_diff") {
		t.Fatalf("recreate body missing n-gram autocomplete analyzer: %s", createBody)
	}
}

func TestClient_RecreateIndex_UnknownIndex(t *testing.T) {
	c := NewClient("http://example.test")
	if err := c.RecreateIndex(context.Background(), "ex_bogus"); err == nil {
		t.Fatal("expected error for unknown index name")
	}
}

func TestClient_RecreateIndex_NilClient(t *testing.T) {
	var c *Client
	if err := c.RecreateIndex(context.Background(), IndexUsers); err != nil {
		t.Fatalf("nil client should no-op, got %v", err)
	}
}

func TestClient_RecreateIndex_DeleteErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.RecreateIndex(context.Background(), IndexUsers); err == nil {
		t.Fatal("expected error when delete returns 500")
	}
}

func TestClient_RecreateIndex_RequestBuildError(t *testing.T) {
	// badURLClient's control-char host fails http.NewRequestWithContext
	// inside deleteIndex before any transport call.
	if err := badURLClient().RecreateIndex(context.Background(), IndexUsers); err == nil {
		t.Fatal("expected request-build error from deleteIndex")
	}
}

func TestClient_RecreateIndex_TransportDeleteError(t *testing.T) {
	// A valid request against a closed port fails at the transport Do
	// call inside deleteIndex.
	c := NewClient("http://127.0.0.1:1")
	if err := c.RecreateIndex(context.Background(), IndexUsers); err == nil {
		t.Fatal("expected transport Do error from deleteIndex")
	}
}

func TestClient_RecreateIndex_CreateErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK) // DELETE ok
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if err := c.RecreateIndex(context.Background(), IndexChannels); err == nil {
		t.Fatal("expected error when create returns 400")
	}
}

