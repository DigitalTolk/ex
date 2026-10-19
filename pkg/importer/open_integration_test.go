//go:build integration

package importer

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// s3Stub accepts every S3 request (the client creates its bucket on start).
func s3Stub(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestNewRequiresDB(t *testing.T) {
	if _, err := New(Deps{}); err == nil {
		t.Fatal("want error without DB")
	}
	im, err := New(Deps{DB: &store.DB{}})
	mustNoErr(t, err)
	if _, ok := im.indexer.(search.NoopIndexer); !ok {
		t.Fatalf("default indexer = %T, want NoopIndexer", im.indexer)
	}
	mustNoErr(t, im.Close())
}

func TestOpen(t *testing.T) {
	if !redisReady {
		t.Skip("skipping: Redis not available")
	}
	ctx := context.Background()
	s3 := s3Stub(t)
	base := Options{AWSRegion: "us-east-1", DynamoDBTable: "t", DynamoDBEndpoint: "http://127.0.0.1:1", S3Bucket: "b", S3Endpoint: s3, S3AccessKey: "k", S3SecretKey: "s"}

	if _, err := Open(ctx, Options{DynamoDBTable: "t"}); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("missing bucket: %v", err)
	}

	// Minimal: no search, no cache; S3 region falls back to the AWS region.
	im, err := Open(ctx, base)
	mustNoErr(t, err)
	if im.search != nil || im.cache != nil || im.objects == nil {
		t.Fatalf("optional integrations should be off: %+v", im)
	}
	mustNoErr(t, im.Close())

	// Everything on.
	full := base
	full.S3Region = "eu-west-1"
	full.OpenSearchURL = "http://127.0.0.1:1"
	full.RedisURL = "redis://" + redisAddr
	im, err = Open(ctx, full)
	mustNoErr(t, err)
	if im.search == nil || im.cache == nil {
		t.Fatalf("search and cache should be on")
	}
	if _, ok := im.indexer.(*search.LiveIndexer); !ok {
		t.Fatalf("indexer = %T, want LiveIndexer", im.indexer)
	}
	mustNoErr(t, im.Close())

	bad := full
	bad.RedisURL = "://not-a-url"
	if _, err := Open(ctx, bad); err == nil || !strings.Contains(err.Error(), "redis") {
		t.Fatalf("bad redis: %v", err)
	}
}

func TestOpenConstructorErrors(t *testing.T) {
	ctx := context.Background()
	opts := Options{DynamoDBTable: "t", S3Bucket: "b", OpenSearchURL: "http://x"}
	boom := errors.New("boom")

	origDB, origS3, origSearch, origCache := newDB, newS3, newSearch, newCache
	t.Cleanup(func() { newDB, newS3, newSearch, newCache = origDB, origS3, origSearch, origCache })

	newDB = func(context.Context, store.DBConfig) (*store.DB, error) { return nil, boom }
	if _, err := Open(ctx, opts); !errors.Is(err, boom) || !strings.Contains(err.Error(), "dynamodb") {
		t.Fatalf("db: %v", err)
	}
	newDB = func(context.Context, store.DBConfig) (*store.DB, error) { return &store.DB{}, nil }
	newS3 = func(context.Context, storage.S3Config) (*storage.S3Client, error) { return nil, boom }
	if _, err := Open(ctx, opts); !errors.Is(err, boom) || !strings.Contains(err.Error(), "s3") {
		t.Fatalf("s3: %v", err)
	}
	newS3 = func(context.Context, storage.S3Config) (*storage.S3Client, error) { return &storage.S3Client{}, nil }
	newSearch = func(context.Context, search.ClientConfig) (*search.Client, error) { return nil, boom }
	if _, err := Open(ctx, opts); !errors.Is(err, boom) || !strings.Contains(err.Error(), "opensearch") {
		t.Fatalf("search: %v", err)
	}
	newSearch = origSearch
	opts.RedisURL = "redis://x"
	newCache = func(string) (*cache.RedisCache, error) { return nil, boom }
	if _, err := Open(ctx, opts); !errors.Is(err, boom) {
		t.Fatalf("cache: %v", err)
	}
}
