package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

// S3Config holds configuration for connecting to an S3-compatible service.
//
// Endpoint is used for backend-to-S3 operations (e.g. ensuring bucket exists).
// PublicEndpoint is used when generating presigned URLs that the browser will
// fetch — it must be reachable from the user's browser. If empty, Endpoint is
// used for both.
type S3Config struct {
	Endpoint       string
	PublicEndpoint string
	Bucket         string
	AccessKey      string
	SecretKey      string
	Region         string
}

// S3Client wraps an S3 client and a bucket name for object storage operations.
type S3Client struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

// NewS3Client creates an S3Client configured for the given S3Config.
//
// Two underlying S3 clients are created: one with the internal Endpoint for
// backend operations, and one with PublicEndpoint for generating presigned
// URLs. This allows backend → MinIO traffic to use a Docker hostname while
// browser-bound presigned URLs use a host-reachable address.
func NewS3Client(ctx context.Context, cfg S3Config) (*S3Client, error) {
	// Only override the credentials chain when both static keys are
	// supplied. Empty AccessKey/SecretKey on a real AWS deploy means
	// "use the default chain" (env vars → IAM role → IRSA → instance
	// metadata). Pinning a static provider with empty strings would
	// shadow the role and break IAM-role-only deployments.
	loadOpts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(cfg.Region),
	}
	if cfg.AccessKey != "" && cfg.SecretKey != "" {
		loadOpts = append(loadOpts,
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, "")),
		)
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("s3: load config: %w", err)
	}

	internalClient := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			o.UsePathStyle = true
		}
	})

	publicEndpoint := cfg.PublicEndpoint
	if publicEndpoint == "" {
		publicEndpoint = cfg.Endpoint
	}
	publicClient := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if publicEndpoint != "" {
			o.BaseEndpoint = aws.String(publicEndpoint)
			o.UsePathStyle = true
		}
	})

	// Ensure bucket exists (ignore "already exists" errors).
	_, _ = internalClient.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(cfg.Bucket),
	})

	return &S3Client{
		client:    internalClient,
		presigner: s3.NewPresignClient(publicClient),
		bucket:    cfg.Bucket,
	}, nil
}

// PresignedGetURL generates a pre-signed GET URL for the given key.
func (c *S3Client) PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	req, err := c.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return "", fmt.Errorf("s3: presign get: %w", err)
	}
	return req.URL, nil
}

// PresignedDownloadURL generates a pre-signed GET URL whose response carries a
// `Content-Disposition: attachment; filename=...` header. Browsers honor this
// even for cross-origin links — the plain <a download> attribute does not —
// so this is what the UI's "Download" buttons should hit.
func (c *S3Client) PresignedDownloadURL(ctx context.Context, key, filename string, expires time.Duration) (string, error) {
	req, err := c.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket:                     aws.String(c.bucket),
		Key:                        aws.String(key),
		ResponseContentDisposition: aws.String(contentDispositionAttachment(filename)),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return "", fmt.Errorf("s3: presign download: %w", err)
	}
	return req.URL, nil
}

// contentDispositionAttachment builds an RFC 6266 / RFC 5987 compliant
// Content-Disposition header value. The plain `filename=` parameter handles
// ASCII clients; `filename*=UTF-8''…` carries the original UTF-8 name for
// modern browsers without breaking older parsers on quoted-string limits.
func contentDispositionAttachment(filename string) string {
	if filename == "" {
		return "attachment"
	}
	// Strip CR/LF and quotes from the ASCII fallback so the header stays
	// well-formed, then percent-encode for the UTF-8 variant.
	asciiSafe := strings.Map(func(r rune) rune {
		switch r {
		case '"', '\r', '\n':
			return '_'
		}
		if r > 0x7e || r < 0x20 {
			return '_'
		}
		return r
	}, filename)
	// url.QueryEscape over-encodes a few RFC 5987 unreserved chars (e.g.
	// `!`, `#`), but over-encoding is always valid — the recipient
	// decodes the same UTF-8 bytes either way. The one fix-up we need
	// is space: QueryEscape emits `+` (form-urlencoded), RFC 5987 wants
	// `%20`.
	encoded := strings.ReplaceAll(url.QueryEscape(filename), "+", "%20")
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, asciiSafe, encoded)
}

// PresignedPutURL generates a pre-signed PUT URL for uploading an object with
// the given key and content type. The browser uploads directly to S3 using
// this URL — the backend never sees the file bytes.
func (c *S3Client) PresignedPutURL(ctx context.Context, key, contentType string, expires time.Duration) (string, error) {
	req, err := c.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return "", fmt.Errorf("s3: presign put: %w", err)
	}
	return req.URL, nil
}

// DeleteObject removes an object from the bucket. Used when an attachment is
// dereferenced (last referencing message deleted) so we don't leak storage.
func (c *S3Client) DeleteObject(ctx context.Context, key string) error {
	_, err := c.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("s3: delete object: %w", err)
	}
	return nil
}

// HeadObject returns true if the given key exists in the bucket. A 404
// (NotFound / NoSuchKey) is reported as (false, nil); any other error is
// returned to the caller.
func (c *S3Client) HeadObject(ctx context.Context, key string) (bool, error) {
	_, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return true, nil
	}
	var notFound *types.NotFound
	if errors.As(err, &notFound) {
		return false, nil
	}
	var noSuchKey *types.NoSuchKey
	if errors.As(err, &noSuchKey) {
		return false, nil
	}
	// MinIO and some S3-compatible backends surface 404s as a generic
	// smithy.APIError with code "NotFound" instead of the typed
	// NotFound shape. Treat that as a miss too.
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		if apiErr.ErrorCode() == "NotFound" || apiErr.ErrorCode() == "NoSuchKey" {
			return false, nil
		}
	}
	return false, fmt.Errorf("s3: head object: %w", err)
}

// GetObjectRange reads up to maxBytes from the start of the object at key.
// Used for cheap header peek operations (e.g. decoding image dimensions
// without downloading the full payload) — we send a Range header so even
// 10 MB images cost a few KB of bandwidth.
func (c *S3Client) GetObjectRange(ctx context.Context, key string, maxBytes int64) ([]byte, error) {
	out, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
		Range:  aws.String(fmt.Sprintf("bytes=0-%d", maxBytes-1)),
	})
	if err != nil {
		return nil, fmt.Errorf("s3: get object range: %w", err)
	}
	defer func() { _ = out.Body.Close() }()
	buf, err := io.ReadAll(io.LimitReader(out.Body, maxBytes))
	if err != nil {
		return nil, fmt.Errorf("s3: read object body: %w", err)
	}
	return buf, nil
}

// PutObject uploads body bytes under key with the supplied contentType.
// Used by the unfurl image proxy (folder `unfurl/`) and any other server-
// side uploads. S3 lifecycle rules to expire `unfurl/` keys after N days
// should be configured externally (Terraform / IaC).
func (c *S3Client) PutObject(ctx context.Context, key, contentType string, body []byte) error {
	_, err := c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
		Body:        bytes.NewReader(body),
	})
	if err != nil {
		return fmt.Errorf("s3: put object: %w", err)
	}
	return nil
}
