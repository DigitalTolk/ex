package search

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// unreachable points the client at a closed port so every request fails
// at the transport layer, exercising each method's request-error branch.
func TestClient_Unreachable_AllMethods(t *testing.T) {
	c := NewClient("http://127.0.0.1:1")
	ctx := context.Background()

	if _, err := c.indexExists(ctx, "idx"); err == nil {
		t.Error("indexExists: expected error")
	}
	if _, err := c.GetDoc(ctx, "idx", "id"); err == nil {
		t.Error("GetDoc: expected error")
	}
	if err := c.IndexDoc(ctx, "idx", "id", map[string]any{"x": 1}); err == nil {
		t.Error("IndexDoc: expected error")
	}
	if err := c.DeleteDoc(ctx, "idx", "id"); err == nil {
		t.Error("DeleteDoc: expected error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected error")
	}
	if _, err := c.ClusterHealth(ctx); err == nil {
		t.Error("ClusterHealth: expected error")
	}
}

// decodeError returns 200 with a non-JSON body so the response-decode
// branch of the read methods is exercised.
func TestClient_DecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{not json"))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	ctx := context.Background()

	if _, err := c.GetDoc(ctx, "idx", "id"); err == nil {
		t.Error("GetDoc: expected decode error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected decode error")
	}
	if _, err := c.ClusterHealth(ctx); err == nil {
		t.Error("ClusterHealth: expected decode error")
	}
}

// serverError returns 500 so the unexpected-status branches fire.
func TestClient_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	ctx := context.Background()

	if err := c.IndexDoc(ctx, "idx", "id", map[string]any{"x": 1}); err == nil {
		t.Error("IndexDoc: expected status error")
	}
	if err := c.DeleteDoc(ctx, "idx", "id"); err == nil {
		t.Error("DeleteDoc: expected status error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected status error")
	}
}

// failingCreds always errors on Retrieve.
type failingCreds struct{}

func (failingCreds) Retrieve(context.Context) (aws.Credentials, error) {
	return aws.Credentials{}, errCredsBoom
}

var errCredsBoom = errors.New("no creds")

// staticCreds returns fixed credentials so signing succeeds.
type staticCreds struct{}

func (staticCreds) Retrieve(context.Context) (aws.Credentials, error) {
	return aws.Credentials{AccessKeyID: "AK", SecretAccessKey: "SK", Source: "test"}, nil
}

func TestSigV4Transport_RoundTrip(t *testing.T) {
	ctx := context.Background()

	// Credentials retrieval failure short-circuits before the inner call.
	failT := &sigV4Transport{
		inner:   http.DefaultTransport,
		signer:  v4.NewSigner(),
		creds:   failingCreds{},
		region:  "us-east-1",
		service: "es",
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://example.test/_search", strings.NewReader(`{"q":1}`))
	if _, err := failT.RoundTrip(req); err == nil {
		t.Fatal("expected credentials retrieval error")
	}

	// Happy path: body is hashed/reset, request is signed, inner transport runs.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Amz-Content-Sha256") == "" {
			t.Error("expected signed content hash header")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	okT := &sigV4Transport{
		inner:   http.DefaultTransport,
		signer:  v4.NewSigner(),
		creds:   staticCreds{},
		region:  "us-east-1",
		service: "es",
	}
	req2, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL, strings.NewReader(`{"q":1}`))
	resp, err := okT.RoundTrip(req2)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	_ = resp.Body.Close()
}
