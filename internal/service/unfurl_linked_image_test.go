package service

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/gif"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The AVIF fixtures are 24×16, made with avifenc from two flat PNG frames:
// still.avif from one, animated.avif (an image sequence, brand avis) from
// both at 2 fps.
func readAVIFFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/avif/" + name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func gif24x16(t *testing.T) []byte {
	t.Helper()
	pal := color.Palette{color.Black, color.White}
	frame := image.NewPaletted(image.Rect(0, 0, 24, 16), pal)
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{10, 10}}); err != nil {
		t.Fatalf("encode gif: %v", err)
	}
	return buf.Bytes()
}

// serveImage answers every request with body under the given content type.
func serveImage(t *testing.T, contentType string, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// A link straight to an image previews as that image: stored as sent (so an
// animation still plays) and measured, so the message list can hold its box.
func TestUnfurlService_LinkedImageShowsAsTheImage(t *testing.T) {
	cases := []struct {
		name        string
		path        string
		contentType string
		body        []byte
	}{
		{"animated AVIF", "/g/full.avif", "image/avif", readAVIFFixture(t, "animated.avif")},
		{"still AVIF", "/photo.avif", "image/avif", readAVIFFixture(t, "still.avif")},
		{"animated GIF", "/dance.gif", "image/gif", gif24x16(t)},
		// The link's type comes from the response, not its name.
		{"image without an extension", "/image?id=7", "image/avif", readAVIFFixture(t, "animated.avif")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := serveImage(t, tc.contentType, tc.body)
			link := srv.URL + tc.path
			store := newFakeImageStore()
			svc := newLoopbackUnfurlService(newFakeUnfurlCache())
			svc.SetImageStore(store)

			got, err := svc.fetchAndScrape(context.Background(), link)
			if err != nil {
				t.Fatalf("fetchAndScrape: %v", err)
			}
			if got.Kind != unfurlKindImage || got.URL != link {
				t.Fatalf("preview = %+v, want an image preview of %s", got, link)
			}
			if !strings.HasPrefix(got.Image, "https://s3.example/unfurl/") {
				t.Fatalf("image = %q, want the stored copy", got.Image)
			}
			if got.ImageWidth != 24 || got.ImageHeight != 16 {
				t.Fatalf("dims = %dx%d, want 24x16", got.ImageWidth, got.ImageHeight)
			}
			key := unfurlImageKey(link)
			if !bytes.Equal(store.puts[key], tc.body) {
				t.Fatal("stored bytes differ from the linked image")
			}
			if store.puttypes[key] != tc.contentType {
				t.Fatalf("stored type = %q, want %q", store.puttypes[key], tc.contentType)
			}

			// Cached like any preview: the image server can go away.
			srv.Close()
			cached, err := svc.fetchAndScrape(context.Background(), link)
			if err != nil || cached.Kind != unfurlKindImage || cached.ImageWidth != 24 {
				t.Fatalf("cached preview = %+v, %v", cached, err)
			}
		})
	}
}

// A linked image that can't be stored and measured shows no preview: the
// message list can't hold a box of unknown size.
func TestUnfurlService_LinkedImageWithoutPreview(t *testing.T) {
	animated := readAVIFFixture(t, "animated.avif")
	cases := []struct {
		name        string
		contentType string
		body        []byte
		noStore     bool
	}{
		{"no image store", "image/avif", animated, true},
		{"SVG", "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), false},
		{"bytes that are no image", "image/avif", []byte("<html>not an image</html>"), false},
		{"image that can't be measured", "image/png", []byte("\x89PNG\r\n\x1a\ntruncated"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := serveImage(t, tc.contentType, tc.body)
			cache := newFakeUnfurlCache()
			svc := newLoopbackUnfurlService(cache)
			if !tc.noStore {
				svc.SetImageStore(newFakeImageStore())
			}
			if got, err := svc.fetchAndScrape(context.Background(), srv.URL+"/x"); err == nil {
				t.Fatalf("preview = %+v, want none", got)
			}
			var cached UnfurlPreview
			if err := cache.Get(context.Background(), unfurlCacheKeyPrefix+srv.URL+"/x", &cached); err == nil {
				t.Fatalf("failure cached as %+v", cached)
			}
		})
	}
}

// A page's AVIF preview image is kept too: it used to fail the magic check,
// Go's sniffer knowing no AVIF.
func TestUnfurlService_PagePreviewImageMayBeAVIF(t *testing.T) {
	img := serveImage(t, "image/avif", readAVIFFixture(t, "still.avif"))
	page := serveImage(t, "text/html; charset=utf-8",
		[]byte(`<meta property="og:title" content="t"><meta property="og:image" content="`+img.URL+`/social.avif">`))
	store := newFakeImageStore()
	svc := newLoopbackUnfurlService(nil)
	svc.SetImageStore(store)

	got, err := svc.fetchAndScrape(context.Background(), page.URL)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.Kind != "" || !strings.HasPrefix(got.Image, "https://s3.example/unfurl/") {
		t.Fatalf("preview = %+v, want a web card with the stored image", got)
	}
	if typ := store.puttypes[unfurlImageKey(img.URL+"/social.avif")]; typ != "image/avif" {
		t.Fatalf("stored type = %q, want image/avif", typ)
	}
}

func TestSniffImageType(t *testing.T) {
	cases := []struct {
		name string
		body []byte
		want string
	}{
		{"still AVIF", readAVIFFixture(t, "still.avif"), "image/avif"},
		{"animated AVIF", readAVIFFixture(t, "animated.avif"), "image/avif"},
		{"PNG", realPNG1x1, "image/png"},
		{"GIF", gif24x16(t), "image/gif"},
		{"text", []byte("hello"), "text/plain"},
	}
	for _, tc := range cases {
		if got := sniffImageType(tc.body); got != tc.want {
			t.Errorf("%s: sniffImageType = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestDecodeImageDims_AVIF(t *testing.T) {
	for _, name := range []string{"still.avif", "animated.avif"} {
		if w, h := decodeImageDims(readAVIFFixture(t, name)); w != 24 || h != 16 {
			t.Errorf("%s: dims = %dx%d, want 24x16", name, w, h)
		}
	}
}
