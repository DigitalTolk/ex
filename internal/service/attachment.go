package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"hash"
	"image"
	stddraw "image/draw"
	// Register decoders for the formats the upload pipeline accepts.
	// image.DecodeConfig dispatches by format magic bytes; without
	// these blank imports it returns ErrFormat for everything but
	// the (decoder-less) base package.
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	nativewebp "github.com/HugoSmits86/nativewebp"
	xdraw "golang.org/x/image/draw"
	"golang.org/x/sync/semaphore"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// AttachmentStore is the persistence interface used by AttachmentService.
type AttachmentStore interface {
	Create(ctx context.Context, a *model.Attachment) error
	GetByID(ctx context.Context, id string) (*model.Attachment, error)
	GetByHash(ctx context.Context, sha256 string) (*model.Attachment, error)
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) (*model.Attachment, error)
	Delete(ctx context.Context, id string) error
	SetDimensions(ctx context.Context, id string, width, height int) error
	SetThumbnailKeys(ctx context.Context, id, thumbnailKey, squareThumbnailKey string) error
	SetMultipartUploadID(ctx context.Context, id, uploadID string) error
	SetVerifiedETag(ctx context.Context, id, etag string) error
}

// AttachmentSigner generates time-limited URLs for attachment objects, signs
// the S3 requests browsers make to upload them directly, and reads/removes
// objects. GetObjectRange is used by the lazy dimension-backfill path; we
// read just enough of the image header to decode width/height without
// downloading the full payload.
type AttachmentSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
	PresignedDownloadURL(ctx context.Context, key, filename string, expires time.Duration) (string, error)
	PresignRequest(ctx context.Context, method, key string, query url.Values, headers map[string]string, expires time.Duration) (string, map[string]string, error)
	DeleteObject(ctx context.Context, key string) error
	GetObjectRange(ctx context.Context, key string, maxBytes int64) ([]byte, error)
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
	OpenObject(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error)
	StatObject(ctx context.Context, key string) (int64, string, string, string, error)
	PutObject(ctx context.Context, key, contentType string, body []byte) error
}

// AttachmentService manages message attachments: dedup-by-hash uploads, signed
// URL resolution, refcount tracking, and S3 GC when the last reference is
// dropped.
type uploadLimits interface {
	AllowsExtension(ctx context.Context, filename string) bool
	AllowsSize(ctx context.Context, size int64) bool
}

type AttachmentService struct {
	attachments AttachmentStore
	signer      AttachmentSigner
	publisher   Publisher
	limits      uploadLimits
	// urlCache memoises presigned GET / download URLs by S3 key for
	// the cache window so the browser sees the same URL across
	// renders — without it every signed URL is fresh and the image
	// cache misses on every fetch.
	urlCache *presignedURLCache
	// inFlightBackfills dedupes concurrent dimensions backfills so a
	// single hot list of legacy attachments doesn't fan out into N
	// duplicate S3 reads.
	backfillMu        sync.Mutex
	inFlightBackfills map[string]struct{}
	mediaCache        MediaURLCache
	accessChecker     AttachmentAccessChecker
}

// NewAttachmentService constructs an AttachmentService.
func NewAttachmentService(attachments AttachmentStore, signer AttachmentSigner, publisher Publisher) *AttachmentService {
	return &AttachmentService{
		attachments: attachments,
		signer:      signer,
		publisher:   publisher,
		// The cache constructor caps this to a short safety window so
		// temporary AWS security tokens embedded in presigned URLs never
		// linger for hours after expiry.
		urlCache: newPresignedURLCache(20 * time.Hour),
	}
}

// SetUploadLimits wires the settings-based limit checker. Optional —
// when unset, no extra validation runs (useful for unit tests of the
// other paths). Production wiring always passes the SettingsService.
func (s *AttachmentService) SetUploadLimits(l uploadLimits) { s.limits = l }

// SetMediaURLCache enables stable app-hosted media URLs for attachment
// rendering. Without it, Get falls back to direct presigned S3 URLs.
func (s *AttachmentService) SetMediaURLCache(c MediaURLCache) { s.mediaCache = c }

func (s *AttachmentService) SetAccessChecker(c AttachmentAccessChecker) { s.accessChecker = c }

// AttachmentURLTTL is how long signed GET URLs remain valid. Frontend resolves
// URLs on demand via the API so this can be relatively short.
const AttachmentURLTTL = 24 * time.Hour

const MaxAttachmentBatchIDs = 50

// maxAttachmentDimensionPx bounds client-declared intrinsic dimensions at
// registration. For decodable images the bytes overrule the claim anyway
// (syncImageDimensions); for types the server can't decode (SVG, video) this
// cap keeps a hostile claim from distorting other viewers' chat layout.
const maxAttachmentDimensionPx = 65535

const (
	messageThumbnailMaxWidth  = 640
	messageThumbnailMaxHeight = 576
	squareThumbnailSize       = 96
)

type AttachmentAccessChecker interface {
	CanAccessMessageAttachment(ctx context.Context, userID, parentID, parentType, messageID, attachmentID string) error
}

// CreateUploadResult carries the result of an upload-init request. When
// AlreadyExists is true the caller should NOT upload — the attachment was
// dedupe-matched against a finished upload with the same SHA256 and they
// should just attach by ID. Otherwise the client uploads straight to S3 with
// requests signed by SignUploadRequest, resuming Attachment.MultipartUploadID
// when one is set.
type CreateUploadResult struct {
	Attachment    *model.Attachment
	AlreadyExists bool
}

// CreateUploadParams bundles the upload-init request fields. Width
// and Height are optional — when the client measures them on its
// side (e.g. via the browser's <img> intrinsic dimensions) they're
// persisted at create time so the message-list renderer can reserve
// the layout box on first paint. Server-side backfill picks up
// missing dimensions on first read.
type CreateUploadParams struct {
	UserID      string
	Filename    string
	ContentType string
	SHA256      string
	Size        int64
	Width       int
	Height      int
}

// CreateUploadURL either returns an existing attachment matching the SHA256
// hash (with no upload URL) or creates a new attachment record + presigned PUT
// URL the client uploads to.
func (s *AttachmentService) CreateUploadURL(ctx context.Context, p CreateUploadParams) (*CreateUploadResult, error) {
	if p.UserID == "" {
		return nil, errors.New("attachment: userID required")
	}
	if p.Filename == "" || p.ContentType == "" || p.SHA256 == "" {
		return nil, errors.New("attachment: filename, contentType, sha256 required")
	}
	if !validSHA256Hex(p.SHA256) {
		return nil, errors.New("attachment: invalid sha256")
	}
	if p.Width < 0 || p.Height < 0 || p.Width > maxAttachmentDimensionPx || p.Height > maxAttachmentDimensionPx {
		return nil, errors.New("attachment: invalid dimensions")
	}
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	if s.limits != nil {
		if !s.limits.AllowsExtension(ctx, p.Filename) {
			return nil, errors.New("attachment: file extension not allowed by workspace settings")
		}
		if !s.limits.AllowsSize(ctx, p.Size) {
			return nil, errors.New("attachment: file exceeds the workspace upload size limit")
		}
	}

	if existing, err := s.attachments.GetByHash(ctx, p.SHA256); err == nil && existing != nil && existing.CreatedBy == p.UserID {
		// A finished upload is reused outright. An unfinished one (the user
		// re-attached a file whose upload never completed) comes back to be
		// resumed: same row, same object key, same multipart upload.
		return &CreateUploadResult{Attachment: existing, AlreadyExists: attachmentUploaded(existing)}, nil
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("attachment: lookup hash: %w", err)
	}

	id := store.NewID()
	a := &model.Attachment{
		ID:          id,
		SHA256:      p.SHA256,
		Size:        p.Size,
		ContentType: p.ContentType,
		Filename:    p.Filename,
		S3Key:       "attachments/" + id,
		Width:       p.Width,
		Height:      p.Height,
		CreatedBy:   p.UserID,
		CreatedAt:   time.Now(),
	}
	if err := s.attachments.Create(ctx, a); err != nil {
		return nil, fmt.Errorf("attachment: create: %w", err)
	}
	return &CreateUploadResult{Attachment: a}, nil
}

// attachmentUploaded reports whether an attachment's object is final: verified
// by the server, or already sent in a message (rows from before verification
// was recorded). A final object is immutable — nothing may upload to it again.
func attachmentUploaded(a *model.Attachment) bool {
	return a.VerifiedETag != "" || len(a.MessageIDs) > 0
}

// ErrAttachmentUploaded rejects upload requests for an attachment whose
// object is already final.
var ErrAttachmentUploaded = errors.New("attachment: already uploaded")

// uploadRequestTTL bounds each signed upload request. Uppy asks for a fresh
// signature per request (per part), so it only has to outlive one part.
const uploadRequestTTL = 15 * time.Minute

// maxMultipartParts is S3's limit on parts per multipart upload.
const maxMultipartParts = 10000

// UploadRequest is one S3 call the browser wants to make while uploading an
// attachment (Uppy's AWS S3 plugin asks for each one): a single PUT, or the
// create / part / list / complete / abort steps of a multipart upload.
type UploadRequest struct {
	Method     string
	Key        string
	UploadID   string
	PartNumber int
}

// SignedUploadRequest is a presigned S3 URL plus the headers it was signed
// with, which the client must send verbatim.
type SignedUploadRequest struct {
	URL     string
	Key     string
	Headers map[string]string
}

// SignUploadRequest presigns one S3 request for uploading an attachment
// straight from the browser. Only the attachment's owner may upload, only to
// its own object key, only while the object is not yet final, and only the
// operations an upload needs.
func (s *AttachmentService) SignUploadRequest(ctx context.Context, userID, attachmentID string, req UploadRequest) (*SignedUploadRequest, error) {
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return nil, fmt.Errorf("attachment: get for upload: %w", err)
	}
	if a.CreatedBy != userID {
		return nil, ErrForbidden
	}
	if attachmentUploaded(a) {
		return nil, ErrAttachmentUploaded
	}
	if req.Key != a.S3Key {
		return nil, errors.New("attachment: upload key does not belong to this attachment")
	}
	query := url.Values{}
	headers := map[string]string{}
	switch {
	case req.UploadID == "" && req.Method == http.MethodPut:
		// Single-request upload: S3 itself checks the bytes against the
		// declared SHA-256, so verifying a non-image needs no read-back.
		headers["Content-Type"] = a.ContentType
		headers["x-amz-checksum-sha256"] = sha256Base64(a.SHA256)
	case req.UploadID == "" && req.Method == http.MethodPost:
		query.Set("uploads", "")
		headers["Content-Type"] = a.ContentType
	case req.UploadID == "":
		return nil, fmt.Errorf("attachment: unsupported upload request %s", req.Method)
	case req.Method == http.MethodPut:
		if req.PartNumber < 1 || req.PartNumber > maxMultipartParts {
			return nil, fmt.Errorf("attachment: invalid part number %d", req.PartNumber)
		}
		query.Set("partNumber", strconv.Itoa(req.PartNumber))
		query.Set("uploadId", req.UploadID)
	case req.Method == http.MethodGet, req.Method == http.MethodPost, req.Method == http.MethodDelete:
		// List parts (resume), complete, abort.
		query.Set("uploadId", req.UploadID)
	default:
		return nil, fmt.Errorf("attachment: unsupported upload request %s", req.Method)
	}
	if err := s.trackMultipartUpload(ctx, a, req); err != nil {
		return nil, err
	}
	signedURL, signedHeaders, err := s.signer.PresignRequest(ctx, req.Method, a.S3Key, query, headers, uploadRequestTTL)
	if err != nil {
		return nil, fmt.Errorf("attachment: sign upload request: %w", err)
	}
	return &SignedUploadRequest{URL: signedURL, Key: a.S3Key, Headers: signedHeaders}, nil
}

// trackMultipartUpload remembers the multipart upload a client is working on
// (the browser creates it directly with S3, so the first request naming it is
// where the server learns its ID), and forgets it on abort, so re-attaching
// the same file resumes exactly the upload that is still open.
func (s *AttachmentService) trackMultipartUpload(ctx context.Context, a *model.Attachment, req UploadRequest) error {
	next := a.MultipartUploadID
	switch {
	case req.UploadID != "" && req.Method == http.MethodDelete:
		next = ""
	case req.UploadID != "":
		next = req.UploadID
	}
	if next == a.MultipartUploadID {
		return nil
	}
	if err := s.attachments.SetMultipartUploadID(ctx, a.ID, next); err != nil {
		return fmt.Errorf("attachment: track multipart upload: %w", err)
	}
	a.MultipartUploadID = next
	return nil
}

// sha256Base64 converts a hex SHA-256 (as stored on the row, validated at
// upload-init) to the base64 form S3 uses in x-amz-checksum-sha256.
func sha256Base64(hexSum string) string {
	raw, _ := hex.DecodeString(hexSum)
	return base64.StdEncoding.EncodeToString(raw)
}

func attachmentNeedsThumbnails(contentType string) bool {
	declaredType := normalizeContentType(contentType)
	return strings.HasPrefix(declaredType, "image/") && declaredType != "image/svg+xml"
}

func (s *AttachmentService) ensureThumbnailKeys(ctx context.Context, a *model.Attachment) error {
	thumbnailKey, squareThumbnailKey := thumbnailObjectKeys(a)
	a.ThumbnailS3Key = thumbnailKey
	a.SquareThumbnailS3Key = squareThumbnailKey
	if err := s.attachments.SetThumbnailKeys(ctx, a.ID, a.ThumbnailS3Key, a.SquareThumbnailS3Key); err != nil {
		return fmt.Errorf("attachment: set thumbnail keys: %w", err)
	}
	return nil
}

// Get returns an attachment with a signed GET URL. Used by clients to
// render an attachment. URLs are served from a per-S3-key cache so
// repeated lookups within the cache window hand out the SAME URL —
// the browser image cache hits on every subsequent render instead of
// re-downloading because the signature query string changed.
//
// As a side effect, image attachments missing width/height (uploaded
// before the upload pipeline started recording dimensions) get a
// background backfill: we fetch ~256 KB from S3, decode the image
// header, and persist the dimensions. Subsequent reads return the
// stored values; this read may race ahead with zeros, which the
// frontend treats as "no width/height attribute" — same as today.
func (s *AttachmentService) Get(ctx context.Context, id string) (*model.Attachment, error) {
	a, err := s.attachments.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("attachment: get: %w", err)
	}
	s.finishRead(ctx, a)
	return a, nil
}

// finishRead applies the shared read-side enrichment: thumbnail assurance,
// presigned/media URLs and the legacy image-dimension backfill.
func (s *AttachmentService) finishRead(ctx context.Context, a *model.Attachment) {
	s.ensureThumbnailsForRead(ctx, a)
	if s.signer != nil && a.S3Key != "" {
		s.resolveAttachmentURLs(ctx, a)
	}
	if a.IsImage() && a.Width == 0 && a.Height == 0 && a.S3Key != "" && s.signer != nil {
		s.scheduleDimensionsBackfill(a.ID, a.S3Key)
	}
}

// batchAttachmentStore is the optional batched-read capability of the
// attachment store (the DynamoDB impl has it).
type batchAttachmentStore interface {
	GetAttachmentsByIDs(ctx context.Context, ids []string) ([]*model.Attachment, error)
}

// LoadForPreview resolves many attachments with ONE batched row read (per-ID
// fallback) plus the usual read-side enrichment, in input order. Missing or
// failed IDs are skipped — previews are best-effort. Access gating is the
// CALLER's job (message-link unfurl checks message access before calling).
func (s *AttachmentService) LoadForPreview(ctx context.Context, ids []string) []*model.Attachment {
	if len(ids) == 0 {
		return nil
	}
	byID := make(map[string]*model.Attachment, len(ids))
	if bs, ok := s.attachments.(batchAttachmentStore); ok {
		if atts, err := bs.GetAttachmentsByIDs(ctx, ids); err == nil {
			for _, a := range atts {
				byID[a.ID] = a
			}
		}
		// A batch failure degrades to "nothing resolved" — same skip-on-error
		// contract the per-ID loop below has for individual reads.
	} else {
		for _, id := range ids {
			if a, err := s.attachments.GetByID(ctx, id); err == nil && a != nil {
				byID[id] = a
			}
		}
	}
	out := make([]*model.Attachment, 0, len(ids))
	for _, id := range ids {
		a := byID[id]
		if a == nil {
			continue
		}
		s.finishRead(ctx, a)
		out = append(out, a)
	}
	return out
}

func (s *AttachmentService) GetForUser(ctx context.Context, userID, id, parentID, parentType, messageID string) (*model.Attachment, error) {
	a, err := s.attachments.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("attachment: get: %w", err)
	}
	allowed, err := s.canAccessAttachment(ctx, userID, a, parentID, parentType, messageID)
	if err != nil {
		// The access check could not run (transient store failure) — that is
		// NOT a denial. Fail the read so callers retry, instead of reporting
		// the attachment as gone.
		return nil, err
	}
	if !allowed {
		return nil, store.ErrNotFound
	}
	s.finishRead(ctx, a)
	return a, nil
}

// canAccessAttachment reports whether userID may read a. A returned error
// means the access check could not run (transient store failure) — it is NOT
// a verdict, and callers must fail their read rather than treat it as a
// denial. Collapsing that error into `false` (the old behavior) silently
// dropped attachments from batch responses on any DynamoDB blip; clients then
// cached the shrunken list as fresh truth and the attachments "disappeared"
// until a hard refresh.
func (s *AttachmentService) canAccessAttachment(ctx context.Context, userID string, a *model.Attachment, parentID, parentType, messageID string) (bool, error) {
	if userID == "" || a == nil {
		return false, nil
	}
	if a.CreatedBy == userID && len(a.MessageIDs) == 0 {
		return true, nil
	}
	if parentID == "" || parentType == "" || messageID == "" || s.accessChecker == nil {
		return false, nil
	}
	err := s.accessChecker.CanAccessMessageAttachment(ctx, userID, parentID, parentType, messageID, a.ID)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, ErrForbidden) || errors.Is(err, store.ErrNotFound):
		// Definitive: not a member, message gone, or the message does not
		// reference this attachment.
		return false, nil
	default:
		return false, err
	}
}

func (s *AttachmentService) resolveAttachmentURLs(ctx context.Context, a *model.Attachment) {
	if s.mediaCache != nil {
		if mediaURL, err := s.mediaURL(ctx, a); err == nil {
			a.URL = mediaURL
		}
	}
	if a.URL == "" {
		if url, err := s.urlCache.getOrSign(ctx, presignedKey{op: "get", key: a.S3Key},
			func(ctx context.Context) (string, error) {
				return s.signer.PresignedGetURL(ctx, a.S3Key, AttachmentURLTTL)
			}); err == nil {
			a.URL = url
		}
	}
	if dl, err := s.urlCache.getOrSign(ctx, presignedKey{op: "download", key: a.S3Key, extra: a.Filename},
		func(ctx context.Context) (string, error) {
			return s.signer.PresignedDownloadURL(ctx, a.S3Key, a.Filename, AttachmentURLTTL)
		}); err == nil {
		a.DownloadURL = dl
	}
	if a.ThumbnailS3Key != "" {
		if s.mediaCache != nil {
			if mediaURL, err := s.mediaURLForObject(ctx, "attachment-thumb", a.ID, a.ThumbnailS3Key, thumbnailFilename(a.Filename), "image/webp", 0); err == nil {
				a.ThumbnailURL = mediaURL
			}
		}
		if a.ThumbnailURL == "" {
			if url, err := s.urlCache.getOrSign(ctx, presignedKey{op: "thumb", key: a.ThumbnailS3Key},
				func(ctx context.Context) (string, error) {
					return s.signer.PresignedGetURL(ctx, a.ThumbnailS3Key, AttachmentURLTTL)
				}); err == nil {
				a.ThumbnailURL = url
			}
		}
	}
	if a.SquareThumbnailS3Key != "" {
		if s.mediaCache != nil {
			if mediaURL, err := s.mediaURLForObject(ctx, "attachment-square-thumb", a.ID, a.SquareThumbnailS3Key, squareThumbnailFilename(a.Filename), "image/webp", 0); err == nil {
				a.SquareThumbnailURL = mediaURL
			}
		}
		if a.SquareThumbnailURL == "" {
			if url, err := s.urlCache.getOrSign(ctx, presignedKey{op: "square-thumb", key: a.SquareThumbnailS3Key},
				func(ctx context.Context) (string, error) {
					return s.signer.PresignedGetURL(ctx, a.SquareThumbnailS3Key, AttachmentURLTTL)
				}); err == nil {
				a.SquareThumbnailURL = url
			}
		}
	}
}

func (s *AttachmentService) mediaURL(ctx context.Context, a *model.Attachment) (string, error) {
	return s.mediaURLForObject(ctx, "attachment", a.ID, a.S3Key, a.Filename, a.ContentType, a.Size)
}

func (s *AttachmentService) mediaURLForObject(ctx context.Context, namespace, id, s3Key, filename, contentType string, size int64) (string, error) {
	return StableMediaURL(ctx, s.mediaCache, namespace, id, s3Key, filename, contentType, size)
}

func thumbnailFilename(filename string) string {
	if filename == "" {
		return "thumbnail.webp"
	}
	return filename + ".thumb.webp"
}

func squareThumbnailFilename(filename string) string {
	if filename == "" {
		return "thumbnail-square.webp"
	}
	return filename + ".square.webp"
}

func (s *AttachmentService) ensureThumbnailsForRead(ctx context.Context, a *model.Attachment) {
	if s.signer == nil || a == nil || a.S3Key == "" || a.Size <= 0 || a.SHA256 == "" {
		return
	}
	if !attachmentNeedsThumbnails(a.ContentType) || (a.ThumbnailS3Key != "" && a.SquareThumbnailS3Key != "") {
		return
	}
	// An image already known to exceed the decode budget never gets
	// thumbnails; re-streaming it on every read would only rediscover that.
	if imageDecodeCost(a.Width, a.Height) > maxImageDecodeBytes {
		return
	}
	_ = s.ensureVerified(ctx, a)
}

func (s *AttachmentService) OpenMedia(ctx context.Context, token string) (*MediaObject, error) {
	return OpenStableMedia(ctx, s.mediaCache, s.signer, token)
}

// scheduleDimensionsBackfill kicks off a one-shot goroutine that
// reads the image header from S3, decodes its dimensions, and
// persists them. Bounded via inFlightBackfills so a hot list of
// pre-feature attachments doesn't spawn N copies of the same fetch.
func (s *AttachmentService) scheduleDimensionsBackfill(id, s3Key string) {
	if id == "" || s3Key == "" {
		return
	}
	s.backfillMu.Lock()
	if s.inFlightBackfills == nil {
		s.inFlightBackfills = make(map[string]struct{})
	}
	if _, busy := s.inFlightBackfills[id]; busy {
		s.backfillMu.Unlock()
		return
	}
	s.inFlightBackfills[id] = struct{}{}
	s.backfillMu.Unlock()
	go func() {
		defer safe.Recover()
		defer func() {
			s.backfillMu.Lock()
			delete(s.inFlightBackfills, id)
			s.backfillMu.Unlock()
		}()
		// New context: the request that triggered the backfill may
		// finish (and cancel its context) before we're done — we
		// don't want to drop the persistence write on its way out.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// 256 KB is enough for every common image format's header
		// (JPEG, PNG, GIF, WebP). Decoding configs reads only the
		// dimensions, not the pixel data.
		buf, err := s.signer.GetObjectRange(ctx, s3Key, 256*1024)
		if err != nil || len(buf) == 0 {
			return
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(buf))
		if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
			return
		}
		_ = s.attachments.SetDimensions(ctx, id, cfg.Width, cfg.Height)
	}()
}

// GetMany resolves a list of attachment IDs in parallel. Missing IDs are
// skipped silently — the caller can detect them by comparing returned IDs.
// Order matches the input.
func (s *AttachmentService) GetMany(ctx context.Context, ids []string) ([]*model.Attachment, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	results := make([]*model.Attachment, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		if id == "" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			defer safe.Recover()
			if a, err := s.Get(ctx, id); err == nil {
				results[i] = a
			}
		}(i, id)
	}
	wg.Wait()
	out := make([]*model.Attachment, 0, len(ids))
	for _, a := range results {
		if a != nil {
			out = append(out, a)
		}
	}
	return out, nil
}

// batchAccessChecker is the optional batch form of AttachmentAccessChecker
// (MessageService has it): every attachment in a request shares the same
// (parent, message), so ONE membership read + ONE message read answer the
// whole batch instead of repeating both per attachment.
type batchAccessChecker interface {
	MessageAttachmentIDs(ctx context.Context, userID, parentID, parentType, messageID string) (map[string]bool, error)
}

func (s *AttachmentService) GetManyForUser(ctx context.Context, userID string, ids []string, parentID, parentType, messageID string) ([]*model.Attachment, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > MaxAttachmentBatchIDs {
		return nil, fmt.Errorf("attachment: too many IDs")
	}
	// Resolve the message's referenced-attachment set once for the whole
	// batch. nil = capability unavailable → per-item checks below.
	var allowedIDs map[string]bool
	if bc, ok := s.accessChecker.(batchAccessChecker); ok && userID != "" && parentID != "" && parentType != "" && messageID != "" {
		set, err := bc.MessageAttachmentIDs(ctx, userID, parentID, parentType, messageID)
		switch {
		case err == nil:
			allowedIDs = set
		case errors.Is(err, ErrForbidden) || errors.Is(err, store.ErrNotFound):
			// Definitive denial (not a member, message gone): only the
			// owner-of-unattached rule below can still allow an item.
			allowedIDs = map[string]bool{}
		default:
			// The check could not run — fail the batch rather than shrink it
			// (same contract as the per-item arm below).
			return nil, err
		}
	}
	results := make([]*model.Attachment, len(ids))
	errs := make([]error, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		if id == "" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			defer safe.Recover()
			if allowedIDs != nil {
				a, err := s.attachments.GetByID(ctx, id)
				if err != nil {
					errs[i] = fmt.Errorf("attachment: get: %w", err)
					return
				}
				// Same rules as canAccessAttachment, minus the per-item
				// message read: referenced by the checked message, or the
				// caller's own not-yet-attached upload.
				ownUnattached := a.CreatedBy == userID && len(a.MessageIDs) == 0
				if !allowedIDs[a.ID] && !ownUnattached {
					errs[i] = store.ErrNotFound
					return
				}
				s.finishRead(ctx, a)
				results[i] = a
				return
			}
			a, err := s.GetForUser(ctx, userID, id, parentID, parentType, messageID)
			if err != nil {
				errs[i] = err
				return
			}
			results[i] = a
		}(i, id)
	}
	wg.Wait()
	// A missing or definitively denied attachment is filtered from the
	// response; a TRANSIENT failure fails the whole batch instead. Silently
	// filtering on transient errors made attachments vanish from the UI: the
	// client cached the shrunken 200 as fresh truth, and only a hard refresh
	// brought the attachments back.
	for _, err := range errs {
		if err == nil || errors.Is(err, store.ErrNotFound) {
			continue
		}
		return nil, err
	}
	out := make([]*model.Attachment, 0, len(ids))
	for _, a := range results {
		if a != nil {
			out = append(out, a)
		}
	}
	return out, nil
}

// AddRef binds an attachment to a message. Called by MessageService.Send.
func (s *AttachmentService) AddRef(ctx context.Context, attachmentID, messageID string) error {
	return s.attachments.AddRef(ctx, attachmentID, messageID)
}

// ValidateForUse proves that an attachment row points at an uploaded object
// whose immutable properties still match the metadata the row advertises.
// Message sends/edits call this before persisting attachment IDs supplied by
// the client, so a failed or tampered direct-to-S3 upload cannot become a
// message attachment.
func (s *AttachmentService) ValidateForUse(ctx context.Context, attachmentID string) error {
	if attachmentID == "" {
		return errors.New("attachment: id required")
	}
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return fmt.Errorf("attachment: get for validation: %w", err)
	}
	if s.signer == nil {
		return errors.New("attachment: storage not configured")
	}
	// ensureVerified persists the decoded (trusted) dimensions here too, not
	// only in ProcessUpload: a client that skips the process endpoint must not
	// get a message posted whose renderable dimensions the server never
	// confirmed. For decodable images the register-time client values are
	// only a hint; the bytes are the truth. Once verified, a send costs one
	// HEAD: the object is re-read only if it changed since.
	return s.ensureVerified(ctx, a)
}

// syncImageDimensions overwrites the stored width/height with the decoded
// image config when they disagree (covers register-time zero dims and any
// row that predates dimension collection). Non-image uploads decode to a
// zero config and are left untouched.
func (s *AttachmentService) syncImageDimensions(ctx context.Context, a *model.Attachment, cfg image.Config) error {
	if cfg.Width <= 0 || cfg.Height <= 0 || (a.Width == cfg.Width && a.Height == cfg.Height) {
		return nil
	}
	if err := s.attachments.SetDimensions(ctx, a.ID, cfg.Width, cfg.Height); err != nil {
		return fmt.Errorf("attachment: set dimensions: %w", err)
	}
	a.Width = cfg.Width
	a.Height = cfg.Height
	return nil
}

// ProcessUpload validates the object that was uploaded via the presigned PUT
// URL, persists trusted image dimensions, and generates server-side thumbnails.
// The frontend calls this immediately after the direct upload completes, before
// allowing the attachment to be posted in a message. ValidateForUse runs the
// same path as a final guard in case a client skips this endpoint.
func (s *AttachmentService) ProcessUpload(ctx context.Context, userID, attachmentID string) (*model.Attachment, error) {
	if userID == "" {
		return nil, errors.New("attachment: userID required")
	}
	if attachmentID == "" {
		return nil, errors.New("attachment: id required")
	}
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return nil, fmt.Errorf("attachment: get for processing: %w", err)
	}
	if a.CreatedBy != userID {
		return nil, ErrForbidden
	}
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	if err := s.ensureVerified(ctx, a); err != nil {
		return nil, err
	}
	if s.signer != nil && a.S3Key != "" {
		s.resolveAttachmentURLs(ctx, a)
	}
	return a, nil
}

// maxImageDecodeBytes caps the memory the thumbnail pipeline may spend on
// decoded pixels at once, process-wide. Decoding is the one step that cannot
// stream: a 12 MP photo needs ~100 MB of pixel buffers however small its file,
// so concurrent uploads — or a hostile file declaring huge dimensions — would
// otherwise exhaust the heap. An image whose estimate exceeds the whole budget
// is never decoded; it is still validated and attached, just without
// thumbnails (clients then show the file row and open the original).
const maxImageDecodeBytes int64 = 256 << 20

// decodeBytesPerPixel is deliberately pessimistic: a 16-bit PNG decodes to 8
// bytes per pixel, and a progressive JPEG holds coefficient buffers on top of
// its decoded planes.
const decodeBytesPerPixel = 8

// maxImageHeaderBytes bounds how far DecodeConfig may read looking for an
// image's dimensions (JPEG metadata segments precede the frame header). The
// bytes it consumes are buffered so the full decode can replay them.
const maxImageHeaderBytes = 16 << 20

var imageDecodeBudget = semaphore.NewWeighted(maxImageDecodeBytes)

func imageDecodeCost(width, height int) int64 {
	return int64(width) * int64(height) * decodeBytesPerPixel
}

// hashingReader feeds every byte read through it into h and counts them,
// remembering a transport failure so it is reported as one rather than as
// whichever validation step happened to be reading at the time.
type hashingReader struct {
	r   io.Reader
	h   hash.Hash
	n   int64
	err error
}

func (h *hashingReader) Read(p []byte) (int, error) {
	n, err := h.r.Read(p)
	h.h.Write(p[:n])
	h.n += int64(n)
	if err != nil && err != io.EOF {
		h.err = err
	}
	return n, err
}

// ensureVerified proves the stored object is the file the row advertises and
// records the verified version's ETag. It reads the object only when it has
// to: an already-verified, unchanged object costs one HEAD, and so does a
// non-image whose SHA-256 S3 checked on arrival (a single-request upload
// signed with x-amz-checksum-sha256). Everything else — images (their bytes
// must decode, and they need thumbnails) and multipart uploads (S3 holds no
// whole-file SHA-256 for those) — is streamed once through verifyObject.
func (s *AttachmentService) ensureVerified(ctx context.Context, a *model.Attachment) error {
	if a.S3Key == "" {
		return errors.New("attachment: missing storage key")
	}
	if a.Size <= 0 {
		return errors.New("attachment: invalid size")
	}
	size, objectContentType, etag, checksum, err := s.signer.StatObject(ctx, a.S3Key)
	if err != nil {
		return fmt.Errorf("attachment: object missing: %w", err)
	}
	if size != a.Size {
		return fmt.Errorf("attachment: object size mismatch: got %d want %d", size, a.Size)
	}
	thumbsMissing := attachmentNeedsThumbnails(a.ContentType) && (a.ThumbnailS3Key == "" || a.SquareThumbnailS3Key == "")
	if a.VerifiedETag != "" && etag == a.VerifiedETag && !thumbsMissing {
		return nil
	}
	if checksum != "" && !strings.HasPrefix(normalizeContentType(a.ContentType), "image/") {
		if err := checkObjectContentType(a.ContentType, objectContentType); err != nil {
			return err
		}
		if checksum != sha256Base64(a.SHA256) {
			return errors.New("attachment: sha256 mismatch")
		}
		return s.recordVerified(ctx, a, etag)
	}
	// A changed (or never verified) object gets fresh thumbnails.
	verifiedETag, err := s.verifyObject(ctx, a, etag != a.VerifiedETag)
	if err != nil {
		return err
	}
	return s.recordVerified(ctx, a, verifiedETag)
}

func (s *AttachmentService) recordVerified(ctx context.Context, a *model.Attachment, etag string) error {
	if etag == a.VerifiedETag {
		return nil
	}
	if err := s.attachments.SetVerifiedETag(ctx, a.ID, etag); err != nil {
		return fmt.Errorf("attachment: record verification: %w", err)
	}
	a.VerifiedETag = etag
	return nil
}

// verifyObject streams the uploaded object exactly once and proves it is the
// file the row advertises: byte count, SHA-256 and declared content type
// (raster images must decode to the declared format and dimensions, SVGs must
// be script-free). It then persists the decoded dimensions and, for raster
// images, writes thumbnails when they are missing or regenerate asks for
// fresh ones. It returns the ETag of the version it read.
//
// The file itself is never held in memory: bytes are hashed as they stream
// past, and only an image's decoded pixels are buffered, under
// imageDecodeBudget. Reading whole objects into a []byte — once on process and
// again on every send — made large uploads exhaust the heap and crash.
func (s *AttachmentService) verifyObject(ctx context.Context, a *model.Attachment, regenerate bool) (string, error) {
	body, objectContentType, objectSize, etag, err := s.signer.OpenObject(ctx, a.S3Key)
	if err != nil {
		return "", fmt.Errorf("attachment: object missing: %w", err)
	}
	defer func() { _ = body.Close() }()
	if objectSize > 0 && objectSize != a.Size {
		return "", fmt.Errorf("attachment: object size mismatch: got %d want %d", objectSize, a.Size)
	}

	stream := &hashingReader{r: io.LimitReader(body, a.Size+1), h: sha256.New()}
	src := bufio.NewReaderSize(stream, 64<<10)
	wantThumbs := attachmentNeedsThumbnails(a.ContentType) &&
		(regenerate || a.ThumbnailS3Key == "" || a.SquareThumbnailS3Key == "")
	cfg, img, release, contentErr := inspectContent(ctx, a, objectContentType, src, wantThumbs)
	defer release()
	// Drain whatever the content checks left unread so the hash covers every
	// byte. A content error is reported only after the size and hash checks,
	// so a tampered object reads as tampered rather than as malformed.
	_, _ = io.Copy(io.Discard, src)
	if stream.err != nil {
		return "", fmt.Errorf("attachment: read object: %w", stream.err)
	}
	if stream.n != a.Size {
		return "", fmt.Errorf("attachment: object size mismatch: got %d want %d", stream.n, a.Size)
	}
	if !strings.EqualFold(hex.EncodeToString(stream.h.Sum(nil)), a.SHA256) {
		return "", errors.New("attachment: sha256 mismatch")
	}
	if contentErr != nil {
		return "", contentErr
	}
	if err := s.syncImageDimensions(ctx, a, cfg); err != nil {
		return "", err
	}
	if img != nil {
		if err := s.storeThumbnails(ctx, a, img, release); err != nil {
			return "", err
		}
	}
	return etag, nil
}

func normalizeContentType(ct string) string {
	return strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
}

// checkObjectContentType rejects an object whose stored Content-Type
// contradicts the declared one (octet-stream declarations accept anything).
func checkObjectContentType(declared, objectContentType string) error {
	declared = normalizeContentType(declared)
	objectContentType = normalizeContentType(objectContentType)
	if objectContentType != "" && declared != "" && objectContentType != declared && declared != "application/octet-stream" {
		return fmt.Errorf("attachment: object content type %q does not match declared %q", objectContentType, declared)
	}
	return nil
}

// inspectContent checks the streamed bytes against the declared content type
// and, for a raster image when decode is set, decodes its pixels — unless the
// image would not fit imageDecodeBudget, in which case it gets no thumbnails.
// release hands the decoded image's budget back; it is always safe to call,
// and to call more than once.
func inspectContent(ctx context.Context, a *model.Attachment, objectContentType string, r *bufio.Reader, decode bool) (image.Config, image.Image, func(), error) {
	noop := func() {}
	var cfg image.Config
	if err := checkObjectContentType(a.ContentType, objectContentType); err != nil {
		return cfg, nil, noop, err
	}
	declared := normalizeContentType(a.ContentType)
	if !strings.HasPrefix(declared, "image/") {
		return cfg, nil, noop, nil
	}
	if declared == "image/svg+xml" {
		return cfg, nil, noop, validateSVG(r)
	}
	// Peek's error is irrelevant here: a short object just sniffs what it
	// has, and a transport failure resurfaces on the next read.
	sniff, _ := r.Peek(512)
	if http.DetectContentType(sniff) == "application/octet-stream" {
		return cfg, nil, noop, errors.New("attachment: could not detect image content type")
	}
	var header bytes.Buffer
	cfg, format, err := image.DecodeConfig(io.TeeReader(io.LimitReader(r, maxImageHeaderBytes), &header))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return cfg, nil, noop, errors.New("attachment: invalid image")
	}
	if a.Width > 0 && a.Width != cfg.Width {
		return cfg, nil, noop, fmt.Errorf("attachment: image width mismatch: got %d want %d", cfg.Width, a.Width)
	}
	if a.Height > 0 && a.Height != cfg.Height {
		return cfg, nil, noop, fmt.Errorf("attachment: image height mismatch: got %d want %d", cfg.Height, a.Height)
	}
	expectedFormat := strings.TrimPrefix(declared, "image/")
	if expectedFormat == "jpg" {
		expectedFormat = "jpeg"
	}
	if format != expectedFormat {
		return cfg, nil, noop, fmt.Errorf("attachment: image format %q does not match declared %q", format, declared)
	}
	cost := imageDecodeCost(cfg.Width, cfg.Height)
	if !decode || cost > maxImageDecodeBytes {
		return cfg, nil, noop, nil
	}
	if err := imageDecodeBudget.Acquire(ctx, cost); err != nil {
		return cfg, nil, noop, fmt.Errorf("attachment: wait for image decode: %w", err)
	}
	release := sync.OnceFunc(func() { imageDecodeBudget.Release(cost) })
	// DecodeConfig consumed the header from r; replay it ahead of the rest.
	img, _, err := image.Decode(io.MultiReader(&header, r))
	if err != nil {
		release()
		return cfg, nil, noop, fmt.Errorf("attachment: decode image for thumbnails: %w", err)
	}
	return cfg, img, release, nil
}

// storeThumbnails encodes both thumbnails, hands the decoded image's budget
// back, and only then uploads: the pixels are the expensive part, the encoded
// WebPs are a few KB.
func (s *AttachmentService) storeThumbnails(ctx context.Context, a *model.Attachment, img image.Image, release func()) error {
	thumbnailKey, squareThumbnailKey := thumbnailObjectKeys(a)
	messageThumb := mustThumb(encodeWebPThumbnail(img, thumbnailModeMessage))
	squareThumb := mustThumb(encodeWebPThumbnail(img, thumbnailModeSquare))
	release()
	if err := s.signer.PutObject(ctx, thumbnailKey, "image/webp", messageThumb); err != nil {
		return fmt.Errorf("attachment: store message thumbnail: %w", err)
	}
	if err := s.signer.PutObject(ctx, squareThumbnailKey, "image/webp", squareThumb); err != nil {
		return fmt.Errorf("attachment: store square thumbnail: %w", err)
	}
	if err := s.attachments.SetThumbnailKeys(ctx, a.ID, thumbnailKey, squareThumbnailKey); err != nil {
		return fmt.Errorf("attachment: set thumbnail keys: %w", err)
	}
	a.ThumbnailS3Key = thumbnailKey
	a.SquareThumbnailS3Key = squareThumbnailKey
	s.urlCache.invalidate(a.ThumbnailS3Key)
	s.urlCache.invalidate(a.SquareThumbnailS3Key)
	return nil
}

func thumbnailObjectKeys(a *model.Attachment) (string, string) {
	thumbnailKey := a.ThumbnailS3Key
	if thumbnailKey == "" {
		thumbnailKey = "attachments/" + a.ID + "/thumb-message@2x.webp"
	}
	squareThumbnailKey := a.SquareThumbnailS3Key
	if squareThumbnailKey == "" {
		squareThumbnailKey = "attachments/" + a.ID + "/thumb-square@2x.webp"
	}
	return thumbnailKey, squareThumbnailKey
}

type thumbnailMode int

const (
	thumbnailModeMessage thumbnailMode = iota
	thumbnailModeSquare
)

// webpEncode is a seam over nativewebp.Encode so tests can exercise the
// encode-failure panic arm; a real failure here is a programmer fault.
var webpEncode = nativewebp.Encode

func encodeWebPThumbnail(src image.Image, mode thumbnailMode) ([]byte, error) {
	if src == nil {
		return nil, errors.New("missing image")
	}
	srcBounds := src.Bounds()
	srcWidth := srcBounds.Dx()
	srcHeight := srcBounds.Dy()
	if srcWidth <= 0 || srcHeight <= 0 {
		return nil, errors.New("invalid image dimensions")
	}

	drawSrc := src
	srcRect := srcBounds
	var dstWidth int
	var dstHeight int
	if mode == thumbnailModeSquare {
		side := min(srcWidth, srcHeight)
		x0 := srcBounds.Min.X + (srcWidth-side)/2
		y0 := srcBounds.Min.Y + (srcHeight-side)/2
		srcRect = image.Rect(x0, y0, x0+side, y0+side)
		dstWidth = squareThumbnailSize
		dstHeight = squareThumbnailSize
	} else {
		scale := min(1, min(
			float64(messageThumbnailMaxWidth)/float64(srcWidth),
			float64(messageThumbnailMaxHeight)/float64(srcHeight),
		))
		dstWidth = max(1, int(float64(srcWidth)*scale+0.5))
		dstHeight = max(1, int(float64(srcHeight)*scale+0.5))
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dstWidth, dstHeight))
	stddraw.Draw(dst, dst.Bounds(), image.Transparent, image.Point{}, stddraw.Src)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), drawSrc, srcRect, stddraw.Over, nil)

	var out bytes.Buffer
	if err := webpEncode(&out, dst, nil); err != nil {
		// dst is a freshly allocated *image.NRGBA with positive, bounded
		// dimensions — an encode failure is a programmer/encoder fault, not
		// a runtime condition.
		panic(fmt.Sprintf("attachment: webp encode of a valid in-memory image failed: %v", err))
	}
	return out.Bytes(), nil
}

func validateSVG(r io.Reader) error {
	decoder := xml.NewDecoder(r)
	sawRoot := false
	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("attachment: invalid svg")
		}
		start, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		name := strings.ToLower(start.Name.Local)
		if !sawRoot {
			if name != "svg" {
				return errors.New("attachment: invalid svg root")
			}
			sawRoot = true
		}
		if name == "script" || name == "foreignobject" {
			return errors.New("attachment: unsafe svg")
		}
		for _, attr := range start.Attr {
			attrName := strings.ToLower(attr.Name.Local)
			attrValue := strings.ToLower(strings.TrimSpace(attr.Value))
			if strings.HasPrefix(attrName, "on") || ((attrName == "href" || attrName == "src") && strings.HasPrefix(attrValue, "javascript:")) {
				return errors.New("attachment: unsafe svg")
			}
		}
	}
	if !sawRoot {
		return errors.New("attachment: invalid svg")
	}
	return nil
}

func validSHA256Hex(v string) bool {
	if len(v) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(v)
	return err == nil && len(decoded) == sha256.Size
}

// RemoveRef releases a message's claim on an attachment. When the last
// reference is removed the underlying S3 object and Attachment row are GC'd.
func (s *AttachmentService) RemoveRef(ctx context.Context, attachmentID, messageID string) error {
	updated, err := s.attachments.RemoveRef(ctx, attachmentID, messageID)
	if err != nil {
		return err
	}
	if updated != nil && len(updated.MessageIDs) == 0 {
		// Last reference gone — GC.
		s.deleteAttachmentObjects(ctx, updated)
		_ = s.attachments.Delete(ctx, attachmentID)
		events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventAttachmentDeleted, map[string]any{
			"id": attachmentID,
		})
	}
	return nil
}

// DeleteDraft removes an unattached (draft) attachment — invoked when the user
// removes the chip in the message composer before sending. Refuses to delete
// if any message references it (i.e. the same hash is in use elsewhere).
func (s *AttachmentService) DeleteDraft(ctx context.Context, userID, attachmentID string) error {
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return fmt.Errorf("attachment: get for delete: %w", err)
	}
	if a.CreatedBy != userID {
		return errors.New("attachment: not authorized")
	}
	if len(a.MessageIDs) > 0 {
		return errors.New("attachment: still referenced by sent messages")
	}
	s.deleteAttachmentObjects(ctx, a)
	if err := s.attachments.Delete(ctx, attachmentID); err != nil {
		return fmt.Errorf("attachment: delete: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventAttachmentDeleted, map[string]any{
		"id": attachmentID,
	})
	return nil
}

func (s *AttachmentService) deleteAttachmentObjects(ctx context.Context, a *model.Attachment) {
	if a == nil {
		return
	}
	if s.signer != nil {
		for _, key := range []string{a.S3Key, a.ThumbnailS3Key, a.SquareThumbnailS3Key} {
			if key != "" {
				_ = s.signer.DeleteObject(ctx, key)
			}
		}
	}
	for _, key := range []string{a.S3Key, a.ThumbnailS3Key, a.SquareThumbnailS3Key} {
		if key != "" {
			s.urlCache.invalidate(key)
		}
	}
}
