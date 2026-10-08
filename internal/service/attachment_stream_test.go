package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash/crc32"
	"io"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// patternReader yields n deterministic bytes without ever holding them, so a
// test can serve an object far larger than anything it allocates.
type patternReader struct{ off, n int64 }

func (r *patternReader) Read(p []byte) (int, error) {
	if r.off >= r.n {
		return 0, io.EOF
	}
	if rem := r.n - r.off; int64(len(p)) > rem {
		p = p[:rem]
	}
	for i := range p {
		p[i] = byte((r.off + int64(i)) * 31)
	}
	r.off += int64(len(p))
	return len(p), nil
}

func patternSHA256(n int64) string {
	h := sha256.New()
	_, _ = io.Copy(h, &patternReader{n: n})
	return hex.EncodeToString(h.Sum(nil))
}

// streamingSigner serves a generated object of the given size and counts the
// body reads (gets) and HEADs (heads) it receives.
type streamingSigner struct {
	*fakeAttachmentSigner
	size        int64
	contentType string
	gets, heads int
}

func (s *streamingSigner) OpenObject(_ context.Context, _ string) (io.ReadCloser, string, int64, string, error) {
	s.gets++
	return io.NopCloser(&patternReader{n: s.size}), s.contentType, s.size, `"pattern"`, nil
}

func (s *streamingSigner) StatObject(_ context.Context, _ string) (int64, string, string, string, error) {
	s.heads++
	return s.size, s.contentType, `"pattern"`, "", nil
}

// pngHeaderOnly returns a PNG whose IHDR declares w×h but which carries no
// pixel data: enough for DecodeConfig, fatal for a full decode.
func pngHeaderOnly(w, h uint32) []byte {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	writePNGChunk(&b, "IHDR", ihdr)
	writePNGChunk(&b, "IEND", nil)
	return b.Bytes()
}

func writePNGChunk(b *bytes.Buffer, typ string, data []byte) {
	_ = binary.Write(b, binary.BigEndian, uint32(len(data)))
	crc := crc32.NewIEEE()
	b.WriteString(typ)
	crc.Write([]byte(typ))
	b.Write(data)
	crc.Write(data)
	_ = binary.Write(b, binary.BigEndian, crc.Sum32())
}

func assertDecodeBudgetFree(t *testing.T) {
	t.Helper()
	if !imageDecodeBudget.TryAcquire(maxImageDecodeBytes) {
		t.Fatal("image decode budget leaked: not fully released")
	}
	imageDecodeBudget.Release(maxImageDecodeBytes)
}

// Regression: verification used to io.ReadAll the whole object (on process
// AND again on every send), so a large upload cost a multiple of its size in
// heap and crashed the server. It must now stream, and only once.
func TestProcessUpload_StreamsLargeObjectsWithoutBuffering(t *testing.T) {
	const size = 64 << 20
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "big", CreatedBy: "u1", S3Key: "attachments/big", Filename: "big.zip",
		ContentType: "application/zip", Size: size, SHA256: patternSHA256(size),
	}
	storeM.byID[a.ID] = a
	signer := &streamingSigner{fakeAttachmentSigner: &fakeAttachmentSigner{}, size: size, contentType: "application/zip"}
	svc := NewAttachmentService(storeM, signer, nil)

	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if _, err := svc.ProcessUpload(context.Background(), "u1", a.ID); err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if err := svc.ValidateForUse(context.Background(), a.ID); err != nil {
		t.Fatalf("ValidateForUse: %v", err)
	}
	runtime.ReadMemStats(&after)
	if got := after.TotalAlloc - before.TotalAlloc; got > 8<<20 {
		t.Fatalf("verifying a %d MiB object allocated %d MiB; it must stream, not buffer", size>>20, got>>20)
	}
	// Process streams the object once; the send then only HEADs it, because
	// the verified version (ETag) is unchanged.
	if signer.gets != 1 || signer.heads != 2 {
		t.Fatalf("expected one streamed read and two HEADs, got gets=%d heads=%d", signer.gets, signer.heads)
	}
}

// Regression: a file declaring huge dimensions was fully decoded, so a tiny
// upload could demand gigabytes of pixel buffers. Images over the decode
// budget are validated and attached, but never decoded.
func TestProcessUpload_OversizedImageIsNeverDecoded(t *testing.T) {
	object := pngHeaderOnly(20000, 20000)
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "huge", CreatedBy: "u1", S3Key: "attachments/huge", Filename: "huge.png",
		ContentType: "image/png", Size: int64(len(object)), SHA256: sha256Hex(object),
	}
	storeM.byID[a.ID] = a
	signer := &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}, putContentTypes: map[string]string{}}
	svc := NewAttachmentService(storeM, signer, nil)

	// The header-only body would fail a real decode, so success proves the
	// decode was skipped.
	processed, err := svc.ProcessUpload(context.Background(), "u1", a.ID)
	if err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if processed.Width != 20000 || processed.Height != 20000 {
		t.Fatalf("dimensions not persisted from the header: %dx%d", processed.Width, processed.Height)
	}
	if processed.ThumbnailS3Key != "" || processed.SquareThumbnailS3Key != "" || len(signer.putContentTypes) != 0 {
		t.Fatalf("oversized image must not get thumbnails: %#v puts=%v", processed, signer.putContentTypes)
	}
	assertDecodeBudgetFree(t)
}

func TestProcessUpload_ReturnsDecodeBudget(t *testing.T) {
	ctx := context.Background()

	ok := makePNG(8, 6)
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "ok", CreatedBy: "u1", S3Key: "attachments/ok", Filename: "ok.png",
		ContentType: "image/png", Size: int64(len(ok)), SHA256: sha256Hex(ok),
	}
	storeM.byID[a.ID] = a
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: ok}}, nil)
	if _, err := svc.ProcessUpload(ctx, "u1", a.ID); err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if a.ThumbnailS3Key == "" || a.SquareThumbnailS3Key == "" {
		t.Fatalf("in-budget image must get thumbnails: %#v", a)
	}
	assertDecodeBudgetFree(t)

	// Valid header within budget but no pixel data: the decode fails and the
	// budget must still come back.
	broken := pngHeaderOnly(8, 6)
	b := &model.Attachment{
		ID: "broken", CreatedBy: "u1", S3Key: "attachments/broken", Filename: "broken.png",
		ContentType: "image/png", Size: int64(len(broken)), SHA256: sha256Hex(broken),
	}
	storeM.byID[b.ID] = b
	svc = NewAttachmentService(storeM, &fakeAttachmentSigner{objects: map[string][]byte{b.S3Key: broken}}, nil)
	if _, err := svc.ProcessUpload(ctx, "u1", b.ID); err == nil || !strings.Contains(err.Error(), "decode image for thumbnails") {
		t.Fatalf("expected decode error, got %v", err)
	}
	assertDecodeBudgetFree(t)
}

func TestProcessUpload_WaitsForDecodeBudget(t *testing.T) {
	object := makePNG(8, 6)
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", Filename: "a.png",
		ContentType: "image/png", Size: int64(len(object)), SHA256: sha256Hex(object),
	}
	storeM.byID[a.ID] = a
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}}, nil)

	if !imageDecodeBudget.TryAcquire(maxImageDecodeBytes) {
		t.Fatal("decode budget unexpectedly busy")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := svc.ProcessUpload(ctx, "u1", a.ID)
	imageDecodeBudget.Release(maxImageDecodeBytes)
	if err == nil || !strings.Contains(err.Error(), "wait for image decode") {
		t.Fatalf("expected a budget wait error while the budget is exhausted, got %v", err)
	}
	assertDecodeBudgetFree(t)
}

// The read path used to re-download (and re-decode) any image missing
// thumbnails on every read. An image already known to exceed the decode
// budget must not be fetched at all.
func TestEnsureThumbnailsForRead_SkipsKnownOversizedImages(t *testing.T) {
	signer := &streamingSigner{fakeAttachmentSigner: &fakeAttachmentSigner{}, size: 10, contentType: "image/png"}
	svc := NewAttachmentService(newMockAttachmentStore(), signer, nil)
	svc.ensureThumbnailsForRead(context.Background(), &model.Attachment{
		ID: "huge", S3Key: "attachments/huge", Size: 10, SHA256: "h", ContentType: "image/png",
		Width: 20000, Height: 20000,
	})
	if signer.gets != 0 || signer.heads != 0 {
		t.Fatalf("oversized image was fetched on read: gets=%d heads=%d", signer.gets, signer.heads)
	}
}
