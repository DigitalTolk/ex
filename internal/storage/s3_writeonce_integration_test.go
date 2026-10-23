//go:build integration

package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// An upload key is write-once from the browser: a request signed with
// If-None-Match: * (single PUT or multipart complete) is refused once the
// object exists, so bytes the server verified can never be replaced through
// a URL it signed earlier.

func TestS3Client_PresignRequest_IfNoneMatchMakesPutWriteOnce(t *testing.T) {
	c := newMinioS3(t, "write-once-put")
	key := "attachments/it-write-once"
	benign := []byte("verified bytes")
	sum := sha256.Sum256(benign)
	putURL, h := presign(t, c, http.MethodPut, key, nil, map[string]string{
		"Content-Type":          "text/plain",
		"x-amz-checksum-sha256": base64.StdEncoding.EncodeToString(sum[:]),
		"If-None-Match":         "*",
	})
	if resp, body := s3Do(t, http.MethodPut, putURL, h, benign); resp.StatusCode != http.StatusOK {
		t.Fatalf("first PUT: %d %s", resp.StatusCode, body)
	}
	// Replaying the very same signed request is refused.
	if resp, body := s3Do(t, http.MethodPut, putURL, h, benign); resp.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("second PUT: %d %s, want 412", resp.StatusCode, body)
	}
}

func TestS3Client_PresignRequest_IfNoneMatchRefusesALateMultipartComplete(t *testing.T) {
	c := newMinioS3(t, "write-once-multipart")
	ctx := context.Background()
	key := "attachments/it-late-complete"
	sign := func(method string, query url.Values, headers map[string]string) (string, map[string]string) {
		return presign(t, c, method, key, query, headers)
	}

	// An attacker opens a multipart upload and stages a malicious part...
	createURL, h := sign(http.MethodPost, url.Values{"uploads": {""}}, map[string]string{"Content-Type": "image/png"})
	_, created := s3Do(t, http.MethodPost, createURL, h, nil)
	var up struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.Unmarshal(created, &up); err != nil || up.UploadID == "" {
		t.Fatalf("create: %s %v", created, err)
	}
	partURL, ph := sign(http.MethodPut, url.Values{"partNumber": {"1"}, "uploadId": {up.UploadID}}, nil)
	resp, body := s3Do(t, http.MethodPut, partURL, ph, []byte("<html>evil</html>"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("part: %d %s", resp.StatusCode, body)
	}
	complete := fmt.Sprintf("<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>%s</ETag></Part></CompleteMultipartUpload>", resp.Header.Get("ETag"))
	completeURL, ch := sign(http.MethodPost, url.Values{"uploadId": {up.UploadID}}, map[string]string{"If-None-Match": "*"})

	// ...then a benign single PUT lands and is verified...
	if err := c.PutObject(ctx, key, "image/png", []byte("benign")); err != nil {
		t.Fatalf("benign put: %v", err)
	}
	// ...and the pre-signed complete can no longer replace it.
	if resp, body := s3Do(t, http.MethodPost, completeURL, ch, []byte(complete)); resp.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("late complete: %d %s, want 412", resp.StatusCode, body)
	}
	got, _, _, _, err := c.GetObject(ctx, key)
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	data, _ := io.ReadAll(got)
	_ = got.Close()
	if string(data) != "benign" {
		t.Fatalf("object = %q, want the verified bytes", data)
	}
}

func TestS3Client_AbortMultipartUpload_RealObjectStore(t *testing.T) {
	c := newMinioS3(t, "abort-multipart")
	ctx := context.Background()
	key := "attachments/it-abort"
	createURL, h := presign(t, c, http.MethodPost, key, url.Values{"uploads": {""}}, map[string]string{"Content-Type": "image/png"})
	_, created := s3Do(t, http.MethodPost, createURL, h, nil)
	var up struct {
		UploadID string `xml:"UploadId"`
	}
	_ = xml.Unmarshal(created, &up)
	if err := c.AbortMultipartUpload(ctx, key, up.UploadID); err != nil {
		t.Fatalf("abort: %v", err)
	}
	listURL, lh := presign(t, c, http.MethodGet, key, url.Values{"uploadId": {up.UploadID}}, nil)
	if resp, _ := s3Do(t, http.MethodGet, listURL, lh, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("aborted upload still listable: %d", resp.StatusCode)
	}
	// Aborting what S3 no longer knows is not an error.
	if err := c.AbortMultipartUpload(ctx, key, up.UploadID); err != nil {
		t.Fatalf("second abort: %v", err)
	}
}

func TestS3Client_PresignedSizedPutURL_RefusesOtherSizes(t *testing.T) {
	c := newMinioS3(t, "sized-put")
	ctx := context.Background()
	key := "uploads/u1/it-sized/emoji.png"
	payload := []byte("exactly sixteen!")
	putURL, err := c.PresignedSizedPutURL(ctx, key, "image/png", int64(len(payload)), time.Minute)
	if err != nil {
		t.Fatalf("PresignedSizedPutURL: %v", err)
	}
	put := func(body []byte) int {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPut, putURL, bytes.NewReader(body))
		req.Header.Set("Content-Type", "image/png")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("PUT: %v", err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if code := put(bytes.Repeat([]byte("x"), 4096)); code == http.StatusOK {
		t.Fatal("a larger body was accepted")
	}
	if code := put(payload); code != http.StatusOK {
		t.Fatalf("declared-size PUT: %d", code)
	}
}

func TestS3Client_PresignedInlineURL_ServesOneSafeType(t *testing.T) {
	c := newMinioS3(t, "inline-get")
	ctx := context.Background()
	key := "attachments/it-inline"
	if err := c.PutObject(ctx, key, "image/png, text/html", []byte("<script>1</script>")); err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	get := func(contentType string) *http.Response {
		u, err := c.PresignedInlineURL(ctx, key, contentType, "pic.png", time.Minute)
		if err != nil {
			t.Fatalf("PresignedInlineURL: %v", err)
		}
		resp, err := http.Get(u) //nolint:gosec,noctx // test-only presigned URL fetch
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		_ = resp.Body.Close()
		return resp
	}
	resp := get("image/png, text/html")
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("Content-Type = %q, want application/octet-stream", ct)
	}
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Fatalf("Content-Disposition = %q, want attachment", cd)
	}
	resp = get("image/png")
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", ct)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		t.Fatalf("Content-Disposition = %q, want inline", cd)
	}
}
