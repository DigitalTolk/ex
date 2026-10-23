package storage

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

var errFault = errors.New("s3 fault")

// faultClient implements s3API; each method returns errFault unless a
// custom GetObject output is supplied (for the body-read error case).
type faultClient struct {
	getOut  *s3.GetObjectOutput
	getErr  error
	headOut *s3.HeadObjectOutput
	headErr error
}

func (f faultClient) DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	return nil, errFault
}
func (f faultClient) HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	return f.headOut, f.headErr
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
func (f faultClient) AbortMultipartUpload(context.Context, *s3.AbortMultipartUploadInput, ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error) {
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
	if _, err := c.PresignedInlineURL(ctx, "k", "image/png", "f.png", time.Hour); err == nil {
		t.Error("PresignedInlineURL: expected presign error")
	}
	if _, err := c.PresignedSizedPutURL(ctx, "k", "image/png", 10, time.Hour); err == nil {
		t.Error("PresignedSizedPutURL: expected presign error")
	}
}

func TestS3Client_AbortMultipartUpload_Errors(t *testing.T) {
	c := &S3Client{client: faultClient{}, bucket: "b"}
	if err := c.AbortMultipartUpload(context.Background(), "k", "up"); !errors.Is(err, errFault) {
		t.Fatalf("AbortMultipartUpload err = %v, want the S3 failure", err)
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

// rangeClient records the GetObject request and answers it.
type rangeClient struct {
	faultClient
	in  *s3.GetObjectInput
	out *s3.GetObjectOutput
}

func (r *rangeClient) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	r.in = in
	return r.out, nil
}

func TestS3Client_OpenObjectRange(t *testing.T) {
	modified := time.Date(2026, 5, 2, 12, 0, 0, 0, time.UTC)
	rc := &rangeClient{out: &s3.GetObjectOutput{
		Body:          io.NopCloser(strings.NewReader("2345")),
		ContentType:   aws.String("video/mp4"),
		ContentLength: aws.Int64(4),
		ContentRange:  aws.String("bytes 2-5/10"),
		LastModified:  aws.Time(modified),
	}}
	c := &S3Client{client: rc, bucket: "b"}
	body, ct, n, cr, lm, err := c.OpenObjectRange(context.Background(), "k", "bytes=2-5")
	if err != nil {
		t.Fatalf("OpenObjectRange: %v", err)
	}
	_ = body.Close()
	if aws.ToString(rc.in.Range) != "bytes=2-5" || ct != "video/mp4" || n != 4 || cr != "bytes 2-5/10" || !lm.Equal(modified) {
		t.Fatalf("range %q → %q %d %q %v", aws.ToString(rc.in.Range), ct, n, cr, lm)
	}
	// No range asks S3 for the whole object.
	if _, _, _, _, _, err := c.OpenObjectRange(context.Background(), "k", ""); err != nil || rc.in.Range != nil {
		t.Fatalf("whole object: range %v err %v", rc.in.Range, err)
	}
}

func TestS3Client_OpenObjectRange_Errors(t *testing.T) {
	c := &S3Client{client: faultClient{getErr: apiErr{code: "InvalidRange"}}, bucket: "b"}
	if _, _, _, _, _, err := c.OpenObjectRange(context.Background(), "k", "bytes=50-"); !errors.Is(err, ErrRangeNotSatisfiable) {
		t.Fatalf("InvalidRange: err = %v", err)
	}
	c = &S3Client{client: faultClient{getErr: errFault}, bucket: "b"}
	if _, _, _, _, _, err := c.OpenObjectRange(context.Background(), "k", ""); !errors.Is(err, errFault) {
		t.Fatalf("fault: err = %v", err)
	}
}
