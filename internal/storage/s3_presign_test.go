package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// urlPresigner presigns GETs to a fixed URL (PresignRequest derives the
// object URL from it).
type urlPresigner struct{ url string }

func (p urlPresigner) PresignGetObject(context.Context, *s3.GetObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	return &v4.PresignedHTTPRequest{URL: p.url}, nil
}
func (p urlPresigner) PresignPutObject(context.Context, *s3.PutObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	return nil, errFault
}

// recordingSigner captures the request it is asked to presign.
type recordingSigner struct {
	req *http.Request
	err error
}

func (r *recordingSigner) PresignHTTP(_ context.Context, _ aws.Credentials, req *http.Request, _ string, _ string, _ string, _ time.Time, _ ...func(*v4.SignerOptions)) (string, http.Header, error) {
	r.req = req
	if r.err != nil {
		return "", nil, r.err
	}
	return req.URL.String() + "&X-Amz-Signature=sig", nil, nil
}

func staticCreds() aws.CredentialsProvider {
	return aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: "ak", SecretAccessKey: "sk"}, nil
	})
}

func TestS3Client_PresignRequest_BuildsTheSignedRequest(t *testing.T) {
	signer := &recordingSigner{}
	c := &S3Client{
		presigner: urlPresigner{url: "https://s3.example.test/bucket/attachments/a?X-Amz-Signature=get&response-cache-control=x"},
		signer:    signer, creds: staticCreds(), region: "eu-north-1",
	}
	signed, headers, err := c.PresignRequest(context.Background(), http.MethodPut, "attachments/a",
		url.Values{"partNumber": {"2"}, "uploadId": {"mpu"}}, map[string]string{"x-amz-checksum-sha256": "abc="}, 15*time.Minute)
	if err != nil {
		t.Fatalf("PresignRequest: %v", err)
	}
	q := signer.req.URL.Query()
	if signer.req.Method != http.MethodPut || signer.req.URL.Path != "/bucket/attachments/a" ||
		q.Get("partNumber") != "2" || q.Get("uploadId") != "mpu" || q.Get("X-Amz-Expires") != "900" || q.Get("response-cache-control") != "" {
		t.Fatalf("unexpected request to sign: %s %s", signer.req.Method, signer.req.URL)
	}
	if signer.req.Header.Get("x-amz-checksum-sha256") != "abc=" || headers["x-amz-checksum-sha256"] != "abc=" {
		t.Fatalf("headers must be signed and returned, got %v / %v", signer.req.Header, headers)
	}
	if !strings.HasSuffix(signed, "X-Amz-Signature=sig") {
		t.Fatalf("signed URL = %q", signed)
	}
}

func TestS3Client_PresignRequest_Errors(t *testing.T) {
	ctx := context.Background()
	good := urlPresigner{url: "https://s3.example.test/bucket/k"}
	cases := []struct {
		name   string
		c      *S3Client
		method string
	}{
		{"object url presign fails", &S3Client{presigner: faultPresigner{}, signer: &recordingSigner{}, creds: staticCreds()}, http.MethodPost},
		{"object url unparsable", &S3Client{presigner: urlPresigner{url: "http://[::1"}, signer: &recordingSigner{}, creds: staticCreds()}, http.MethodPost},
		{"invalid method", &S3Client{presigner: good, signer: &recordingSigner{}, creds: staticCreds()}, "BAD METHOD"},
		{"no credentials", &S3Client{presigner: good, signer: &recordingSigner{}, creds: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{}, errors.New("no creds")
		})}, http.MethodPost},
		{"signing fails", &S3Client{presigner: good, signer: &recordingSigner{err: errFault}, creds: staticCreds()}, http.MethodPost},
	}
	for _, tc := range cases {
		if _, _, err := tc.c.PresignRequest(ctx, tc.method, "k", url.Values{"uploads": {""}}, nil, time.Minute); err == nil {
			t.Errorf("%s: expected an error", tc.name)
		}
	}
}

func TestS3Client_StatObject(t *testing.T) {
	ctx := context.Background()
	if _, _, _, _, err := (&S3Client{client: faultClient{headErr: errFault}, bucket: "b"}).StatObject(ctx, "k"); err == nil {
		t.Fatal("expected HEAD error")
	}
	whole := &S3Client{client: faultClient{headOut: &s3.HeadObjectOutput{
		ContentLength: aws.Int64(7), ContentType: aws.String("text/plain"), ETag: aws.String(`"e1"`),
		ChecksumSHA256: aws.String("whole="), ChecksumType: types.ChecksumTypeFullObject,
	}}, bucket: "b"}
	size, ct, etag, sum, err := whole.StatObject(ctx, "k")
	if err != nil || size != 7 || ct != "text/plain" || etag != `"e1"` || sum != "whole=" {
		t.Fatalf("StatObject = %d %q %q %q %v", size, ct, etag, sum, err)
	}
	// A multipart checksum-of-checksums is not the file's SHA-256.
	for _, out := range []*s3.HeadObjectOutput{
		{ChecksumSHA256: aws.String("parts="), ChecksumType: types.ChecksumTypeComposite},
		{ChecksumSHA256: aws.String("parts=-3")},
	} {
		if _, _, _, sum, _ := (&S3Client{client: faultClient{headOut: out}, bucket: "b"}).StatObject(ctx, "k"); sum != "" {
			t.Fatalf("composite checksum %q must be reported as empty", sum)
		}
	}
}

func TestS3Client_OpenObject(t *testing.T) {
	ctx := context.Background()
	if _, _, _, _, err := (&S3Client{client: faultClient{getErr: errFault}, bucket: "b"}).OpenObject(ctx, "k"); err == nil {
		t.Fatal("expected GET error")
	}
	out := &s3.GetObjectOutput{
		Body: io.NopCloser(strings.NewReader("data")), ContentType: aws.String("text/plain"),
		ContentLength: aws.Int64(4), ETag: aws.String(`"e2"`),
	}
	body, ct, size, etag, err := (&S3Client{client: faultClient{getOut: out}, bucket: "b"}).OpenObject(ctx, "k")
	if err != nil || ct != "text/plain" || size != 4 || etag != `"e2"` {
		t.Fatalf("OpenObject = %q %d %q %v", ct, size, etag, err)
	}
	_ = body.Close()
}
