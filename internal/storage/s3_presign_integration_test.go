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

// s3Do performs a presigned request exactly as a browser would: the signed URL
// plus the signed headers, nothing else.
func s3Do(t *testing.T, method, signedURL string, headers map[string]string, body []byte) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, signedURL, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build %s: %v", method, err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, signedURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	out, _ := io.ReadAll(resp.Body)
	return resp, out
}

func presign(t *testing.T, c *S3Client, method, key string, query url.Values, headers map[string]string) (string, map[string]string) {
	t.Helper()
	signed, h, err := c.PresignRequest(context.Background(), method, key, query, headers, time.Minute)
	if err != nil {
		t.Fatalf("PresignRequest %s: %v", method, err)
	}
	return signed, h
}

// browserMultipartUpload drives a whole multipart upload through presigned
// requests from sign, returning the upload ID.
func browserMultipartUpload(t *testing.T, sign func(method string, query url.Values, headers map[string]string) (string, map[string]string), parts [][]byte, contentType string) string {
	t.Helper()
	createURL, h := sign(http.MethodPost, url.Values{"uploads": {""}}, map[string]string{"Content-Type": contentType})
	resp, body := s3Do(t, http.MethodPost, createURL, h, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create multipart: %d %s", resp.StatusCode, body)
	}
	var created struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.Unmarshal(body, &created); err != nil || created.UploadID == "" {
		t.Fatalf("create multipart response %s: %v", body, err)
	}
	var complete strings.Builder
	complete.WriteString("<CompleteMultipartUpload>")
	for i, part := range parts {
		partURL, ph := sign(http.MethodPut, url.Values{"partNumber": {fmt.Sprint(i + 1)}, "uploadId": {created.UploadID}}, nil)
		resp, body := s3Do(t, http.MethodPut, partURL, ph, part)
		if resp.StatusCode != http.StatusOK || resp.Header.Get("ETag") == "" {
			t.Fatalf("upload part %d: %d %s", i+1, resp.StatusCode, body)
		}
		fmt.Fprintf(&complete, "<Part><PartNumber>%d</PartNumber><ETag>%s</ETag></Part>", i+1, resp.Header.Get("ETag"))
	}
	complete.WriteString("</CompleteMultipartUpload>")

	listURL, lh := sign(http.MethodGet, url.Values{"uploadId": {created.UploadID}}, nil)
	if resp, body := s3Do(t, http.MethodGet, listURL, lh, nil); resp.StatusCode != http.StatusOK || strings.Count(string(body), "<Part>") != len(parts) {
		t.Fatalf("list parts: %d %s", resp.StatusCode, body)
	}
	completeURL, ch := sign(http.MethodPost, url.Values{"uploadId": {created.UploadID}}, nil)
	if resp, body := s3Do(t, http.MethodPost, completeURL, ch, []byte(complete.String())); resp.StatusCode != http.StatusOK {
		t.Fatalf("complete multipart: %d %s", resp.StatusCode, body)
	}
	return created.UploadID
}

func TestS3Client_PresignRequest_MultipartOverRealHTTP(t *testing.T) {
	c := newMinioS3(t, "multipart")
	ctx := context.Background()
	key := "attachments/it-multipart"
	first := bytes.Repeat([]byte("a"), 5<<20) // S3's minimum non-final part
	last := []byte("tail")
	sign := func(method string, query url.Values, headers map[string]string) (string, map[string]string) {
		return presign(t, c, method, key, query, headers)
	}
	browserMultipartUpload(t, sign, [][]byte{first, last}, "application/zip")

	size, ct, etag, checksum, err := c.StatObject(ctx, key)
	if err != nil {
		t.Fatalf("StatObject: %v", err)
	}
	if size != int64(len(first)+len(last)) || ct != "application/zip" || etag == "" || checksum != "" {
		t.Fatalf("StatObject = %d %q %q %q; a multipart object has no whole-file SHA-256", size, ct, etag, checksum)
	}
	body, _, _, openETag, err := c.OpenObject(ctx, key)
	if err != nil {
		t.Fatalf("OpenObject: %v", err)
	}
	got, _ := io.ReadAll(body)
	_ = body.Close()
	if openETag != etag || !bytes.Equal(got, append(append([]byte(nil), first...), last...)) {
		t.Fatalf("OpenObject etag %q (HEAD %q) / %d bytes", openETag, etag, len(got))
	}

	// Abort discards an open upload.
	createURL, h := sign(http.MethodPost, url.Values{"uploads": {""}}, map[string]string{"Content-Type": "application/zip"})
	_, created := s3Do(t, http.MethodPost, createURL, h, nil)
	var up struct {
		UploadID string `xml:"UploadId"`
	}
	_ = xml.Unmarshal(created, &up)
	abortURL, ah := sign(http.MethodDelete, url.Values{"uploadId": {up.UploadID}}, nil)
	if resp, body := s3Do(t, http.MethodDelete, abortURL, ah, nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("abort: %d %s", resp.StatusCode, body)
	}
	listURL, lh := sign(http.MethodGet, url.Values{"uploadId": {up.UploadID}}, nil)
	if resp, _ := s3Do(t, http.MethodGet, listURL, lh, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("aborted upload still listable: %d", resp.StatusCode)
	}
}

// A single PUT signed with x-amz-checksum-sha256 is hash-checked by S3 itself:
// matching bytes are stored with the checksum on record, anything else is
// refused.
func TestS3Client_PresignRequest_ChecksumBoundPut(t *testing.T) {
	c := newMinioS3(t, "checksum")
	ctx := context.Background()
	key := "attachments/it-checksum"
	payload := []byte("exactly these bytes")
	sum := sha256.Sum256(payload)
	b64 := base64.StdEncoding.EncodeToString(sum[:])
	putURL, h := presign(t, c, http.MethodPut, key, nil, map[string]string{"Content-Type": "text/plain", "x-amz-checksum-sha256": b64})

	if resp, body := s3Do(t, http.MethodPut, putURL, h, []byte("different bytes!!!!")); resp.StatusCode == http.StatusOK {
		t.Fatalf("S3 accepted bytes that do not match the signed checksum: %s", body)
	}
	if resp, body := s3Do(t, http.MethodPut, putURL, h, payload); resp.StatusCode != http.StatusOK {
		t.Fatalf("checksum-bound PUT: %d %s", resp.StatusCode, body)
	}
	size, ct, etag, checksum, err := c.StatObject(ctx, key)
	if err != nil {
		t.Fatalf("StatObject: %v", err)
	}
	if size != int64(len(payload)) || ct != "text/plain" || etag == "" || checksum != b64 {
		t.Fatalf("StatObject = %d %q %q %q, want checksum %q", size, ct, etag, checksum, b64)
	}
}
