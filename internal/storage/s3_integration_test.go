//go:build integration

package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// A single MinIO container (a real, S3-compatible object store) is shared by
// every test in this package. This replaces the previous fakeSigner mock so the
// storage layer — presigned PUT/GET, range reads, content types — is exercised
// against a genuine object store rather than an in-memory stand-in.
var (
	minioEndpoint string
	minioReady    bool
)

const (
	minioUser = "minioadmin"
	minioPass = "minioadmin"
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	req := testcontainers.ContainerRequest{
		Image:        "minio/minio:latest",
		ExposedPorts: []string{"9000/tcp"},
		Env:          map[string]string{"MINIO_ROOT_USER": minioUser, "MINIO_ROOT_PASSWORD": minioPass},
		Cmd:          []string{"server", "/data"},
		WaitingFor:   wait.ForHTTP("/minio/health/live").WithPort("9000/tcp").WithStartupTimeout(60 * time.Second),
	}
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		// No Docker available — let individual tests skip themselves.
		log.Printf("storage integration tests will skip: docker unavailable: %v", err)
		os.Exit(m.Run())
	}

	if host, herr := container.Host(ctx); herr == nil {
		if port, perr := container.MappedPort(ctx, "9000"); perr == nil {
			minioEndpoint = fmt.Sprintf("http://%s:%s", host, port.Port())
			minioReady = true
		}
	}

	code := m.Run()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

// newMinioS3 builds a real S3Client pointed at the shared MinIO container and
// backed by a freshly-created bucket. Skips when Docker isn't available.
func newMinioS3(t *testing.T, bucket string) *S3Client {
	t.Helper()
	if !minioReady {
		t.Skip("skipping: Docker / MinIO not available")
	}
	c, err := NewS3Client(context.Background(), S3Config{
		Endpoint:  minioEndpoint,
		Bucket:    bucket,
		AccessKey: minioUser,
		SecretKey: minioPass,
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client against MinIO: %v", err)
	}
	return c
}

func TestS3Client_PutGetRoundTrip_RealObjectStore(t *testing.T) {
	c := newMinioS3(t, "round-trip")
	ctx := context.Background()
	key := "attachments/it-roundtrip"
	payload := []byte("hello real object store")

	if err := c.PutObject(ctx, key, "text/plain", payload); err != nil {
		t.Fatalf("PutObject: %v", err)
	}

	body, ct, size, _, err := c.GetObject(ctx, key)
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	defer func() { _ = body.Close() }()
	got, _ := io.ReadAll(body)
	if string(got) != string(payload) {
		t.Fatalf("GetObject body = %q, want %q", got, payload)
	}
	if ct != "text/plain" {
		t.Errorf("content-type = %q, want text/plain", ct)
	}
	if size != int64(len(payload)) {
		t.Errorf("size = %d, want %d", size, len(payload))
	}

	// Range read returns only the requested prefix (used for lazy backfill).
	head, err := c.GetObjectRange(ctx, key, 5)
	if err != nil {
		t.Fatalf("GetObjectRange: %v", err)
	}
	if !bytes.HasPrefix(payload, head) || len(head) != 5 {
		t.Fatalf("GetObjectRange = %q, want prefix of length 5", head)
	}
}

func TestS3Client_PresignedPutThenGet_OverRealHTTP(t *testing.T) {
	c := newMinioS3(t, "presign")
	ctx := context.Background()
	key := "attachments/it-presigned"
	payload := []byte("uploaded via a presigned PUT, fetched via a presigned GET")

	// Upload exactly the way the browser does: a presigned PUT over real HTTP.
	putURL, err := c.PresignedPutURL(ctx, key, "application/octet-stream", time.Minute)
	if err != nil {
		t.Fatalf("PresignedPutURL: %v", err)
	}
	putReq, _ := http.NewRequestWithContext(ctx, http.MethodPut, putURL, bytes.NewReader(payload))
	putReq.Header.Set("Content-Type", "application/octet-stream")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatalf("presigned PUT: %v", err)
	}
	_ = putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("presigned PUT status = %d, want 200", putResp.StatusCode)
	}

	// Download via a presigned GET over real HTTP — the path the media handler
	// (and the browser) actually use.
	getURL, err := c.PresignedGetURL(ctx, key, time.Minute)
	if err != nil {
		t.Fatalf("PresignedGetURL: %v", err)
	}
	getResp, err := http.Get(getURL) //nolint:gosec,noctx // test-only presigned URL fetch
	if err != nil {
		t.Fatalf("presigned GET: %v", err)
	}
	defer func() { _ = getResp.Body.Close() }()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("presigned GET status = %d, want 200", getResp.StatusCode)
	}
	fetched, _ := io.ReadAll(getResp.Body)
	if string(fetched) != string(payload) {
		t.Fatalf("presigned GET body = %q, want %q", fetched, payload)
	}
}
