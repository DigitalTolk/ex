//go:build integration

package importer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func bodyOf(s string) func(context.Context) (io.ReadCloser, error) {
	return func(context.Context) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(s)), nil }
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errFault }

func TestPutAttachment(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := AttachmentSpec{ID: "a1", Filename: "notes.txt", ContentType: "text/plain", Size: 5, CreatedBy: "u1", CreatedAt: t0}
	created, err := e.im.PutAttachment(ctx, spec, bodyOf("hello"))
	if err != nil || !created {
		t.Fatalf("put: %v %v", created, err)
	}
	sum := sha256.Sum256([]byte("hello"))
	if string(e.objects.objects["attachments/a1"]) != "hello" || e.objects.sums["attachments/a1"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("object = %q sum = %q", e.objects.objects["attachments/a1"], e.objects.sums["attachments/a1"])
	}
	a, err := store.NewAttachmentStore(e.db).GetByID(ctx, "a1")
	mustNoErr(t, err)
	if a.SHA256 != hex.EncodeToString(sum[:]) || a.Size != 5 || a.S3Key != "attachments/a1" || a.VerifiedETag == "" || !a.CreatedAt.Equal(t0) {
		t.Fatalf("record = %+v", a)
	}
	// Re-run: body is never opened.
	opened := false
	created, err = e.im.PutAttachment(ctx, spec, func(context.Context) (io.ReadCloser, error) { opened = true; return nil, errFault })
	if err != nil || created || opened {
		t.Fatalf("re-run: %v %v opened=%v", created, err, opened)
	}
	// Default content type.
	_, err = e.im.PutAttachment(ctx, AttachmentSpec{ID: "a2", Filename: "blob"}, bodyOf("x"))
	mustNoErr(t, err)
	b, _ := store.NewAttachmentStore(e.db).GetByID(ctx, "a2")
	if b.ContentType != "application/octet-stream" {
		t.Fatalf("content type = %q", b.ContentType)
	}
}

func TestPutAttachmentErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := AttachmentSpec{ID: "a1", Filename: "f"}

	none, _ := New(Deps{DB: e.db})
	_, err := none.PutAttachment(ctx, spec, bodyOf("x"))
	wantErr(t, err, ErrNoObjectStore)
	_, err = e.im.PutAttachment(ctx, AttachmentSpec{ID: "a1"}, bodyOf("x"))
	wantErr(t, err, ErrInvalidSpec)
	_, err = e.faulty(failOn("GetItem", 0)).PutAttachment(ctx, spec, bodyOf("x"))
	wantErr(t, err, errFault)
	_, err = e.im.PutAttachment(ctx, spec, func(context.Context) (io.ReadCloser, error) { return nil, errFault })
	wantErr(t, err, errFault)
	_, err = e.im.PutAttachment(ctx, spec, func(context.Context) (io.ReadCloser, error) { return io.NopCloser(failingReader{}), nil })
	wantErr(t, err, errFault)
	_, err = e.im.PutAttachment(ctx, AttachmentSpec{ID: "a1", Filename: "f", Size: 9}, bodyOf("x"))
	if err == nil || !strings.Contains(err.Error(), "expected 9") {
		t.Fatalf("size mismatch: %v", err)
	}
	_, err = e.im.PutAttachment(ctx, spec, bodyOf(""))
	wantErr(t, err, ErrInvalidSpec)

	origTemp, origRewind := tempFile, rewind
	t.Cleanup(func() { tempFile, rewind = origTemp, origRewind })
	tempFile = func(string, string) (*os.File, error) { return nil, errFault }
	_, err = e.im.PutAttachment(ctx, spec, bodyOf("x"))
	wantErr(t, err, errFault)
	tempFile = origTemp
	rewind = func(*os.File) error { return errFault }
	_, err = e.im.PutAttachment(ctx, spec, bodyOf("x"))
	wantErr(t, err, errFault)
	rewind = origRewind

	e.objects.err = errFault
	_, err = e.im.PutAttachment(ctx, spec, bodyOf("x"))
	wantErr(t, err, errFault)
	e.objects.err = nil

	_, err = e.faulty(failOn("PutItem", 0)).PutAttachment(ctx, spec, bodyOf("x"))
	wantErr(t, err, errFault)

	// Lost race: the record appeared between the lookup and the write.
	as := store.NewAttachmentStore(e.db)
	racer := &racingObjects{fakeObjects: e.objects, before: func() {
		mustNoErr(t, as.Create(ctx, &model.Attachment{ID: "a1", SHA256: "abc", Filename: "f"}))
	}}
	im, _ := New(Deps{DB: e.db, Objects: racer, TempDir: t.TempDir()})
	if created, err := im.PutAttachment(ctx, spec, bodyOf("x")); err != nil || created {
		t.Fatalf("race: %v %v", created, err)
	}
}

// racingObjects runs before ahead of the upload, to stage a concurrent writer.
type racingObjects struct {
	*fakeObjects
	before func()
}

func (r *racingObjects) PutChecksummedObject(ctx context.Context, key, ct string, body io.ReadSeeker, size int64, sha string) (string, error) {
	r.before()
	return r.fakeObjects.PutChecksummedObject(ctx, key, ct, body, size, sha)
}
