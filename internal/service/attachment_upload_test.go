package service

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func uploadFixture(t *testing.T) (*AttachmentService, *mockAttachmentStore, *fakeAttachmentSigner, *model.Attachment) {
	t.Helper()
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	a := &model.Attachment{
		ID: "att", CreatedBy: "u1", S3Key: "attachments/att", Filename: "spec.pdf",
		ContentType: "application/pdf", Size: 4, SHA256: testSHA256A,
	}
	storeM.byID[a.ID] = a
	return NewAttachmentService(storeM, signer, nil), storeM, signer, a
}

func TestSignUploadRequest_SinglePutIsChecksumBound(t *testing.T) {
	svc, _, signer, a := uploadFixture(t)
	signed, err := svc.SignUploadRequest(context.Background(), "u1", a.ID, UploadRequest{Method: http.MethodPut, Key: a.S3Key})
	if err != nil {
		t.Fatalf("SignUploadRequest: %v", err)
	}
	raw, _ := hex.DecodeString(testSHA256A)
	want := base64.StdEncoding.EncodeToString(raw)
	if signed.Headers["x-amz-checksum-sha256"] != want || signed.Headers["Content-Type"] != "application/pdf" {
		t.Fatalf("single PUT must be signed with the declared hash and type, got %v", signed.Headers)
	}
	if signed.Key != a.S3Key || !strings.HasPrefix(signed.URL, "https://s3.test/attachments/att") {
		t.Fatalf("unexpected signed request %#v", signed)
	}
	if call := signer.presigned[0]; call.method != http.MethodPut || len(call.query) != 0 {
		t.Fatalf("single PUT must carry no sub-resource, got %#v", call)
	}
}

func TestSignUploadRequest_MultipartLifecycle(t *testing.T) {
	svc, storeM, signer, a := uploadFixture(t)
	ctx := context.Background()
	sign := func(req UploadRequest) presignCall {
		t.Helper()
		req.Key = a.S3Key
		if _, err := svc.SignUploadRequest(ctx, "u1", a.ID, req); err != nil {
			t.Fatalf("sign %+v: %v", req, err)
		}
		return signer.presigned[len(signer.presigned)-1]
	}

	create := sign(UploadRequest{Method: http.MethodPost})
	if _, ok := create.query["uploads"]; !ok || create.headers["Content-Type"] != "application/pdf" {
		t.Fatalf("create must sign ?uploads with the declared type, got %#v", create)
	}
	part := sign(UploadRequest{Method: http.MethodPut, UploadID: "mpu-1", PartNumber: 3})
	if part.query.Get("partNumber") != "3" || part.query.Get("uploadId") != "mpu-1" {
		t.Fatalf("part must sign partNumber + uploadId, got %#v", part)
	}
	// The first request naming the upload is where the server learns its ID,
	// so re-attaching the file can resume it.
	if storeM.byID[a.ID].MultipartUploadID != "mpu-1" {
		t.Fatalf("multipart upload not tracked: %#v", storeM.byID[a.ID])
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		if call := sign(UploadRequest{Method: method, UploadID: "mpu-1"}); call.query.Get("uploadId") != "mpu-1" {
			t.Fatalf("%s must sign uploadId, got %#v", method, call)
		}
	}
	// A new upload replaces the remembered one; abort forgets it.
	sign(UploadRequest{Method: http.MethodPut, UploadID: "mpu-2", PartNumber: 1})
	if storeM.byID[a.ID].MultipartUploadID != "mpu-2" {
		t.Fatalf("new multipart upload not tracked: %#v", storeM.byID[a.ID])
	}
	sign(UploadRequest{Method: http.MethodDelete, UploadID: "mpu-2"})
	if storeM.byID[a.ID].MultipartUploadID != "" {
		t.Fatalf("aborted multipart upload still tracked: %#v", storeM.byID[a.ID])
	}
}

func TestSignUploadRequest_Rejections(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name    string
		mutate  func(*AttachmentService, *mockAttachmentStore, *fakeAttachmentSigner, *model.Attachment)
		user    string
		id      string
		req     UploadRequest
		wantErr error
	}{
		{name: "unknown attachment", id: "missing", req: UploadRequest{Method: http.MethodPut}, wantErr: store.ErrNotFound},
		{name: "not the owner", user: "u2", req: UploadRequest{Method: http.MethodPut}, wantErr: ErrForbidden},
		{name: "verified object is final", mutate: func(_ *AttachmentService, _ *mockAttachmentStore, _ *fakeAttachmentSigner, a *model.Attachment) {
			a.VerifiedETag = `"e"`
		}, req: UploadRequest{Method: http.MethodPut}, wantErr: ErrAttachmentUploaded},
		{name: "sent object is final", mutate: func(_ *AttachmentService, _ *mockAttachmentStore, _ *fakeAttachmentSigner, a *model.Attachment) {
			a.MessageIDs = []string{"m1"}
		}, req: UploadRequest{Method: http.MethodPost}, wantErr: ErrAttachmentUploaded},
		{name: "another key", req: UploadRequest{Method: http.MethodPut, Key: "attachments/other"}},
		{name: "delete without upload", req: UploadRequest{Method: http.MethodDelete}},
		{name: "part number zero", req: UploadRequest{Method: http.MethodPut, UploadID: "mpu", PartNumber: 0}},
		{name: "part number too high", req: UploadRequest{Method: http.MethodPut, UploadID: "mpu", PartNumber: maxMultipartParts + 1}},
		{name: "unsupported method", req: UploadRequest{Method: http.MethodHead, UploadID: "mpu"}},
		{name: "tracking fails", mutate: func(_ *AttachmentService, s *mockAttachmentStore, _ *fakeAttachmentSigner, _ *model.Attachment) {
			s.setUploadStateErr = errors.New("dynamo down")
		}, req: UploadRequest{Method: http.MethodPut, UploadID: "mpu", PartNumber: 1}},
		{name: "presign fails", mutate: func(_ *AttachmentService, _ *mockAttachmentStore, sig *fakeAttachmentSigner, _ *model.Attachment) {
			sig.presignErr = errors.New("no credentials")
		}, req: UploadRequest{Method: http.MethodPut}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, storeM, signer, a := uploadFixture(t)
			if tc.mutate != nil {
				tc.mutate(svc, storeM, signer, a)
			}
			user, id := tc.user, tc.id
			if user == "" {
				user = "u1"
			}
			if id == "" {
				id = a.ID
			}
			if tc.req.Key == "" {
				tc.req.Key = a.S3Key
			}
			_, err := svc.SignUploadRequest(ctx, user, id, tc.req)
			if err == nil {
				t.Fatal("expected an error")
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}

	svc := NewAttachmentService(newMockAttachmentStore(), nil, nil)
	if _, err := svc.SignUploadRequest(ctx, "u1", "att", UploadRequest{Method: http.MethodPut}); err == nil {
		t.Fatal("expected storage-not-configured error")
	}
}

// A non-image uploaded in one signed PUT was hash-checked by S3 on arrival,
// so processing it never reads it through: one HEAD proves size, type and
// SHA-256, and a PDF's first bytes prove it is one.
func TestProcessUpload_S3ChecksummedFileIsVerifiedWithoutReading(t *testing.T) {
	svc, storeM, signer, a := uploadFixture(t)
	body := []byte("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	a.SHA256 = sha256Hex(body)
	a.Size = int64(len(body))
	signer.objects[a.S3Key] = body
	signer.objectContentType = "application/pdf"
	signer.checksums = map[string]string{a.S3Key: sha256Base64(a.SHA256)}

	if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if signer.opens != 0 || signer.stats != 1 || signer.rangeReads != 1 {
		t.Fatalf("expected a single HEAD, a peek and no read, got stats=%d peeks=%d opens=%d", signer.stats, signer.rangeReads, signer.opens)
	}
	if storeM.byID[a.ID].VerifiedETag != fakeETag(body) {
		t.Fatalf("verified version not recorded: %#v", storeM.byID[a.ID])
	}

	// A wrong hash or a contradicting stored type is still caught from the HEAD.
	a.VerifiedETag = ""
	signer.checksums[a.S3Key] = sha256Base64(testSHA256A)
	if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected sha256 mismatch, got %v", err)
	}
	signer.objectContentType = "text/html"
	if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err == nil || !strings.Contains(err.Error(), "content type") {
		t.Fatalf("expected content type mismatch, got %v", err)
	}
	if signer.opens != 0 {
		t.Fatalf("checksummed file must never be read, got %d reads", signer.opens)
	}
}

// Images are always read once — their bytes must decode and they need
// thumbnails — even when S3 holds their checksum.
func TestProcessUpload_ChecksummedImageIsStillDecoded(t *testing.T) {
	svc, _, signer, a := uploadFixture(t)
	object := makePNG(6, 4)
	a.ContentType = "image/png"
	a.SHA256 = sha256Hex(object)
	a.Size = int64(len(object))
	signer.objects[a.S3Key] = object
	signer.checksums = map[string]string{a.S3Key: sha256Base64(a.SHA256)}
	processed, err := svc.ProcessUpload(context.Background(), "u1", a.ID)
	if err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if signer.opens != 1 || processed.ThumbnailS3Key == "" {
		t.Fatalf("image must be read once and thumbnailed, got opens=%d %#v", signer.opens, processed)
	}
}

// An object replaced after verification (its ETag changed) is read again,
// and its thumbnails regenerated, before it can be sent.
func TestValidateForUse_ReplacedObjectIsReVerified(t *testing.T) {
	svc, storeM, signer, a := uploadFixture(t)
	original := makePNG(6, 4)
	a.ContentType = "image/png"
	a.SHA256 = sha256Hex(original)
	a.Size = int64(len(original))
	a.ThumbnailS3Key, a.SquareThumbnailS3Key = "attachments/att/thumb-message@2x.webp", "attachments/att/thumb-square@2x.webp"
	a.VerifiedETag = `"stale"`
	signer.objects[a.S3Key] = original
	signer.putContentTypes = map[string]string{}

	if err := svc.ValidateForUse(context.Background(), a.ID); err != nil {
		t.Fatalf("ValidateForUse: %v", err)
	}
	if signer.opens != 1 || storeM.byID[a.ID].VerifiedETag != fakeETag(original) {
		t.Fatalf("changed object must be re-read and re-recorded, got opens=%d etag=%q", signer.opens, storeM.byID[a.ID].VerifiedETag)
	}
	if signer.putContentTypes[a.ThumbnailS3Key] != "image/webp" {
		t.Fatalf("changed image must get fresh thumbnails, puts=%v", signer.putContentTypes)
	}
}

// isoMedia is the head of an ISO media file (MP4 and kin): an ftyp box with
// the given major brand.
func isoMedia(brand string) []byte {
	head := []byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p'}
	head = append(head, brand...)
	head = append(head, 0, 0, 0, 0)
	head = append(head, "isommp41"...)
	return append(head, make([]byte, 64)...)
}

// A file that claims to be a PDF or an MP4 — by its declared type or by its
// extension — opens in the app's own viewer, so its bytes must be one.
func TestProcessUpload_ClaimedPDFOrVideoMustBeOne(t *testing.T) {
	cases := []struct {
		name, filename, contentType string
		body                        []byte
		ok                          bool
	}{
		{"a PDF", "spec.pdf", "application/pdf", []byte("%PDF-1.4\n1 0 obj\n"), true},
		{"a renamed text file", "spec.pdf", "application/pdf", []byte("just some text"), false},
		{"a PDF by its extension only", "spec.pdf", "application/octet-stream", []byte("<html><script>"), false},
		{"an MP4", "clip.mp4", "video/mp4", isoMedia("isom"), true},
		{"an M4V", "clip.m4v", "video/x-m4v", isoMedia("M4V "), true},
		{"a photo renamed .mp4", "clip.mp4", "video/mp4", isoMedia("heic"), false},
		{"audio renamed .mp4", "clip.mp4", "video/mp4", isoMedia("M4A "), false},
		{"a PNG called .mp4", "clip.mp4", "video/mp4", makePNG(2, 2), false},
		{"an MP4 by its extension only", "clip.mp4", "application/octet-stream", isoMedia("mp42"), true},
		{"a file that claims nothing", "notes.txt", "text/plain", []byte("%PDF-1.4"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, signer, a := uploadFixture(t)
			a.Filename, a.ContentType = tc.filename, tc.contentType
			a.SHA256, a.Size = sha256Hex(tc.body), int64(len(tc.body))
			signer.objects[a.S3Key] = tc.body
			signer.objectContentType = tc.contentType
			signer.checksums = map[string]string{a.S3Key: sha256Base64(a.SHA256)}
			_, err := svc.ProcessUpload(context.Background(), "u1", a.ID)
			if tc.ok && err != nil {
				t.Fatalf("ProcessUpload: %v", err)
			}
			if !tc.ok && (err == nil || !strings.Contains(err.Error(), tc.filename+" is not")) {
				t.Fatalf("expected a content rejection, got %v", err)
			}
		})
	}
}

// A file too large for one request (multipart, so S3 holds no hash of it) is
// streamed through once; its head is checked on the way.
func TestProcessUpload_StreamedClaimedVideoIsChecked(t *testing.T) {
	for _, tc := range []struct {
		body []byte
		ok   bool
	}{{isoMedia("mp42"), true}, {[]byte("PK\x03\x04 a zip"), false}} {
		svc, _, signer, a := uploadFixture(t)
		a.Filename, a.ContentType = "clip.mp4", "video/mp4"
		a.SHA256, a.Size = sha256Hex(tc.body), int64(len(tc.body))
		signer.objects[a.S3Key] = tc.body
		signer.objectContentType = "video/mp4"
		_, err := svc.ProcessUpload(context.Background(), "u1", a.ID)
		if (err == nil) != tc.ok {
			t.Fatalf("ok=%v: got %v", tc.ok, err)
		}
		if signer.opens != 1 {
			t.Fatalf("expected one streamed read, got %d", signer.opens)
		}
	}
}

// A peek that fails fails the check: an unread file isn't vouched for.
func TestProcessUpload_ClaimedFileUnreadable(t *testing.T) {
	svc, _, signer, a := uploadFixture(t)
	body := []byte("%PDF-1.4")
	a.SHA256, a.Size = sha256Hex(body), int64(len(body))
	signer.objects[a.S3Key] = body
	signer.objectContentType = "application/pdf"
	signer.checksums = map[string]string{a.S3Key: sha256Base64(a.SHA256)}
	signer.rangeErr = errors.New("s3 down")
	if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err == nil || !strings.Contains(err.Error(), "read object") {
		t.Fatalf("expected a read error, got %v", err)
	}
}
