package storage

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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
