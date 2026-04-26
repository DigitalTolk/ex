package storage

import (
	"context"
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
