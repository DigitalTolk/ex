package service

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A YouTube video is described by YouTube's oEmbed answer, not its watch
// page: title, channel, thumbnail.
func TestUnfurlService_YouTubeVideoReadThroughOEmbed(t *testing.T) {
	const video = "https://www.youtube.com/watch?v=abc123"
	var asked []string
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(realPNG1x1)
	}))
	defer imgSrv.Close()
	oembed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Query().Get("url")+" "+r.URL.Query().Get("format")+" "+r.UserAgent())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"title":"A video","author_name":"A channel","provider_name":"YouTube","thumbnail_url":"` + imgSrv.URL + `/hqdefault.jpg"}`))
	}))
	defer oembed.Close()

	cache := newFakeUnfurlCache()
	svc := newLoopbackUnfurlService(cache)
	svc.youTubeOEmbed = oembed.URL + "/oembed"
	svc.SetImageStore(newFakeImageStore())
	got, err := svc.fetchAndScrape(context.Background(), video)
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if got.URL != video || got.Title != "A video" || got.Description != "A channel" || got.SiteName != "YouTube" {
		t.Errorf("preview = %+v", got)
	}
	if got.Image == "" || strings.Contains(got.Image, imgSrv.URL) {
		t.Errorf("image = %q, want the thumbnail served from our own store", got.Image)
	}
	if want := video + " json " + unfurlUserAgent; len(asked) != 1 || asked[0] != want {
		t.Errorf("oembed asked %q, want %q", asked, want)
	}
	if _, ok := cache.store[unfurlCacheKeyPrefix+video]; !ok {
		t.Error("preview not cached")
	}
}

// dialingOnly is a client whose every connection goes to addr, whatever
// host the request names: a test server can stand in for youtube.com.
func dialingOnly(addr string) *http.Client {
	return &http.Client{
		Timeout: unfurlTimeout,
		Transport: &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}},
	}
}

// Without a usable oEmbed answer the watch page is read like any other.
func TestUnfurlService_YouTubeFallsBackToThePage(t *testing.T) {
	for _, tc := range []struct {
		name     string
		endpoint string
		answer   func(w http.ResponseWriter)
	}{
		{"not found", "/oembed", func(w http.ResponseWriter) { w.WriteHeader(http.StatusNotFound) }},
		{"not json", "/oembed", func(w http.ResponseWriter) { _, _ = w.Write([]byte("<html>")) }},
		{"no title", "/oembed", func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"author_name":"A channel"}`)) }},
		{"unreachable", "ftp://www.youtube.com/oembed", nil},
		{"bad endpoint", "://oembed", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/oembed" {
					tc.answer(w)
					return
				}
				w.Header().Set("Content-Type", "text/html")
				_, _ = w.Write([]byte(`<meta property="og:title" content="The page">`))
			}))
			defer srv.Close()
			svc := newLoopbackUnfurlService(nil)
			svc.client = dialingOnly(srv.Listener.Addr().String())
			svc.youTubeOEmbed = tc.endpoint
			if strings.HasPrefix(tc.endpoint, "/") {
				svc.youTubeOEmbed = "http://www.youtube.com" + tc.endpoint
			}
			got, err := svc.fetchAndScrape(context.Background(), "http://www.youtube.com/watch?v=abc123")
			if err != nil {
				t.Fatalf("fetchAndScrape: %v", err)
			}
			if got.Title != "The page" {
				t.Errorf("title = %q, want the page's", got.Title)
			}
		})
	}
}

func TestYouTubeOEmbedTarget(t *testing.T) {
	const watch = "https://www.youtube.com/watch?v=abc"
	for raw, want := range map[string]string{
		watch:                                       watch,
		"https://m.youtube.com/watch?v=abc":         "https://m.youtube.com/watch?v=abc",
		"https://youtube.com/shorts/abc":            "https://youtube.com/shorts/abc",
		"https://www.youtube.com/live/abc":          "https://www.youtube.com/live/abc",
		"https://youtu.be/abc":                      "https://youtu.be/abc",
		"https://www.youtube.com/playlist?list=PLx": "https://www.youtube.com/playlist?list=PLx",
		"https://www.youtube.com/embed/abc":         watch,
		"https://www.youtube.com/v/abc":             watch,
		"https://www.youtube.com/embed/":            "",
		"https://youtu.be/":                         "",
		"https://www.youtube.com/playlist":          "",
		"https://www.youtube.com/@channel":          "",
		"https://notyoutube.com/watch?v=abc":        "",
		"https://example.com/watch?v=abc":           "",
		"http://www.youtube.com/watch\x7f?v=a":      "",
	} {
		if got := youTubeOEmbedTarget(raw); got != want {
			t.Errorf("youTubeOEmbedTarget(%q) = %q, want %q", raw, got, want)
		}
	}
}

// An embed link is described as its watch page: oEmbed has no answer for it.
func TestUnfurlService_YouTubeEmbedAskedAsWatchPage(t *testing.T) {
	var asked string
	oembed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Query().Get("url")
		_, _ = w.Write([]byte(`{"title":"A video","provider_name":"YouTube"}`))
	}))
	defer oembed.Close()
	svc := newLoopbackUnfurlService(nil)
	svc.youTubeOEmbed = oembed.URL
	got, err := svc.fetchAndScrape(context.Background(), "https://www.youtube.com/embed/abc123")
	if err != nil {
		t.Fatalf("fetchAndScrape: %v", err)
	}
	if asked != "https://www.youtube.com/watch?v=abc123" || got.Title != "A video" || got.URL != "https://www.youtube.com/embed/abc123" {
		t.Errorf("asked %q, preview %+v", asked, got)
	}
}
