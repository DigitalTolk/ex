package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestS3(t *testing.T, h http.HandlerFunc) *S3Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := NewS3Client(context.Background(), S3Config{Endpoint: srv.URL, Bucket: "bucket", AccessKey: "k", SecretKey: "s", Region: "us-east-1"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestS3Client_PutChecksummedObject(t *testing.T) {
	payload := []byte("hello attachment")
	sum := sha256.Sum256(payload)
	var gotChecksum, gotType, gotLen string
	var gotBody []byte
	c := newTestS3(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.Contains(r.URL.Path, "attachments/a1") {
			gotChecksum = r.Header.Get("X-Amz-Checksum-Sha256")
			gotType = r.Header.Get("Content-Type")
			gotLen = r.Header.Get("Content-Length")
			gotBody, _ = io.ReadAll(r.Body)
			w.Header().Set("ETag", `"etag-1"`)
		}
		w.WriteHeader(http.StatusOK)
	})
	etag, err := c.PutChecksummedObject(context.Background(), "attachments/a1", "text/plain", bytes.NewReader(payload), int64(len(payload)), hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	if etag != `"etag-1"` || gotChecksum != base64.StdEncoding.EncodeToString(sum[:]) || gotType != "text/plain" || gotLen != "16" {
		t.Fatalf("etag=%q checksum=%q type=%q len=%q", etag, gotChecksum, gotType, gotLen)
	}
	if !bytes.Contains(gotBody, payload) {
		t.Fatalf("body = %q", gotBody)
	}
}

func TestS3Client_PutChecksummedObject_Errors(t *testing.T) {
	c := newTestS3(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.Count(r.URL.Path, "/") > 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	ctx := context.Background()
	for _, bad := range []string{"zz", "abcd"} {
		if _, err := c.PutChecksummedObject(ctx, "k", "text/plain", bytes.NewReader(nil), 0, bad); err == nil || !strings.Contains(err.Error(), "invalid sha256") {
			t.Fatalf("sha %q: want invalid sha256, got %v", bad, err)
		}
	}
	sum := sha256.Sum256([]byte("x"))
	if _, err := c.PutChecksummedObject(ctx, "attachments/x", "text/plain", bytes.NewReader([]byte("x")), 1, hex.EncodeToString(sum[:])); err == nil || !strings.Contains(err.Error(), "s3: put object") {
		t.Fatalf("want wrapped put error, got %v", err)
	}
}
