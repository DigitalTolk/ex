package search

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/opensearch-project/opensearch-go/v5/opensearchapi"
)

// fakeAWSConfig swaps the SDK config loader for one that honours the
// options the client passes (the region) and returns the given credentials,
// so signing tests are hermetic (no env-var lookup, no IMDS calls).
func fakeAWSConfig(t *testing.T, creds aws.CredentialsProvider) {
	t.Helper()
	orig := loadAWSConfig
	t.Cleanup(func() { loadAWSConfig = orig })
	loadAWSConfig = func(_ context.Context, optFns ...func(*awsconfig.LoadOptions) error) (aws.Config, error) {
		var o awsconfig.LoadOptions
		for _, fn := range optFns {
			_ = fn(&o)
		}
		return aws.Config{Region: o.Region, Credentials: creds}, nil
	}
}

func staticCreds() aws.CredentialsProvider {
	return credentials.NewStaticCredentialsProvider("AKIATESTACCESS", "secretkeydonotuse", "")
}

// headerRecorder is an httptest cluster that answers every request with an
// empty JSON object and remembers the last request's Authorization header.
func headerRecorder(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var authz string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &authz
}

// NewClientFromConfig is the single constructor the server and the
// migrate CLI share; it must pick SigV4 signing when a region is set and
// a plain client otherwise, degrading to nil on an empty URL.
func TestNewClientFromConfig(t *testing.T) {
	ctx := context.Background()

	t.Run("plain when no region", func(t *testing.T) {
		srv, authz := headerRecorder(t)
		c, err := NewClientFromConfig(ctx, ClientConfig{URL: srv.URL + "/"})
		if err != nil {
			t.Fatalf("NewClientFromConfig: %v", err)
		}
		if c == nil {
			t.Fatal("expected a client for a configured URL")
		}
		if _, err := c.ClusterHealth(ctx); err != nil {
			t.Fatalf("ClusterHealth: %v", err)
		}
		if *authz != "" {
			t.Errorf("Authorization = %q; a plain client must not sign requests", *authz)
		}
	})

	t.Run("nil when no URL", func(t *testing.T) {
		c, err := NewClientFromConfig(ctx, ClientConfig{})
		if err != nil || c != nil {
			t.Fatalf("got (%v, %v), want (nil, nil) so callers degrade to no-ops", c, err)
		}
	})

	t.Run("sigv4 when region set", func(t *testing.T) {
		fakeAWSConfig(t, staticCreds())
		srv, authz := headerRecorder(t)
		c, err := NewClientFromConfig(ctx, ClientConfig{
			URL: srv.URL, AWSRegion: "eu-west-1", AWSService: "aoss",
		})
		if err != nil {
			t.Fatalf("NewClientFromConfig: %v", err)
		}
		if _, err := c.ClusterHealth(ctx); err != nil {
			t.Fatalf("ClusterHealth: %v", err)
		}
		if !strings.Contains(*authz, "/eu-west-1/aoss/aws4_request") {
			t.Errorf("Authorization = %q, want a eu-west-1/aoss SigV4 scope", *authz)
		}
	})

	t.Run("aws config load error propagates", func(t *testing.T) {
		orig := loadAWSConfig
		t.Cleanup(func() { loadAWSConfig = orig })
		loadAWSConfig = func(context.Context, ...func(*awsconfig.LoadOptions) error) (aws.Config, error) {
			return aws.Config{}, errors.New("config boom")
		}
		if _, err := NewClientFromConfig(ctx, ClientConfig{URL: "https://es.example.test", AWSRegion: "eu-west-1"}); err == nil {
			t.Fatal("expected config-load error")
		}
	})

	t.Run("malformed URL is an error", func(t *testing.T) {
		if _, err := NewClientFromConfig(ctx, ClientConfig{URL: "http://bad\x7fhost"}); err == nil {
			t.Fatal("expected a URL parse error")
		}
	})
}

// NewClient has no error return: a malformed URL disables search (nil
// client, logged) rather than handing back a client that can't work.
func TestNewClient_MalformedURLDisablesSearch(t *testing.T) {
	if c := NewClient("http://bad\x7fhost"); c != nil {
		t.Fatalf("NewClient = %v, want nil for a malformed URL", c)
	}
}

// The client talks to the one URL it was given. The library's default router
// would discover the cluster's nodes, send requests straight to them and
// health-check them; a managed endpoint's nodes can't be reached that way.
func TestNewClient_RunsWithoutTheDefaultRouter(t *testing.T) {
	t.Setenv(routerEnv, "")
	if err := os.Unsetenv(routerEnv); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"green"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	if got := os.Getenv(routerEnv); got != "false" {
		t.Fatalf("%s = %q, want false", routerEnv, got)
	}
	for range 2 {
		if _, err := c.ClusterHealth(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if want := []string{"GET /_cluster/health", "GET /_cluster/health"}; !slices.Equal(seen, want) {
		t.Fatalf("requests = %q, want only %q", seen, want)
	}
}

// An operator who chose a router keeps their choice.
func TestNewClient_KeepsAnOperatorsRouterChoice(t *testing.T) {
	t.Setenv(routerEnv, "true")
	if NewClient("http://example.test") == nil {
		t.Fatal("no client")
	}
	if got := os.Getenv(routerEnv); got != "true" {
		t.Fatalf("%s = %q, want the operator's true", routerEnv, got)
	}
}

// The client constructor's error contract is honoured even though the
// configuration built here cannot trip it.
func TestNewClient_ClientBuildError(t *testing.T) {
	orig := newAPIClient
	t.Cleanup(func() { newAPIClient = orig })
	newAPIClient = func(opensearchapi.Config) (*opensearchapi.Client, error) {
		return nil, errors.New("client boom")
	}
	if c := NewClient("http://example.test"); c != nil {
		t.Fatalf("NewClient = %v, want nil when the client can't be built", c)
	}
	if _, err := NewClientFromConfig(context.Background(), ClientConfig{URL: "http://example.test"}); err == nil || !strings.Contains(err.Error(), "client boom") {
		t.Fatalf("NewClientFromConfig error = %v, want the client error", err)
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

// failingCreds always errors on Retrieve.
type failingCreds struct{}

func (failingCreds) Retrieve(context.Context) (aws.Credentials, error) {
	return aws.Credentials{}, errors.New("no creds")
}

// A request that cannot be signed is never sent unsigned: it fails.
func TestNewAWSClient_SigningFailureFailsTheRequest(t *testing.T) {
	fakeAWSConfig(t, failingCreds{})
	sent := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		sent = true
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c, err := NewAWSClient(context.Background(), srv.URL, AWSSigning{Region: "us-east-1"})
	if err != nil {
		t.Fatalf("NewAWSClient: %v", err)
	}
	if _, err := c.ClusterHealth(context.Background()); err == nil {
		t.Fatal("expected a signing error")
	}
	if sent {
		t.Error("an unsigned request reached the cluster")
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
	// per-doc encode branch before anything is sent.
	if err := c.Bulk(ctx, "idx", []BulkEntry{{ID: "1", Doc: unmarshalable()}}); err == nil {
		t.Error("Bulk: expected doc-encode error")
	}
}

// Bulk with a valid request against a closed port fails at the transport
// (after its retries), not at encode — the request-level failure arm.
func TestClient_BulkDoError(t *testing.T) {
	noRetryDelay(t)
	c := NewClient("http://127.0.0.1:1")
	if err := c.Bulk(context.Background(), "idx", []BulkEntry{{ID: "1", Doc: map[string]any{"x": 1}}}); err == nil {
		t.Error("Bulk: expected transport error")
	}
}

// Concurrent requests to the one endpoint reuse pooled connections. With
// net/http's default of 2 idle connections per host, every round after the
// first would open most of its connections afresh (a TCP/TLS handshake each).
func TestClient_ConcurrentRequestsReuseConnections(t *testing.T) {
	const parallel, rounds = 8, 3
	var (
		mu      sync.Mutex
		opened  int
		waiting int
		release = make(chan struct{})
	)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hold each request until the whole round is in flight, so every
		// round needs `parallel` connections at once.
		mu.Lock()
		round := release
		if waiting++; waiting == parallel {
			waiting = 0
			close(release)
			release = make(chan struct{})
		}
		mu.Unlock()
		select {
		case <-round:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"status":"green"}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			mu.Lock()
			opened++
			mu.Unlock()
		}
	}
	srv.Start()
	defer srv.Close()

	c := NewClient(srv.URL)
	for range rounds {
		var wg sync.WaitGroup
		for range parallel {
			wg.Go(func() {
				if _, err := c.ClusterHealth(context.Background()); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
	}
	mu.Lock()
	defer mu.Unlock()
	if opened != parallel {
		t.Fatalf("%d rounds of %d concurrent requests opened %d connections, want %d", rounds, parallel, opened, parallel)
	}
}
