package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/gen2brain/webp"

	"github.com/DigitalTolk/ex/internal/model"
)

// PutObject / DeleteObject complete the default emoji fake for the paths
// that keep a server-owned copy.
func (f *fakeEmojiSigner) PutObject(context.Context, string, string, []byte) error { return nil }
func (f *fakeEmojiSigner) DeleteObject(context.Context, string) error              { return nil }

// emojiBucket is a keyed in-memory bucket: what an upload URL wrote, and what
// the server kept.
type emojiBucket struct {
	objects  map[string][]byte
	types    map[string]string
	deleted  []string
	putErr   error
	delErr   error
	puts     int
	signedAs []string
}

func newEmojiBucket() *emojiBucket {
	return &emojiBucket{objects: map[string][]byte{}, types: map[string]string{}}
}

func (b *emojiBucket) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	b.signedAs = append(b.signedAs, key)
	return "https://signed.example/" + key, nil
}

func (b *emojiBucket) GetObject(_ context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	data, ok := b.objects[key]
	if !ok {
		return nil, "", 0, time.Time{}, fmt.Errorf("no object %s", key)
	}
	return io.NopCloser(bytes.NewReader(data)), b.types[key], int64(len(data)), time.Now(), nil
}

func (b *emojiBucket) PutObject(_ context.Context, key, contentType string, body []byte) error {
	b.puts++
	if b.putErr != nil {
		return b.putErr
	}
	b.objects[key] = append([]byte(nil), body...)
	b.types[key] = contentType
	return nil
}

func (b *emojiBucket) DeleteObject(_ context.Context, key string) error {
	b.deleted = append(b.deleted, key)
	if b.delErr != nil {
		return b.delErr
	}
	delete(b.objects, key)
	return nil
}

const emojiUploadKey = "uploads/u1/01UPLOAD/fire.png"

func emojiFixture(t *testing.T, data []byte, contentType string) (*EmojiService, *emojiBucket, *mockEmojiStore) {
	t.Helper()
	svc, store, users, _ := setupEmojiSvc()
	users.users["u1"] = &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
	bucket := newEmojiBucket()
	bucket.objects[emojiUploadKey] = data
	bucket.types[emojiUploadKey] = contentType
	svc.SetSigner(bucket)
	return svc, bucket, store
}

func solidImage(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.NRGBA{R: 200, G: uint8(x), B: uint8(y), A: 255})
		}
	}
	return img
}

// The upload URL stays valid for its lifetime, and the bytes behind it were
// validated once. The emoji is therefore served from a copy the server wrote
// (re-encoded, under a key no client can sign a PUT for), and the upload is
// removed.
func TestEmojiService_Create_ServesAServerOwnedCopy(t *testing.T) {
	upload := append(encodePNG(t, solidImage(40, 30)), []byte("<script>alert(1)</script>")...)
	svc, bucket, _ := emojiFixture(t, upload, "image/png")

	e, err := svc.Create(context.Background(), "u1", "fire", emojiUploadKey, false)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !strings.HasPrefix(e.ImageKey, "emojis/") {
		t.Fatalf("ImageKey = %q, want a server-owned emojis/ key", e.ImageKey)
	}
	kept := bucket.objects[e.ImageKey]
	if bucket.types[e.ImageKey] != "image/webp" || bytes.Contains(kept, []byte("<script>")) {
		t.Fatalf("kept %q (%d bytes) is not a clean re-encode", bucket.types[e.ImageKey], len(kept))
	}
	img, format, err := image.Decode(bytes.NewReader(kept))
	if err != nil || format != "webp" || img.Bounds().Dx() != 40 || img.Bounds().Dy() != 30 {
		t.Fatalf("kept image: %v %q %v", err, format, img)
	}
	if _, still := bucket.objects[emojiUploadKey]; still {
		t.Fatal("the upload was kept")
	}
	if e.ImageURL != "https://signed.example/"+e.ImageKey {
		t.Fatalf("ImageURL = %q, want the kept copy's URL", e.ImageURL)
	}
	// Whatever the (still valid) upload URL writes afterwards is not served.
	bucket.objects[emojiUploadKey] = []byte("<html>replaced</html>")
	if !bytes.Equal(bucket.objects[e.ImageKey], kept) {
		t.Fatal("the served copy changed with the upload key")
	}
}

func TestEmojiService_Create_ShrinksLargeEmoji(t *testing.T) {
	svc, bucket, _ := emojiFixture(t, encodePNG(t, solidImage(600, 300)), "image/png")
	e, err := svc.Create(context.Background(), "u1", "big", emojiUploadKey, false)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(bucket.objects[e.ImageKey]))
	if err != nil || cfg.Width != MaxEmojiSide || cfg.Height != MaxEmojiSide/2 {
		t.Fatalf("kept %dx%d (%v), want it shrunk to fit %d", cfg.Width, cfg.Height, err, MaxEmojiSide)
	}
}

// Animated emoji keep their frames: a GIF or an animated WebP is copied as
// validated (decoding every frame of a 512 KiB file can take gigabytes), still
// into the server-owned key.
func TestEmojiService_Create_CopiesAnimatedEmoji(t *testing.T) {
	var animGIF bytes.Buffer
	frame := func(c uint8) *image.Paletted {
		p := image.NewPaletted(image.Rect(0, 0, 8, 8), color.Palette{color.Black, color.Gray{Y: c}})
		p.SetColorIndex(1, 1, 1)
		return p
	}
	if err := gif.EncodeAll(&animGIF, &gif.GIF{Image: []*image.Paletted{frame(10), frame(200)}, Delay: []int{5, 5}}); err != nil {
		t.Fatal(err)
	}
	var animWebP bytes.Buffer
	// Two different frames: identical ones are merged into a still picture.
	if err := webp.EncodeAll(&animWebP, &webp.WEBP{Image: []image.Image{solidImage(8, 8), image.NewNRGBA(image.Rect(0, 0, 8, 8))}, Delay: []int{50, 50}}); err != nil {
		t.Fatal(err)
	}
	if !isAnimatedWebP(animWebP.Bytes()) {
		t.Fatalf("fixture is not an animated WebP: % x", animWebP.Bytes()[:min(32, animWebP.Len())])
	}
	for _, tc := range []struct {
		data        []byte
		contentType string
	}{
		{animGIF.Bytes(), "image/gif"},
		{animWebP.Bytes(), "image/webp"},
	} {
		svc, bucket, _ := emojiFixture(t, tc.data, tc.contentType)
		e, err := svc.Create(context.Background(), "u1", "party", emojiUploadKey, false)
		if err != nil {
			t.Fatalf("%s: create: %v", tc.contentType, err)
		}
		if !strings.HasPrefix(e.ImageKey, "emojis/") || !bytes.Equal(bucket.objects[e.ImageKey], tc.data) || bucket.types[e.ImageKey] != tc.contentType {
			t.Fatalf("%s: kept %q as %q", tc.contentType, e.ImageKey, bucket.types[e.ImageKey])
		}
	}
}

func TestEmojiService_Create_RejectsOversizedDimensions(t *testing.T) {
	svc, bucket, _ := emojiFixture(t, pngHeader(MaxEmojiSourceSide+1, 10), "image/png")
	if _, err := svc.Create(context.Background(), "u1", "wide", emojiUploadKey, false); err == nil {
		t.Fatal("an oversized emoji was accepted")
	}
	if bucket.puts != 0 {
		t.Fatal("an oversized emoji was decoded and stored")
	}
}

func TestEmojiService_Create_KeepFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("storing the copy fails", func(t *testing.T) {
		svc, bucket, _ := emojiFixture(t, encodePNG(t, solidImage(4, 4)), "image/png")
		bucket.putErr = errors.New("s3 down")
		if _, err := svc.Create(ctx, "u1", "fire", emojiUploadKey, false); err == nil {
			t.Fatal("expected the store error")
		}
	})
	t.Run("removing the upload fails", func(t *testing.T) {
		svc, bucket, _ := emojiFixture(t, encodePNG(t, solidImage(4, 4)), "image/png")
		bucket.delErr = errors.New("s3 down")
		if _, err := svc.Create(ctx, "u1", "fire", emojiUploadKey, false); err != nil {
			t.Fatalf("a leftover upload failed the create: %v", err)
		}
	})
	t.Run("the name is taken", func(t *testing.T) {
		svc, bucket, store := emojiFixture(t, encodePNG(t, solidImage(4, 4)), "image/png")
		store.items["fire"] = &model.CustomEmoji{Name: "fire"}
		if _, err := svc.Create(ctx, "u1", "fire", emojiUploadKey, false); err == nil {
			t.Fatal("expected a duplicate-name error")
		}
		for key := range bucket.objects {
			if strings.HasPrefix(key, "emojis/") {
				t.Fatalf("the copy of a rejected emoji was kept: %s", key)
			}
		}
	})
	t.Run("the name is taken and removing the copy fails", func(t *testing.T) {
		svc, bucket, store := emojiFixture(t, encodePNG(t, solidImage(4, 4)), "image/png")
		store.items["fire"] = &model.CustomEmoji{Name: "fire"}
		bucket.delErr = errors.New("s3 down")
		if _, err := svc.Create(ctx, "u1", "fire", emojiUploadKey, false); err == nil {
			t.Fatal("expected a duplicate-name error")
		}
	})
	t.Run("a picture that does not decode", func(t *testing.T) {
		// A valid PNG header over garbage: DecodeConfig passes, Decode not.
		svc, _, _ := emojiFixture(t, append(pngHeader(4, 4), []byte("garbage")...), "image/png")
		if _, err := svc.Create(ctx, "u1", "fire", emojiUploadKey, false); err == nil {
			t.Fatal("an undecodable emoji was accepted")
		}
	})
	t.Run("waiting for the decode budget is cancelled", func(t *testing.T) {
		svc, _, _ := emojiFixture(t, encodePNG(t, solidImage(4, 4)), "image/png")
		if !imageDecodeBudget.TryAcquire(maxImageDecodeBytes) {
			t.Fatal("decode budget busy")
		}
		defer imageDecodeBudget.Release(maxImageDecodeBytes)
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		if _, err := svc.Create(cctx, "u1", "fire", emojiUploadKey, false); err == nil {
			t.Fatal("expected the cancelled wait to fail the create")
		}
	})
}

func TestIsAnimatedWebP(t *testing.T) {
	var still bytes.Buffer
	if err := webp.Encode(&still, solidImage(4, 4)); err != nil {
		t.Fatal(err)
	}
	if isAnimatedWebP(still.Bytes()) || isAnimatedWebP([]byte("RIFF")) {
		t.Fatal("a still WebP (or a stub) counted as animated")
	}
}
