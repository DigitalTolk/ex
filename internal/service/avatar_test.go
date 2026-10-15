package service

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gen2brain/webp"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// fakeAvatarObjects is an in-memory object store.
type fakeAvatarObjects struct {
	mu        sync.Mutex
	objects   map[string][]byte
	types     map[string]string
	deleted   []string
	getErr    error
	readErr   error
	putErr    error
	deleteErr error
}

func newFakeAvatarObjects() *fakeAvatarObjects {
	return &fakeAvatarObjects{objects: map[string][]byte{}, types: map[string]string{}}
}

type failingBody struct{ err error }

func (b failingBody) Read([]byte) (int, error) { return 0, b.err }

func (f *fakeAvatarObjects) GetObject(_ context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return nil, "", 0, time.Time{}, f.getErr
	}
	if f.readErr != nil {
		return io.NopCloser(failingBody{f.readErr}), "", 0, time.Time{}, nil
	}
	data, ok := f.objects[key]
	if !ok {
		return nil, "", 0, time.Time{}, errors.New("NoSuchKey")
	}
	return io.NopCloser(bytes.NewReader(data)), f.types[key], int64(len(data)), time.Time{}, nil
}

func (f *fakeAvatarObjects) PutObject(_ context.Context, key, contentType string, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putErr != nil {
		return f.putErr
	}
	f.objects[key] = body
	f.types[key] = contentType
	return nil
}

func (f *fakeAvatarObjects) DeleteObject(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, key)
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.objects, key)
	return nil
}

// halves is a w×h image whose left half is red and right half blue.
func halves(w, h int, alpha uint8) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.NRGBA{R: 255, A: alpha}
			if x >= w/2 {
				c = color.NRGBA{B: 255, A: alpha}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	return img
}

// cameraJPEG encodes img as a JPEG carrying an EXIF orientation tag, the way a
// phone stores a photo taken sideways.
func cameraJPEG(t *testing.T, img image.Image, orientation uint16) []byte {
	t.Helper()
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	// TIFF header (big-endian), one IFD0 entry: Orientation, SHORT, 1 value.
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1}
	tiff = binary.BigEndian.AppendUint16(tiff, orientation)
	tiff = append(tiff, 0, 0, 0, 0, 0, 0)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xFF, 0xE1}
	app1 = binary.BigEndian.AppendUint16(app1, uint16(len(payload)+2))
	app1 = append(app1, payload...)
	src := plain.Bytes()
	return append(append(append([]byte{}, src[:2]...), app1...), src[2:]...)
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// pngHeader is just a PNG signature and an IHDR declaring w×h: enough for
// DecodeConfig, nothing to decode.
func pngHeader(w, h uint32) []byte {
	ihdr := []byte("IHDR")
	ihdr = binary.BigEndian.AppendUint32(ihdr, w)
	ihdr = binary.BigEndian.AppendUint32(ihdr, h)
	ihdr = append(ihdr, 8, 6, 0, 0, 0)
	out := []byte("\x89PNG\r\n\x1a\n")
	out = binary.BigEndian.AppendUint32(out, 13)
	out = append(out, ihdr...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(ihdr))
}

// isLossyWebP reports whether data is a lossy WebP: a VP8 bitstream, or an
// extended file (VP8X) carrying one, as a lossy picture with alpha is.
func isLossyWebP(data []byte) bool {
	return len(data) >= 16 && string(data[8:12]) == "WEBP" &&
		(string(data[12:16]) == "VP8 " || (string(data[12:16]) == "VP8X" && bytes.Contains(data, []byte("VP8 "))))
}

func decodeStored(t *testing.T, data []byte) (image.Image, string) {
	t.Helper()
	if !isLossyWebP(data) {
		t.Fatalf("stored avatar is not a lossy WebP: % x", data[:min(16, len(data))])
	}
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("stored avatar does not decode: %v", err)
	}
	return img, format
}

func isRed(c color.Color) bool {
	r, g, b, _ := c.RGBA()
	return r > 0xC000 && g < 0x4000 && b < 0x4000
}

func isBlue(c color.Color) bool {
	r, g, b, _ := c.RGBA()
	return b > 0xC000 && r < 0x4000 && g < 0x4000
}

func avatarService(t *testing.T) (*UserService, *mockUserStore, *fakeAvatarObjects, *mockPublisher, *mockCache) {
	t.Helper()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", Email: "u1@example.com", DisplayName: "U1", AvatarKey: "avatars/u1/old"}
	objects := newFakeAvatarObjects()
	pub := newMockPublisher()
	cache := newMockCache()
	svc := NewUserService(users, cache, fakeAvatarSigner{}, pub)
	svc.SetAvatarObjects(objects)
	return svc, users, objects, pub, cache
}

func publishedAvatarURL(t *testing.T, pub *mockPublisher) string {
	t.Helper()
	for _, p := range pub.published {
		if p.event.Type == events.EventUserUpdated && p.channel == pubsub.UserEvents() {
			var data struct {
				AvatarURL string `json:"avatarURL"`
			}
			if err := json.Unmarshal(p.event.Data, &data); err != nil {
				t.Fatal(err)
			}
			return data.AvatarURL
		}
	}
	t.Fatal("no user.updated published")
	return ""
}

func TestUpdate_ShrinksAnUploadedPhotoAndTurnsItUpright(t *testing.T) {
	svc, users, objects, pub, _ := avatarService(t)
	// A 3000×1500 photo taken with the phone turned: EXIF 6 means "turn it a
	// quarter clockwise to show it", so it shows as 1500×3000 with the red
	// (left) half on top.
	upload := "avatars/u1/upload"
	objects.objects[upload] = cameraJPEG(t, halves(3000, 1500, 255), 6)

	updated, err := svc.Update(context.Background(), "u1", nil, &upload, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.AvatarKey == upload || !strings.HasPrefix(updated.AvatarKey, "avatars/u1/") {
		t.Fatalf("AvatarKey = %q, want a new key under avatars/u1/", updated.AvatarKey)
	}
	if users.users["u1"].AvatarKey != updated.AvatarKey {
		t.Fatal("the new key was not saved")
	}
	if objects.types[updated.AvatarKey] != "image/webp" {
		t.Fatalf("stored as %q, want image/webp", objects.types[updated.AvatarKey])
	}
	img, _ := decodeStored(t, objects.objects[updated.AvatarKey])
	if got := img.Bounds().Size(); got != image.Pt(512, 1024) {
		t.Fatalf("size = %v, want 512×1024 (upright, longest side 1024)", got)
	}
	if !isRed(img.At(256, 100)) || !isBlue(img.At(256, 924)) {
		t.Fatalf("not turned upright: top %v, bottom %v", img.At(256, 100), img.At(256, 924))
	}
	if bytes.Contains(objects.objects[updated.AvatarKey], []byte("Exif")) {
		t.Fatal("the photo's metadata was kept")
	}
	if _, ok := objects.objects[upload]; ok {
		t.Fatal("the upload was not removed")
	}
	if got := publishedAvatarURL(t, pub); got != "https://signed.example/"+updated.AvatarKey {
		t.Fatalf("user.updated avatarURL = %q", got)
	}
}

func TestUpdate_KeepsTransparency(t *testing.T) {
	svc, _, objects, _, _ := avatarService(t)
	upload := "avatars/u1/logo"
	objects.objects[upload] = encodePNG(t, halves(1600, 1600, 128))

	updated, err := svc.Update(context.Background(), "u1", nil, &upload, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if objects.types[updated.AvatarKey] != "image/webp" {
		t.Fatalf("stored as %q, want image/webp", objects.types[updated.AvatarKey])
	}
	img, _ := decodeStored(t, objects.objects[updated.AvatarKey])
	if got := img.Bounds().Size(); got != image.Pt(1024, 1024) {
		t.Fatalf("size = %v, want 1024×1024", got)
	}
	if _, _, _, a := img.At(10, 10).RGBA(); a == 0xFFFF {
		t.Fatal("transparency was lost")
	}
}

func TestUpdate_ReencodesASmallAvatarAtItsOwnSize(t *testing.T) {
	svc, _, objects, _, _ := avatarService(t)
	var lossless bytes.Buffer
	if err := webp.Encode(&lossless, halves(300, 200, 255), webp.Options{Lossless: true}); err != nil {
		t.Fatal(err)
	}
	upload := "avatars/u1/small"
	objects.objects[upload] = lossless.Bytes()

	updated, err := svc.Update(context.Background(), "u1", nil, &upload, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	img, _ := decodeStored(t, objects.objects[updated.AvatarKey])
	if img.Bounds().Size() != image.Pt(300, 200) {
		t.Fatalf("size = %v, want 300×200", img.Bounds().Size())
	}
}

func TestUpdate_RejectsAnAvatarThatIsNotAnAllowedImage(t *testing.T) {
	var gifData bytes.Buffer
	if err := gif.Encode(&gifData, halves(10, 10, 255), nil); err != nil {
		t.Fatal(err)
	}
	full := cameraJPEG(t, halves(400, 400, 255), 1)
	cases := []struct {
		name string
		data []byte
		want avatarRejection
	}{
		{"not an image", []byte("%PDF-1.7 renamed to photo.jpg"), errAvatarFormat},
		{"a GIF", gifData.Bytes(), errAvatarFormat},
		{"a truncated JPEG", full[:len(full)/2], errAvatarFormat},
		{"a decompression bomb", pngHeader(20000, 20000), errAvatarPixels},
		{"over 2MB", make([]byte, MaxAvatarBytes+1), errAvatarBytes},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, users, objects, pub, _ := avatarService(t)
			upload := "avatars/u1/bad"
			objects.objects[upload] = tc.data

			_, err := svc.Update(context.Background(), "u1", nil, &upload, nil)
			if !errors.Is(err, tc.want) || !errors.Is(err, ErrValidation) {
				t.Fatalf("err = %v, want %v as a validation error", err, tc.want)
			}
			// The text is what the uploader is shown, as is.
			if err.Error() != string(tc.want) {
				t.Fatalf("message = %q", err.Error())
			}
			if users.users["u1"].AvatarKey != "avatars/u1/old" {
				t.Fatal("the avatar changed")
			}
			if len(objects.objects) != 0 || len(pub.published) != 0 {
				t.Fatalf("left %d objects, published %d events", len(objects.objects), len(pub.published))
			}
		})
	}
}

func TestUpdate_AvatarStorageFailures(t *testing.T) {
	boom := errors.New("boom")
	photo := cameraJPEG(t, halves(64, 64, 255), 1)
	cases := []struct {
		name  string
		setup func(*fakeAvatarObjects)
	}{
		{"read fails", func(o *fakeAvatarObjects) { o.getErr = boom }},
		{"body fails", func(o *fakeAvatarObjects) { o.readErr = boom }},
		{"write fails", func(o *fakeAvatarObjects) { o.putErr = boom }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, users, objects, _, _ := avatarService(t)
			upload := "avatars/u1/up"
			objects.objects[upload] = photo
			tc.setup(objects)
			_, err := svc.Update(context.Background(), "u1", nil, &upload, nil)
			if !errors.Is(err, boom) || errors.Is(err, ErrValidation) {
				t.Fatalf("err = %v, want the storage error", err)
			}
			if users.users["u1"].AvatarKey != "avatars/u1/old" {
				t.Fatal("the avatar changed")
			}
			if len(objects.deleted) != 1 || objects.deleted[0] != upload {
				t.Fatalf("deleted = %v, want the upload removed", objects.deleted)
			}
		})
	}
}

func TestUpdate_AnUploadThatCannotBeRemovedIsOnlyLogged(t *testing.T) {
	svc, _, objects, _, _ := avatarService(t)
	upload := "avatars/u1/up"
	objects.objects[upload] = cameraJPEG(t, halves(64, 64, 255), 1)
	objects.deleteErr = errors.New("boom")
	updated, err := svc.Update(context.Background(), "u1", nil, &upload, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.AvatarKey == upload {
		t.Fatal("kept the upload as the avatar")
	}
}

func TestUpdate_AvatarWaitsForTheDecodeBudget(t *testing.T) {
	svc, _, objects, _, _ := avatarService(t)
	upload := "avatars/u1/up"
	objects.objects[upload] = cameraJPEG(t, halves(64, 64, 255), 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := svc.Update(ctx, "u1", nil, &upload, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestUpdate_AvatarNeedsStorage(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1"}
	svc := NewUserService(users, nil, nil, nil)
	upload := "avatars/u1/up"
	if _, err := svc.Update(context.Background(), "u1", nil, &upload, nil); !errors.Is(err, errAvatarStorage) {
		t.Fatalf("err = %v, want errAvatarStorage", err)
	}
}

func TestUpdate_TheCurrentOrNoAvatarTouchesNoStorage(t *testing.T) {
	svc, users, objects, _, _ := avatarService(t)
	same := "avatars/u1/old"
	if _, err := svc.Update(context.Background(), "u1", nil, &same, nil); err != nil {
		t.Fatalf("Update same: %v", err)
	}
	none := ""
	if _, err := svc.Update(context.Background(), "u1", nil, &none, nil); err != nil {
		t.Fatalf("Update clear: %v", err)
	}
	if users.users["u1"].AvatarKey != "" {
		t.Fatalf("AvatarKey = %q, want cleared", users.users["u1"].AvatarKey)
	}
	if len(objects.deleted) != 0 || len(objects.objects) != 0 {
		t.Fatal("touched storage")
	}
}

func TestUpdate_AnInvalidFieldLeavesTheUploadAlone(t *testing.T) {
	svc, _, objects, _, _ := avatarService(t)
	upload := "avatars/u1/up"
	objects.objects[upload] = cameraJPEG(t, halves(64, 64, 255), 1)
	tone := "blue"
	if _, err := svc.Update(context.Background(), "u1", nil, &upload, &tone); err == nil {
		t.Fatal("expected the skin tone to be rejected")
	}
	if _, ok := objects.objects[upload]; !ok || len(objects.deleted) != 0 {
		t.Fatal("the upload was removed before the profile was valid")
	}
}

func TestShrinkAvatar(t *testing.T) {
	ctx := context.Background()

	t.Run("a full-size photo is replaced and the original kept", func(t *testing.T) {
		svc, users, objects, pub, cache := avatarService(t)
		objects.objects["avatars/u1/old"] = cameraJPEG(t, halves(2400, 1600, 255), 1)
		cache.users["user:u1"] = users.users["u1"]

		changed, err := svc.ShrinkAvatar(ctx, "u1", false)
		if err != nil || !changed {
			t.Fatalf("ShrinkAvatar = %v, %v", changed, err)
		}
		key := users.users["u1"].AvatarKey
		if key == "avatars/u1/old" {
			t.Fatal("the avatar was not replaced")
		}
		img, _ := decodeStored(t, objects.objects[key])
		if got := img.Bounds().Size(); got != image.Pt(1024, 682) {
			t.Fatalf("size = %v, want 1024×682", got)
		}
		if _, ok := objects.objects["avatars/u1/old"]; !ok {
			t.Fatal("the original was removed")
		}
		if _, ok := cache.users["user:u1"]; ok {
			t.Fatal("the cached profile was kept")
		}
		if publishedAvatarURL(t, pub) != "https://signed.example/"+key {
			t.Fatal("user.updated does not carry the new avatar")
		}
	})

	t.Run("a dry run only reports", func(t *testing.T) {
		svc, users, objects, pub, _ := avatarService(t)
		objects.objects["avatars/u1/old"] = cameraJPEG(t, halves(2400, 1600, 255), 1)
		changed, err := svc.ShrinkAvatar(ctx, "u1", true)
		if err != nil || !changed {
			t.Fatalf("ShrinkAvatar = %v, %v", changed, err)
		}
		if users.users["u1"].AvatarKey != "avatars/u1/old" || len(objects.objects) != 1 || len(pub.published) != 0 {
			t.Fatal("a dry run wrote")
		}
	})

	t.Run("an avatar that fits is left alone", func(t *testing.T) {
		svc, users, objects, _, _ := avatarService(t)
		objects.objects["avatars/u1/old"] = encodePNG(t, halves(1024, 800, 255))
		changed, err := svc.ShrinkAvatar(ctx, "u1", false)
		if err != nil || changed {
			t.Fatalf("ShrinkAvatar = %v, %v", changed, err)
		}
		if users.users["u1"].AvatarKey != "avatars/u1/old" || len(objects.objects) != 1 {
			t.Fatal("rewrote an avatar that fits")
		}
	})

	t.Run("no avatar", func(t *testing.T) {
		svc, users, _, _, _ := avatarService(t)
		users.users["u1"].AvatarKey = ""
		if changed, err := svc.ShrinkAvatar(ctx, "u1", false); err != nil || changed {
			t.Fatalf("ShrinkAvatar = %v, %v", changed, err)
		}
	})

	t.Run("failures", func(t *testing.T) {
		boom := errors.New("boom")
		photo := cameraJPEG(t, halves(2400, 1600, 255), 1)
		cases := []struct {
			name  string
			setup func(*mockUserStore, *fakeAvatarObjects)
			want  error
		}{
			{"unknown user", func(u *mockUserStore, _ *fakeAvatarObjects) { u.getUserErr = boom }, boom},
			{"unreadable", func(_ *mockUserStore, o *fakeAvatarObjects) { o.getErr = boom }, boom},
			{"not an image", func(_ *mockUserStore, o *fakeAvatarObjects) { o.objects["avatars/u1/old"] = []byte("nope") }, errAvatarFormat},
			{"write fails", func(_ *mockUserStore, o *fakeAvatarObjects) { o.putErr = boom }, boom},
			{"save fails", func(u *mockUserStore, _ *fakeAvatarObjects) { u.updateErr = boom }, boom},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				svc, users, objects, _, _ := avatarService(t)
				objects.objects["avatars/u1/old"] = photo
				tc.setup(users, objects)
				if changed, err := svc.ShrinkAvatar(ctx, "u1", false); !errors.Is(err, tc.want) || changed {
					t.Fatalf("ShrinkAvatar = %v, %v; want %v", changed, err, tc.want)
				}
			})
		}
	})

	t.Run("needs storage", func(t *testing.T) {
		svc := NewUserService(newMockUserStore(), nil, nil, nil)
		if _, err := svc.ShrinkAvatar(ctx, "u1", false); !errors.Is(err, errAvatarStorage) {
			t.Fatalf("err = %v", err)
		}
	})
}
