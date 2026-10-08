package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
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

// s3API is the narrow slice of *s3.Client the storage layer calls. The
// concrete SDK client satisfies it; narrowing to an interface lets tests
// inject a fault wrapper that forces the SDK-error branches (the real
// client can't be made to fail those deterministically via httptest).
type s3API interface {
	DeleteObject(ctx context.Context, in *s3.DeleteObjectInput, optFns ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	HeadObject(ctx context.Context, in *s3.HeadObjectInput, optFns ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(ctx context.Context, in *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	PutObject(ctx context.Context, in *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

// s3Presigner is the narrow slice of *s3.PresignClient used for browser-
// bound URL generation. Same rationale as s3API.
type s3Presigner interface {
	PresignGetObject(ctx context.Context, in *s3.GetObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
	PresignPutObject(ctx context.Context, in *s3.PutObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

// requestSigner is the slice of *v4.Signer used to presign S3 requests the
// SDK's presign client has no operation for. A seam so tests can force the
// signing-error branch.
type requestSigner interface {
	PresignHTTP(ctx context.Context, credentials aws.Credentials, r *http.Request, payloadHash string, service string, region string, signingTime time.Time, optFns ...func(*v4.SignerOptions)) (string, http.Header, error)
}

// S3Client wraps an S3 client and a bucket name for object storage operations.
type S3Client struct {
	client    s3API
	presigner s3Presigner
	bucket    string
	// signer, creds and region presign arbitrary S3 requests (PresignRequest).
	signer requestSigner
	creds  aws.CredentialsProvider
	region string
}

// BrowserObjectCacheControl is attached to browser-bound object responses.
// Attachment/avatar/emoji object keys are immutable: replacements get new
// keys, so a one-year browser cache is safe for the exact presigned URL.
// `private` keeps shared caches out.
const BrowserObjectCacheControl = "private, max-age=31536000, immutable"

// loadAWSConfig is a seam over awsconfig.LoadDefaultConfig so the
// config-load failure branch in NewS3Client can be exercised in tests.
var loadAWSConfig = awsconfig.LoadDefaultConfig

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
	awsCfg, err := loadAWSConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("s3: load config: %w", err)
	}

	internalClient := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			o.UsePathStyle = true
		}
		o.DisableLogOutputChecksumValidationSkipped = true
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
		o.DisableLogOutputChecksumValidationSkipped = true
	})

	// Ensure bucket exists (ignore "already exists" errors).
	_, _ = internalClient.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(cfg.Bucket),
	})

	return &S3Client{
		client:    internalClient,
		presigner: s3.NewPresignClient(publicClient),
		bucket:    cfg.Bucket,
		signer:    v4.NewSigner(),
		creds:     awsCfg.Credentials,
		region:    awsCfg.Region,
	}, nil
}

// PresignedGetURL generates a pre-signed GET URL for the given key.
func (c *S3Client) PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	req, err := c.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket:               aws.String(c.bucket),
		Key:                  aws.String(key),
		ResponseCacheControl: aws.String(BrowserObjectCacheControl),
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
		ResponseCacheControl:       aws.String(BrowserObjectCacheControl),
		ResponseContentDisposition: aws.String(contentDispositionAttachment(filename)),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return "", fmt.Errorf("s3: presign download: %w", err)
	}
	return req.URL, nil
}

// contentDispositionAttachment builds an RFC 6266 / RFC 5987 compliant
// Content-Disposition header value. The plain `filename=` parameter handles
// ASCII clients; `filename*=UTF-8”...` carries the original UTF-8 name for
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

// GetObject opens the full object body for streaming through the app. The
// caller owns closing the returned body.
func (c *S3Client) GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	out, err := c.getObject(ctx, key)
	if err != nil {
		return nil, "", 0, time.Time{}, err
	}
	return out.Body, aws.ToString(out.ContentType), aws.ToInt64(out.ContentLength), aws.ToTime(out.LastModified), nil
}

// OpenObject is GetObject for verification: it also returns the ETag of the
// exact version being streamed, so what gets recorded as verified is the
// version that was read — not whatever a separate HEAD happened to see.
func (c *S3Client) OpenObject(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	out, err := c.getObject(ctx, key)
	if err != nil {
		return nil, "", 0, "", err
	}
	return out.Body, aws.ToString(out.ContentType), aws.ToInt64(out.ContentLength), aws.ToString(out.ETag), nil
}

func (c *S3Client) getObject(ctx context.Context, key string) (*s3.GetObjectOutput, error) {
	out, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("s3: get object: %w", err)
	}
	return out, nil
}

// StatObject reports an object's size, content type and ETag without reading
// it, plus its SHA-256 (base64) when S3 holds one for the whole object — i.e.
// when it was uploaded with a signed x-amz-checksum-sha256. Multipart uploads
// only carry a checksum-of-part-checksums, which is not the file's hash, so a
// composite value is reported as empty.
func (c *S3Client) StatObject(ctx context.Context, key string) (int64, string, string, string, error) {
	out, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket:       aws.String(c.bucket),
		Key:          aws.String(key),
		ChecksumMode: types.ChecksumModeEnabled,
	})
	if err != nil {
		return 0, "", "", "", fmt.Errorf("s3: stat object: %w", err)
	}
	checksum := aws.ToString(out.ChecksumSHA256)
	if out.ChecksumType == types.ChecksumTypeComposite || strings.Contains(checksum, "-") {
		checksum = ""
	}
	return aws.ToInt64(out.ContentLength), aws.ToString(out.ContentType), aws.ToString(out.ETag), checksum, nil
}

// PresignRequest signs one S3 REST call for the browser to make directly
// against the bucket. The SDK's presign client only covers single-object
// GET/PUT/HEAD/DELETE and UploadPart; multipart create, list, complete and
// abort need this. The object URL comes from the SDK's own presigner, so the
// endpoint, path style and key encoding match every other URL we sign, and
// the signature from its SigV4 signer. query holds the operation's
// sub-resources (e.g. "uploads", or "uploadId" + "partNumber"); headers are
// signed, so the client must send exactly the returned set.
func (c *S3Client) PresignRequest(ctx context.Context, method, key string, query url.Values, headers map[string]string, expires time.Duration) (string, map[string]string, error) {
	objectURL, err := c.PresignedGetURL(ctx, key, expires)
	if err != nil {
		return "", nil, err
	}
	u, err := url.Parse(objectURL)
	if err != nil {
		return "", nil, fmt.Errorf("s3: parse object url: %w", err)
	}
	q := url.Values{}
	for k, vs := range query {
		q[k] = vs
	}
	q.Set("X-Amz-Expires", strconv.Itoa(int(expires.Seconds())))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return "", nil, fmt.Errorf("s3: build request: %w", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	creds, err := c.creds.Retrieve(ctx)
	if err != nil {
		return "", nil, fmt.Errorf("s3: credentials: %w", err)
	}
	signed, _, err := c.signer.PresignHTTP(ctx, creds, req, "UNSIGNED-PAYLOAD", "s3", c.region, time.Now())
	if err != nil {
		return "", nil, fmt.Errorf("s3: presign %s: %w", method, err)
	}
	return signed, headers, nil
}

// PutObject uploads body bytes under key with the supplied contentType.
// Used by server-side generated media, such as unfurl cache images and
// attachment thumbnails. S3 lifecycle rules to expire `unfurl/` keys after N
// days should be configured externally (Terraform / IaC).
func (c *S3Client) PutObject(ctx context.Context, key, contentType string, body []byte) error {
	_, err := c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(c.bucket),
		Key:          aws.String(key),
		CacheControl: aws.String(BrowserObjectCacheControl),
		ContentType:  aws.String(contentType),
		Body:         bytes.NewReader(body),
	})
	if err != nil {
		return fmt.Errorf("s3: put object: %w", err)
	}
	return nil
}
