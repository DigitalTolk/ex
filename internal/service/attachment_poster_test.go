package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func posterService(t *testing.T) (*AttachmentService, *mockAttachmentStore, *fakeAttachmentSigner) {
	t.Helper()
	storeM := newMockAttachmentStore()
	storeM.byID["v1"] = &model.Attachment{
		ID: "v1", CreatedBy: "u1", Filename: "clip.mp4", ContentType: "video/mp4",
		S3Key: "attachments/v1/clip.mp4", Size: 1000, SHA256: "abc", Width: 1920, Height: 1080,
	}
	signer := &fakeAttachmentSigner{}
	return NewAttachmentService(storeM, signer, newMockPublisher()), storeM, signer
}

func jpegFrame(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, halves(w, h, 255), &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestSetVideoPoster_KeepsTheFrameAsTheVideosThumbnails(t *testing.T) {
	svc, storeM, signer := posterService(t)
	a, err := svc.SetVideoPoster(context.Background(), "u1", "v1", bytes.NewReader(jpegFrame(t, 960, 540)))
	if err != nil {
		t.Fatal(err)
	}
	stored := storeM.byID["v1"]
	if a.ThumbnailS3Key == "" || a.SquareThumbnailS3Key == "" || stored.ThumbnailS3Key != a.ThumbnailS3Key {
		t.Fatalf("thumbnail keys not kept: %+v", a)
	}
	for _, key := range []string{a.ThumbnailS3Key, a.SquareThumbnailS3Key} {
		if !isLossyWebP(signer.objects[key]) {
			t.Fatalf("%s is not a lossy WebP", key)
		}
	}
	thumb, _, err := image.Decode(bytes.NewReader(signer.objects[a.ThumbnailS3Key]))
	if err != nil {
		t.Fatal(err)
	}
	if b := thumb.Bounds(); b.Dx()*540 != b.Dy()*960 {
		t.Fatalf("thumbnail %v lost the frame's shape", b.Size())
	}
	// The video's own size, from its upload, stays.
	if a.Width != 1920 || a.Height != 1080 {
		t.Fatalf("dimensions = %dx%d", a.Width, a.Height)
	}
	if a.ThumbnailURL == "" {
		t.Fatal("no thumbnail URL")
	}
}

func TestSetVideoPoster_StandsInForAVideoSizeTheUploadDidNotSend(t *testing.T) {
	svc, storeM, _ := posterService(t)
	storeM.byID["v1"].Width, storeM.byID["v1"].Height = 0, 0
	a, err := svc.SetVideoPoster(context.Background(), "u1", "v1", bytes.NewReader(jpegFrame(t, 640, 360)))
	if err != nil {
		t.Fatal(err)
	}
	if a.Width != 640 || a.Height != 360 {
		t.Fatalf("dimensions = %dx%d, want the poster's", a.Width, a.Height)
	}
}

func TestSetVideoPoster_Refusals(t *testing.T) {
	frame := func(t *testing.T) []byte { return jpegFrame(t, 64, 36) }
	cases := []struct {
		name  string
		user  string
		setup func(*mockAttachmentStore)
		body  func(*testing.T) []byte
		want  error
	}{
		{"someone else's video", "u2", nil, frame, ErrForbidden},
		{"not a video", "u1", func(m *mockAttachmentStore) {
			m.byID["v1"].ContentType, m.byID["v1"].Filename = "application/pdf", "doc.pdf"
		}, frame, ErrValidation},
		{"a poster already", "u1", func(m *mockAttachmentStore) { m.byID["v1"].ThumbnailS3Key = "attachments/v1/thumb" }, frame, ErrAlreadyExists},
		{"too many bytes", "u1", nil, func(*testing.T) []byte { return make([]byte, maxPosterBytes+1) }, ErrValidation},
		{"not an image", "u1", nil, func(*testing.T) []byte { return []byte("not an image") }, ErrValidation},
		{"a header with no picture behind it", "u1", nil, func(*testing.T) []byte { return pngHeader(64, 36) }, ErrValidation},
		{"too many pixels", "u1", nil, func(*testing.T) []byte { return pngHeader(20000, 20000) }, ErrValidation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, storeM, signer := posterService(t)
			if tc.setup != nil {
				tc.setup(storeM)
			}
			_, err := svc.SetVideoPoster(context.Background(), tc.user, "v1", bytes.NewReader(tc.body(t)))
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if len(signer.objects) != 0 {
				t.Fatal("stored something")
			}
		})
	}
}

func TestSetVideoPoster_Failures(t *testing.T) {
	boom := errors.New("boom")
	t.Run("unknown attachment", func(t *testing.T) {
		svc, _, _ := posterService(t)
		if _, err := svc.SetVideoPoster(context.Background(), "u1", "nope", bytes.NewReader(nil)); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("no storage", func(t *testing.T) {
		svc := NewAttachmentService(newMockAttachmentStore(), nil, newMockPublisher())
		if _, err := svc.SetVideoPoster(context.Background(), "u1", "v1", bytes.NewReader(nil)); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("body fails", func(t *testing.T) {
		svc, _, _ := posterService(t)
		if _, err := svc.SetVideoPoster(context.Background(), "u1", "v1", failingBody{boom}); !errors.Is(err, boom) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("write fails", func(t *testing.T) {
		svc, _, signer := posterService(t)
		signer.putErr = boom
		if _, err := svc.SetVideoPoster(context.Background(), "u1", "v1", bytes.NewReader(jpegFrame(t, 64, 36))); !errors.Is(err, boom) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("size fails to save", func(t *testing.T) {
		svc, storeM, _ := posterService(t)
		storeM.byID["v1"].Width = 0
		storeM.setDimErr = boom
		if _, err := svc.SetVideoPoster(context.Background(), "u1", "v1", bytes.NewReader(jpegFrame(t, 64, 36))); !errors.Is(err, boom) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("cancelled while waiting to decode", func(t *testing.T) {
		svc, _, _ := posterService(t)
		if !imageDecodeBudget.TryAcquire(maxImageDecodeBytes) {
			t.Fatal("decode budget unexpectedly busy")
		}
		defer imageDecodeBudget.Release(maxImageDecodeBytes)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := svc.SetVideoPoster(ctx, "u1", "v1", bytes.NewReader(jpegFrame(t, 64, 36)))
		if err == nil || !strings.Contains(err.Error(), "wait for poster decode") {
			t.Fatalf("err = %v", err)
		}
	})
}
