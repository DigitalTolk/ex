//go:build integration

package importer

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/gen2brain/webp"

	"github.com/DigitalTolk/ex/internal/store"
)

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, 0, color.NRGBA{R: 200, A: 255})
	}
	var b bytes.Buffer
	mustNoErr(t, png.Encode(&b, img))
	return b.Bytes()
}

func TestUpsertEmoji(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	emojis := store.NewEmojiStore(e.db)

	created, err := e.im.UpsertEmoji(ctx, EmojiSpec{Name: "party", CreatedBy: "u1", CreatedAt: t0}, pngOf(t, 512, 256))
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	got, err := emojis.GetByName(ctx, "party")
	mustNoErr(t, err)
	if !strings.HasPrefix(got.ImageKey, "emojis/") || got.CreatedBy != "u1" || !got.CreatedAt.Equal(t0) || got.ImageURL != "" {
		t.Fatalf("emoji = %+v", got)
	}
	kept := e.objects.objects[got.ImageKey]
	cfg, format, err := image.DecodeConfig(bytes.NewReader(kept))
	if err != nil || format != "webp" || cfg.Width != 256 || cfg.Height != 128 {
		t.Fatalf("kept %s %dx%d: %v", format, cfg.Width, cfg.Height, err)
	}

	// Idempotent: an existing name is left alone and nothing is uploaded.
	n := len(e.objects.objects)
	created, err = e.im.UpsertEmoji(ctx, EmojiSpec{Name: "party", CreatedBy: "u2"}, pngOf(t, 8, 8))
	if err != nil || created || len(e.objects.objects) != n {
		t.Fatalf("re-run: %v %v", created, err)
	}

	// No creation time: now.
	before := time.Now()
	_, err = e.im.UpsertEmoji(ctx, EmojiSpec{Name: "now", CreatedBy: "u1"}, pngOf(t, 8, 8))
	mustNoErr(t, err)
	if got, _ := emojis.GetByName(ctx, "now"); got.CreatedAt.Before(before) {
		t.Fatalf("createdAt = %v", got.CreatedAt)
	}
}

func TestUpsertEmojiErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := EmojiSpec{Name: "ok", CreatedBy: "u1", CreatedAt: t0}
	img := pngOf(t, 8, 8)

	for _, bad := range []EmojiSpec{{Name: "Bad Name", CreatedBy: "u1"}, {Name: "ok"}} {
		if _, err := e.im.UpsertEmoji(ctx, bad, img); !errors.Is(err, ErrInvalidSpec) {
			t.Errorf("%+v: want ErrInvalidSpec, got %v", bad, err)
		}
	}
	noObjects, _ := New(Deps{DB: e.db})
	_, err := noObjects.UpsertEmoji(ctx, spec, img)
	wantErr(t, err, ErrNoObjectStore)

	_, err = e.faulty(failOn("GetItem", 1)).UpsertEmoji(ctx, spec, img)
	wantErr(t, err, errFault)

	_, err = e.im.UpsertEmoji(ctx, spec, []byte("not an image"))
	wantErr(t, err, ErrInvalidSpec)

	e.objects.err = errFault
	_, err = e.im.UpsertEmoji(ctx, spec, img)
	wantErr(t, err, errFault)
	e.objects.err = nil

	// A failed write removes the uploaded image.
	_, err = e.faulty(failOn("PutItem", 1)).UpsertEmoji(ctx, spec, img)
	wantErr(t, err, errFault)
	if len(e.objects.objects) != 0 || len(e.objects.deletedKeys) != 1 {
		t.Fatalf("objects = %v, deleted = %v", e.objects.objects, e.objects.deletedKeys)
	}
}

// hiddenGets answers every GetItem with "not found", so a write races an
// emoji that already exists.
type hiddenGets struct{ store.DynamoAPI }

func (hiddenGets) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return &dynamodb.GetItemOutput{}, nil
}

func TestUpsertEmojiRace(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := EmojiSpec{Name: "party", CreatedBy: "u1", CreatedAt: t0}
	_, err := e.im.UpsertEmoji(ctx, spec, pngOf(t, 8, 8))
	mustNoErr(t, err)
	racer, _ := New(Deps{DB: &store.DB{Client: hiddenGets{e.db.Client}, Table: e.db.Table}, Objects: e.objects})
	created, err := racer.UpsertEmoji(ctx, spec, pngOf(t, 8, 8))
	if err != nil || created || len(e.objects.objects) != 1 || len(e.objects.deletedKeys) != 1 {
		t.Fatalf("race: %v %v, objects %d", created, err, len(e.objects.objects))
	}
}

func TestKeepEmojiImage(t *testing.T) {
	var animGIF bytes.Buffer
	frame := func(c uint8) *image.Paletted {
		p := image.NewPaletted(image.Rect(0, 0, 8, 8), color.Palette{color.Black, color.Gray{Y: c}})
		p.SetColorIndex(1, 1, 1)
		return p
	}
	mustNoErr(t, gif.EncodeAll(&animGIF, &gif.GIF{Image: []*image.Paletted{frame(10), frame(200)}, Delay: []int{5, 5}}))
	var animWebP bytes.Buffer
	solid := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for i := range solid.Pix {
		solid.Pix[i] = 0xff
	}
	mustNoErr(t, webp.EncodeAll(&animWebP, &webp.WEBP{Image: []image.Image{solid, image.NewNRGBA(image.Rect(0, 0, 8, 8))}, Delay: []int{50, 50}}))
	for _, tc := range []struct {
		data []byte
		ct   string
	}{{animGIF.Bytes(), "image/gif"}, {animWebP.Bytes(), "image/webp"}} {
		kept, ct, err := keepEmojiImage(tc.data)
		if err != nil || ct != tc.ct || !bytes.Equal(kept, tc.data) {
			t.Fatalf("%s: copied as %s: %v", tc.ct, ct, err)
		}
	}
	if !isAnimatedWebP(animWebP.Bytes()) || isAnimatedWebP(pngOf(t, 8, 8)) {
		t.Fatal("isAnimatedWebP")
	}

	full := pngOf(t, 8, 8)
	for name, data := range map[string][]byte{
		"empty":     nil,
		"too big":   make([]byte, maxEmojiImageBytes+1),
		"text":      []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"),
		"bmp":       append([]byte("BM"), make([]byte, 64)...),
		"too wide":  pngOf(t, maxEmojiSourceSide+1, 1),
		"truncated": full[:len(full)-20],
	} {
		if _, _, err := keepEmojiImage(data); !errors.Is(err, ErrInvalidSpec) {
			t.Errorf("%s: want ErrInvalidSpec, got %v", name, err)
		}
	}

	orig := webpEncode
	webpEncode = func(io.Writer, image.Image, ...webp.Options) error { return errFault }
	t.Cleanup(func() { webpEncode = orig })
	_, _, err := keepEmojiImage(full)
	wantErr(t, err, errFault)
}
