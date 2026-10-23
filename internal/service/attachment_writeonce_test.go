package service

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// abortRecorder adds server-side multipart aborts to the fake signer.
type abortRecorder struct {
	*fakeAttachmentSigner
	aborted  []string
	abortErr error
}

func (r *abortRecorder) AbortMultipartUpload(_ context.Context, _, uploadID string) error {
	r.aborted = append(r.aborted, uploadID)
	return r.abortErr
}

func writeOnceFixture(t *testing.T, signer AttachmentSigner) (*AttachmentService, *mockAttachmentStore, *model.Attachment) {
	t.Helper()
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "up", SHA256: testSHA256A, Size: 10, ContentType: "application/zip",
		Filename: "f.zip", S3Key: "attachments/up", CreatedBy: "u1", CreatedAt: time.Now(),
	}
	if err := storeM.Create(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	return NewAttachmentService(storeM, signer, newMockPublisher()), storeM, a
}

// The two requests that write the object — a single PUT and the multipart
// complete — are signed with If-None-Match: *, so S3 refuses them once the
// key holds anything: what the server verified can never be replaced through
// a URL it signed earlier (each stays valid for uploadRequestTTL).
func TestSignUploadRequest_WritesAreConditional(t *testing.T) {
	svc, _, a := writeOnceFixture(t, &abortRecorder{fakeAttachmentSigner: &fakeAttachmentSigner{}})
	ctx := context.Background()
	for _, tc := range []struct {
		req  UploadRequest
		want bool
	}{
		{UploadRequest{Method: http.MethodPut, Key: a.S3Key}, true},
		{UploadRequest{Method: http.MethodPost, Key: a.S3Key}, false}, // create
		{UploadRequest{Method: http.MethodPut, Key: a.S3Key, UploadID: "X", PartNumber: 1}, false},
		{UploadRequest{Method: http.MethodGet, Key: a.S3Key, UploadID: "X"}, false},
		{UploadRequest{Method: http.MethodPost, Key: a.S3Key, UploadID: "X"}, true}, // complete
		{UploadRequest{Method: http.MethodDelete, Key: a.S3Key, UploadID: "X"}, false},
	} {
		signed, err := svc.SignUploadRequest(ctx, "u1", a.ID, tc.req)
		if err != nil {
			t.Fatalf("%+v: %v", tc.req, err)
		}
		if got := signed.Headers["If-None-Match"] == "*"; got != tc.want {
			t.Errorf("%s uploadId=%q: If-None-Match signed = %v, want %v", tc.req.Method, tc.req.UploadID, got, tc.want)
		}
	}
}

// One multipart upload per attachment: when the client moves on to a new one
// (the remembered upload expired), the server aborts the old one, so nothing
// signed for it can complete later.
func TestSignUploadRequest_SwitchingUploadsAbortsThePreviousOne(t *testing.T) {
	signer := &abortRecorder{fakeAttachmentSigner: &fakeAttachmentSigner{}}
	svc, storeM, a := writeOnceFixture(t, signer)
	ctx := context.Background()
	for _, id := range []string{"X", "X", "Y"} {
		if _, err := svc.SignUploadRequest(ctx, "u1", a.ID, UploadRequest{Method: http.MethodPut, Key: a.S3Key, UploadID: id, PartNumber: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(signer.aborted, []string{"X"}) || storeM.byID[a.ID].MultipartUploadID != "Y" {
		t.Fatalf("aborted %v, tracking %q; want [X] and Y", signer.aborted, storeM.byID[a.ID].MultipartUploadID)
	}
	// A failed abort is not fatal: the complete is still conditional.
	signer.abortErr = errors.New("s3 down")
	if _, err := svc.SignUploadRequest(ctx, "u1", a.ID, UploadRequest{Method: http.MethodPut, Key: a.S3Key, UploadID: "Z", PartNumber: 1}); err != nil {
		t.Fatalf("abort failure surfaced: %v", err)
	}
}

// Once the object is verified, the upload it came from (or any other the
// server knows of) is aborted and forgotten.
func TestVerification_AbortsTheTrackedMultipartUpload(t *testing.T) {
	for _, abortErr := range []error{nil, errors.New("s3 down")} {
		payload := []byte("zip bytes!")
		signer := &abortRecorder{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}, objectContentType: "application/zip"}, abortErr: abortErr}
		svc, storeM, a := writeOnceFixture(t, signer)
		a.SHA256 = sha256Hex(payload)
		a.MultipartUploadID = "X"
		signer.objects[a.S3Key] = payload
		if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err != nil {
			t.Fatalf("ProcessUpload (abort err %v): %v", abortErr, err)
		}
		if !slices.Equal(signer.aborted, []string{"X"}) {
			t.Fatalf("aborted %v, want [X]", signer.aborted)
		}
		if got := storeM.byID[a.ID].MultipartUploadID; got != "" {
			t.Fatalf("still tracking %q after verification", got)
		}
	}
}

// failingUploadIDStore fails only the write that forgets a multipart upload.
type failingUploadIDStore struct{ *mockAttachmentStore }

func (failingUploadIDStore) SetMultipartUploadID(context.Context, string, string) error {
	return errors.New("dynamo down")
}

func TestVerification_ReportsAFailureToForgetTheUpload(t *testing.T) {
	payload := []byte("zip bytes!")
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, objectContentType: "application/zip"}
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "up", SHA256: sha256Hex(payload), Size: int64(len(payload)), ContentType: "application/zip",
		Filename: "f.zip", S3Key: "attachments/up", CreatedBy: "u1", MultipartUploadID: "X",
	}
	storeM.byID[a.ID] = a
	signer.objects[a.S3Key] = payload
	svc := NewAttachmentService(failingUploadIDStore{storeM}, signer, newMockPublisher())
	if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err == nil {
		t.Fatal("a failed write was not reported")
	}
}

// A key is write-once, so an upload whose object landed without the client
// hearing back would be refused forever on retry. Re-registering the same
// file settles it: a stored object that verifies makes the attachment final,
// one that does not is removed so the upload can start over.
func TestCreateUploadURL_SettlesAnUnfinishedUpload(t *testing.T) {
	ctx := context.Background()
	payload := []byte("zip bytes!")
	register := func(svc *AttachmentService, a *model.Attachment) *CreateUploadResult {
		t.Helper()
		res, err := svc.CreateUploadURL(ctx, CreateUploadParams{
			UserID: "u1", Filename: a.Filename, ContentType: a.ContentType, SHA256: a.SHA256, Size: a.Size,
		})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	t.Run("stored object verifies", func(t *testing.T) {
		signer := &abortRecorder{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}, objectContentType: "application/zip"}}
		svc, storeM, a := writeOnceFixture(t, signer)
		storeM.byHash[sha256Hex(payload)] = a
		a.SHA256 = sha256Hex(payload)
		signer.objects[a.S3Key] = payload
		if res := register(svc, a); !res.AlreadyExists || res.Attachment.ID != a.ID {
			t.Fatalf("AlreadyExists = %v for a stored, verifiable object", res.AlreadyExists)
		}
	})
	t.Run("stored object is something else", func(t *testing.T) {
		signer := &abortRecorder{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}, objectContentType: "application/zip"}}
		svc, storeM, a := writeOnceFixture(t, signer)
		storeM.byHash[sha256Hex(payload)] = a
		a.SHA256 = sha256Hex(payload)
		signer.objects[a.S3Key] = []byte("other byte")
		if res := register(svc, a); res.AlreadyExists {
			t.Fatal("a wrong object made the attachment final")
		}
		if !slices.Contains(signer.deleted, a.S3Key) {
			t.Fatalf("the wrong object was kept: deleted %v", signer.deleted)
		}
		// Removing it failing is logged; the registration still answers.
		signer.delErr = errors.New("s3 down")
		if res := register(svc, a); res.AlreadyExists {
			t.Fatal("a wrong object made the attachment final")
		}
	})
	t.Run("nothing stored yet", func(t *testing.T) {
		signer := &abortRecorder{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}}}
		svc, _, a := writeOnceFixture(t, signer)
		if res := register(svc, a); res.AlreadyExists || len(signer.deleted) != 0 {
			t.Fatalf("AlreadyExists %v, deleted %v; want a plain resume", res.AlreadyExists, signer.deleted)
		}
	})
}
