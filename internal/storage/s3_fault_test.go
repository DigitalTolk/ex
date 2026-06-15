package storage

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

var errFault = errors.New("s3 fault")

// faultClient implements s3API; each method returns errFault unless a
// custom GetObject output is supplied (for the body-read error case).
type faultClient struct {
	getOut *s3.GetObjectOutput
	getErr error
	headErr error
}

func (f faultClient) DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	return nil, errFault
}
func (f faultClient) HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	return nil, f.headErr
}
func (f faultClient) GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.getOut, nil
}
func (f faultClient) PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	return nil, errFault
}

// faultPresigner implements s3Presigner and always errors.
type faultPresigner struct{}

func (faultPresigner) PresignGetObject(context.Context, *s3.GetObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	return nil, errFault
}
func (faultPresigner) PresignPutObject(context.Context, *s3.PutObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	return nil, errFault
}

// NewS3Client wraps the SDK config loader through the loadAWSConfig seam;
// a loader error is wrapped and returned.
func TestNewS3Client_ConfigLoadError(t *testing.T) {
	orig := loadAWSConfig
	t.Cleanup(func() { loadAWSConfig = orig })
	loadAWSConfig = func(context.Context, ...func(*awsconfig.LoadOptions) error) (aws.Config, error) {
		return aws.Config{}, errors.New("config boom")
	}
	if _, err := NewS3Client(context.Background(), S3Config{Bucket: "b", Region: "us-east-1"}); err == nil {
		t.Fatal("expected config-load error")
	}
}

func TestS3Client_PresignErrors(t *testing.T) {
	c := &S3Client{presigner: faultPresigner{}, bucket: "b"}
	ctx := context.Background()

	if _, err := c.PresignedGetURL(ctx, "k", time.Hour); err == nil {
		t.Error("PresignedGetURL: expected presign error")
	}
	if _, err := c.PresignedDownloadURL(ctx, "k", "f.pdf", time.Hour); err == nil {
		t.Error("PresignedDownloadURL: expected presign error")
	}
	if _, err := c.PresignedPutURL(ctx, "k", "image/png", time.Hour); err == nil {
		t.Error("PresignedPutURL: expected presign error")
	}
}

// HeadObject treats a typed NoSuchKey error as a miss (false, nil).
func TestS3Client_HeadObject_NoSuchKey(t *testing.T) {
	c := &S3Client{client: faultClient{headErr: &types.NoSuchKey{}}, bucket: "b"}
	exists, err := c.HeadObject(context.Background(), "k")
	if err != nil {
		t.Fatalf("HeadObject: %v", err)
	}
	if exists {
		t.Error("expected exists=false for NoSuchKey")
	}
}

// apiErr is a smithy.APIError with a configurable code, used to exercise
// the generic-404 fallback branch of HeadObject.
type apiErr struct{ code string }

func (e apiErr) Error() string                 { return e.code }
func (e apiErr) ErrorCode() string             { return e.code }
func (e apiErr) ErrorMessage() string          { return e.code }
func (e apiErr) ErrorFault() smithy.ErrorFault { return smithy.FaultServer }

// MinIO-style generic smithy 404 (code "NotFound" / "NoSuchKey") is a miss.
func TestS3Client_HeadObject_GenericAPINotFound(t *testing.T) {
	for _, code := range []string{"NotFound", "NoSuchKey"} {
		c := &S3Client{client: faultClient{headErr: apiErr{code: code}}, bucket: "b"}
		exists, err := c.HeadObject(context.Background(), "k")
		if err != nil {
			t.Fatalf("HeadObject(%s): %v", code, err)
		}
		if exists {
			t.Errorf("expected exists=false for generic %s", code)
		}
	}
}

// A non-404 smithy API error surfaces as a wrapped error.
func TestS3Client_HeadObject_OtherAPIError(t *testing.T) {
	c := &S3Client{client: faultClient{headErr: apiErr{code: "AccessDenied"}}, bucket: "b"}
	if _, err := c.HeadObject(context.Background(), "k"); err == nil {
		t.Fatal("expected error for non-404 API error")
	}
}

// GetObject's SDK error wraps-and-returns.
func TestS3Client_GetObject_Error(t *testing.T) {
	c := &S3Client{client: faultClient{getErr: errFault}, bucket: "b"}
	if _, _, _, _, err := c.GetObject(context.Background(), "k"); err == nil {
		t.Fatal("expected GetObject error")
	}
}

// GetObjectRange's body-read failure wraps-and-returns: the SDK call
// succeeds but reading the returned body errors.
func TestS3Client_GetObjectRange_BodyReadError(t *testing.T) {
	out := &s3.GetObjectOutput{Body: io.NopCloser(errReader{})}
	c := &S3Client{client: faultClient{getOut: out}, bucket: "b"}
	if _, err := c.GetObjectRange(context.Background(), "k", 16); err == nil {
		t.Fatal("expected body-read error")
	}
}

// errReader fails every Read so io.ReadAll returns an error.
type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read boom") }
