package search

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// badURLClient builds a client whose baseURL contains an invalid control
// character, so every http.NewRequestWithContext fails at URL-parse time —
// exercising the request-construction error branch of each method.
func badURLClient() *Client {
	return &Client{
		baseURL: "http://bad\x7fhost",
		http:    http.DefaultClient,
	}
}

func TestClient_NewRequestErrors(t *testing.T) {
	c := badURLClient()
	ctx := context.Background()

	if _, err := c.indexExists(ctx, "idx"); err == nil {
		t.Error("indexExists: expected request-build error")
	}
	if _, err := c.GetDoc(ctx, "idx", "id"); err == nil {
		t.Error("GetDoc: expected request-build error")
	}
	if err := c.DeleteDoc(ctx, "idx", "id"); err == nil {
		t.Error("DeleteDoc: expected request-build error")
	}
	if err := c.IndexDoc(ctx, "idx", "id", map[string]any{"x": 1}); err == nil {
		t.Error("IndexDoc(do): expected request-build error")
	}
	if _, err := c.Search(ctx, "idx", map[string]any{}); err == nil {
		t.Error("Search: expected request-build error")
	}
	if err := c.Bulk(ctx, "idx", []BulkEntry{{ID: "1", Doc: map[string]any{"x": 1}}}); err == nil {
		t.Error("Bulk: expected request-build error")
	}
	if _, err := c.ClusterHealth(ctx); err == nil {
		t.Error("ClusterHealth(do): expected request-build error")
	}
}

// NewAWSClient wraps the SDK's config loader through the loadAWSConfig
// seam; when the loader errors, the error is wrapped and returned.
func TestNewAWSClient_ConfigLoadError(t *testing.T) {
	orig := loadAWSConfig
	t.Cleanup(func() { loadAWSConfig = orig })
	loadAWSConfig = func(context.Context, ...func(*awsconfig.LoadOptions) error) (aws.Config, error) {
		return aws.Config{}, errors.New("config boom")
	}
	if _, err := NewAWSClient(context.Background(), "https://example.test", AWSSigning{Region: "us-east-1"}); err == nil {
		t.Fatal("expected config-load error")
	}
}

// unmarshalable is a value json.Marshal/Encode cannot serialize, used to
// drive the marshal-error branches.
func unmarshalable() any { return make(chan int) }

func TestClient_MarshalErrors(t *testing.T) {
	c := NewClient("http://127.0.0.1:1")
	ctx := context.Background()

	if err := c.IndexDoc(ctx, "idx", "id", unmarshalable()); err == nil {
		t.Error("IndexDoc: expected marshal error")
	}
	if _, err := c.Search(ctx, "idx", unmarshalable()); err == nil {
		t.Error("Search: expected marshal error")
	}
	// Bulk encodes each entry's Doc; an unmarshalable Doc fails the
	// per-doc encode branch.
	if err := c.Bulk(ctx, "idx", []BulkEntry{{ID: "1", Doc: unmarshalable()}}); err == nil {
		t.Error("Bulk: expected doc-encode error")
	}
}

// Bulk with a valid request against a closed port fails at the transport
// Do call (not at request-build or encode), covering that error branch.
func TestClient_BulkDoError(t *testing.T) {
	c := NewClient("http://127.0.0.1:1")
	if err := c.Bulk(context.Background(), "idx", []BulkEntry{{ID: "1", Doc: map[string]any{"x": 1}}}); err == nil {
		t.Error("Bulk: expected transport Do error")
	}
}

// errReadCloser fails on Read so a request body cannot be drained — used
// to drive the hashAndResetBody read-error path inside RoundTrip.
type errReadCloser struct{}

func (errReadCloser) Read([]byte) (int, error) { return 0, errors.New("read boom") }
func (errReadCloser) Close() error             { return nil }

func TestSigV4Transport_HashBodyError(t *testing.T) {
	tr := &sigV4Transport{
		inner:   http.DefaultTransport,
		signer:  v4.NewSigner(),
		creds:   staticCreds{},
		region:  "us-east-1",
		service: "es",
	}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://example.test/_search", nil)
	req.Body = errReadCloser{}
	if _, err := tr.RoundTrip(req); err == nil {
		t.Fatal("expected hash-body read error")
	}
}

// hashAndResetBody with a nil body returns the constant empty hash and
// leaves GetBody set on the request; an empty-string body reader covers
// the non-nil read + reset + GetBody path (line setting req.GetBody).
func TestHashAndResetBody_Reset(t *testing.T) {
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://example.test/x", strings.NewReader("payload"))
	hash, err := hashAndResetBody(req)
	if err != nil {
		t.Fatalf("hashAndResetBody: %v", err)
	}
	if hash == emptyPayloadHash {
		t.Error("expected a content hash for a non-empty body")
	}
	if req.GetBody == nil {
		t.Fatal("expected GetBody to be reseated")
	}
	rc, err := req.GetBody()
	if err != nil {
		t.Fatalf("GetBody: %v", err)
	}
	b, _ := io.ReadAll(rc)
	if string(b) != "payload" {
		t.Errorf("reseated body = %q, want %q", b, "payload")
	}
}

