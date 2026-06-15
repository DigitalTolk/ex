package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// errBodyTransport returns a 200 HTML response whose body errors on Read.
type errBody struct{}

func (errBody) Read([]byte) (int, error) { return 0, errors.New("body read error") }
func (errBody) Close() error             { return nil }

func unfurlClientWithTransport(rt http.RoundTripper) *http.Client {
	return &http.Client{Transport: rt}
}

func TestUnfurl_FetchAndScrape_BuildRequestError(t *testing.T) {
	svc := &UnfurlService{
		cache:             newFakeUnfurlCache(),
		client:            &http.Client{},
		skipURLValidation: true,
	}
	if _, err := svc.fetchAndScrape(context.Background(), "http://example.com/\x7f"); err == nil {
		t.Fatal("expected build-request error")
	}
}

func TestUnfurl_FetchAndScrape_TransportError(t *testing.T) {
	svc := &UnfurlService{
		cache: newFakeUnfurlCache(),
		client: unfurlClientWithTransport(roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network down")
		})),
		skipURLValidation: true,
	}
	if _, err := svc.fetchAndScrape(context.Background(), "https://example.com/x"); err == nil {
		t.Fatal("expected transport error")
	}
}

func TestUnfurl_FetchAndScrape_NonHTMLAndStatusAndBodyErrors(t *testing.T) {
	tests := []struct {
		name string
		rt   roundTripFunc
	}{
		{
			name: "bad status",
			rt: func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
			},
		},
		{
			name: "non-html",
			rt: func(*http.Request) (*http.Response, error) {
				h := http.Header{}
				h.Set("Content-Type", "application/json")
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: h}, nil
			},
		},
		{
			name: "body read error",
			rt: func(*http.Request) (*http.Response, error) {
				h := http.Header{}
				h.Set("Content-Type", "text/html")
				return &http.Response{StatusCode: 200, Body: errBody{}, Header: h}, nil
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &UnfurlService{
				cache:             newFakeUnfurlCache(),
				client:            unfurlClientWithTransport(tt.rt),
				skipURLValidation: true,
			}
			if _, err := svc.fetchAndScrape(context.Background(), "https://example.com/x"); err == nil {
				t.Fatalf("%s: expected error", tt.name)
			}
		})
	}
}

func TestUnfurl_ProxyImage_PutObjectError(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfake-png-bytes"))
	}))
	defer imgSrv.Close()

	store := newFakeImageStore()
	store.failPut = true // HEAD miss → fetch ok → PutObject fails → image cleared
	svc := &UnfurlService{
		client:            &http.Client{},
		imgStore:          store,
		skipURLValidation: true,
	}
	preview := &UnfurlPreview{URL: "https://example.com", Image: imgSrv.URL + "/x.png"}
	svc.proxyImage(context.Background(), preview)
	if preview.Image != "" {
		t.Fatalf("expected image cleared on PutObject error, got %q", preview.Image)
	}
}

func TestUnfurl_FetchUpstreamImage_BuildRequestError(t *testing.T) {
	svc := &UnfurlService{client: &http.Client{}}
	if _, _, err := svc.fetchUpstreamImage(context.Background(), "http://example.com/\x7f"); err == nil {
		t.Fatal("expected build-request error")
	}
}

func TestUnfurl_FetchUpstreamImage_SVGRejected(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		_, _ = w.Write([]byte(`<svg/>`))
	}))
	defer imgSrv.Close()
	svc := &UnfurlService{client: &http.Client{}}
	if _, _, err := svc.fetchUpstreamImage(context.Background(), imgSrv.URL); err == nil {
		t.Fatal("expected SVG rejection")
	}
}

func TestUnfurl_FetchUpstreamImage_BodyReadError(t *testing.T) {
	svc := &UnfurlService{
		client: unfurlClientWithTransport(roundTripFunc(func(*http.Request) (*http.Response, error) {
			h := http.Header{}
			h.Set("Content-Type", "image/png")
			return &http.Response{StatusCode: 200, Body: errBody{}, Header: h}, nil
		})),
	}
	if _, _, err := svc.fetchUpstreamImage(context.Background(), "https://example.com/x.png"); err == nil {
		t.Fatal("expected image body read error")
	}
}

func TestUnfurl_ScrapePreview_ImageResolveFallbacks(t *testing.T) {
	// Unparseable requested URL → base is nil → resolveImage returns the raw
	// image string verbatim (covers the base==nil arm).
	p := scrapePreview(`<meta property="og:image" content="pic.png">`, "http://h/\x7f")
	if p.Image != "pic.png" {
		t.Fatalf("base==nil image = %q, want raw pic.png", p.Image)
	}
	// Valid base but an image value that fails url.Parse → returned raw
	// (covers the parse-error arm).
	p2 := scrapePreview(`<meta property="og:image" content="ht tp://b\x7f">`, "https://example.com")
	if p2.Image == "" {
		t.Fatal("expected raw image returned on parse error")
	}
}
