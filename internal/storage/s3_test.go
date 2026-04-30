package storage

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestS3Config(t *testing.T) {
	cfg := S3Config{
		Endpoint:       "http://minio:9000",
		PublicEndpoint: "http://localhost:9000",
		Bucket:         "test-bucket",
		AccessKey:      "test",
		SecretKey:      "test",
		Region:         "us-east-1",
	}
	if cfg.Endpoint != "http://minio:9000" {
		t.Errorf("Endpoint = %q", cfg.Endpoint)
	}
	if cfg.PublicEndpoint != "http://localhost:9000" {
		t.Errorf("PublicEndpoint = %q", cfg.PublicEndpoint)
	}
	if cfg.Bucket != "test-bucket" {
		t.Errorf("Bucket = %q", cfg.Bucket)
	}
}

// TestNewS3Client verifies the constructor accepts config and returns a client.
func TestNewS3Client(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	client, err := NewS3Client(ctx, S3Config{
		Endpoint:  "http://127.0.0.1:1",
		Bucket:    "test",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client should not fail on unreachable endpoint: %v", err)
	}
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if client.bucket != "test" {
		t.Errorf("bucket = %q, want %q", client.bucket, "test")
	}
}

// TestNewS3Client_PublicEndpoint verifies that a different public endpoint
// is used by the presigner.
func TestNewS3Client_PublicEndpoint(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	client, err := NewS3Client(ctx, S3Config{
		Endpoint:       "http://internal:9000",
		PublicEndpoint: "http://localhost:9000",
		Bucket:         "test",
		AccessKey:      "test",
		SecretKey:      "test",
		Region:         "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}

	url, err := client.PresignedGetURL(ctx, "some-key", time.Hour)
	if err != nil {
		t.Fatalf("PresignedGetURL: %v", err)
	}
	if !strings.Contains(url, "localhost:9000") {
		t.Errorf("URL should use public endpoint (localhost:9000), got: %s", url)
	}
	if strings.Contains(url, "internal:9000") {
		t.Errorf("URL should NOT use internal endpoint, got: %s", url)
	}
}

func TestS3Client_PresignedGetURL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	client, err := NewS3Client(ctx, S3Config{
		Endpoint:  "http://127.0.0.1:1",
		Bucket:    "test",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}

	url, err := client.PresignedGetURL(ctx, "some-key", 1*time.Hour)
	if err != nil {
		t.Fatalf("PresignedGetURL: %v", err)
	}
	if !strings.Contains(url, "some-key") {
		t.Errorf("URL should contain key: %s", url)
	}
}

func TestS3Client_PresignedDownloadURL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	client, err := NewS3Client(ctx, S3Config{
		Endpoint:  "http://127.0.0.1:1",
		Bucket:    "test",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}

	url, err := client.PresignedDownloadURL(ctx, "some-key", `My "Report" 中文.pdf`, 1*time.Hour)
	if err != nil {
		t.Fatalf("PresignedDownloadURL: %v", err)
	}
	// The presigner percent-encodes the response-content-disposition
	// query value, so we look for the encoded form.
	if !strings.Contains(strings.ToLower(url), "response-content-disposition=") {
		t.Errorf("URL should override response-content-disposition: %s", url)
	}
	if !strings.Contains(strings.ToLower(url), "attachment") {
		t.Errorf("URL should mark response as attachment: %s", url)
	}
}

func TestContentDispositionAttachment(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty filename collapses to bare attachment", "", "attachment"},
		{
			"ASCII filename quoted as-is and echoed in filename*",
			"report.pdf",
			`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		},
		{
			"quotes in filename get sanitized in the ASCII fallback",
			`a"b.txt`,
			`attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`,
		},
		{
			"non-ASCII runes get scrubbed for ASCII fallback and percent-encoded for filename*",
			"héllo.txt",
			`attachment; filename="h_llo.txt"; filename*=UTF-8''h%C3%A9llo.txt`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := contentDispositionAttachment(tc.in)
			if got != tc.want {
				t.Errorf("contentDispositionAttachment(%q)\n got: %q\nwant: %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestS3Client_PresignedPutURL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	client, err := NewS3Client(ctx, S3Config{
		Endpoint:  "http://127.0.0.1:1",
		Bucket:    "test",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}

	url, err := client.PresignedPutURL(ctx, "upload-key", "image/png", 10*time.Minute)
	if err != nil {
		t.Fatalf("PresignedPutURL: %v", err)
	}
	if !strings.Contains(url, "upload-key") {
		t.Errorf("URL should contain key: %s", url)
	}
}

// TestS3Client_DeleteObject_Success covers the happy-path GC call used
// when the last attachment reference is dropped. We point the client at
// an httptest server that records the inbound request and responds with
// the empty 204 the AWS SDK accepts as success.
func TestS3Client_DeleteObject_Success(t *testing.T) {
	type req struct {
		method string
		path   string
	}
	got := make(chan req, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- req{method: r.Method, path: r.URL.Path}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	ctx := context.Background()
	client, err := NewS3Client(ctx, S3Config{
		Endpoint:  srv.URL,
		Bucket:    "bucket",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}

	// Drain the CreateBucket call the constructor fires.
	<-got

	if err := client.DeleteObject(ctx, "uploads/abc"); err != nil {
		t.Fatalf("DeleteObject: %v", err)
	}
	r := <-got
	if r.method != http.MethodDelete {
		t.Errorf("method = %s, want DELETE", r.method)
	}
	if !strings.Contains(r.path, "uploads/abc") {
		t.Errorf("path = %q, want it to include uploads/abc", r.path)
	}
}

// TestS3Client_DeleteObject_ServerError covers the wrap-and-return
// branch: a 500 from S3 must surface as a "s3: delete object" error.
func TestS3Client_DeleteObject_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Let the bootstrap CreateBucket succeed (PUT) but fail any DELETE.
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx := context.Background()
	client, err := NewS3Client(ctx, S3Config{
		Endpoint:  srv.URL,
		Bucket:    "bucket",
		AccessKey: "test",
		SecretKey: "test",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}
	err = client.DeleteObject(ctx, "uploads/explode")
	if err == nil {
		t.Fatal("expected error from 500 response")
	}
	if !strings.Contains(err.Error(), "s3: delete object") {
		t.Errorf("error should be wrapped: %v", err)
	}
}
