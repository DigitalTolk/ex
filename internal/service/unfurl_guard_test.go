package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"code.dny.dev/ssrf"
)

// The old hand-kept deny list missed several IANA special-purpose ranges that
// still reach infrastructure. The URL check and the dial-time guard now share
// netguard's registry-derived list.
var specialPurposeTargets = []string{
	"http://0.1.2.3/",          // "this network" (0.0.0.0/8)
	"http://192.0.0.8/",        // IETF protocol assignments (192.0.0.0/24)
	"http://198.18.0.1/",       // benchmarking (198.18.0.0/15)
	"http://240.0.0.1/",        // reserved (240.0.0.0/4)
	"http://[2002:a00:1::1]/",  // 6to4 wrapping 10.0.0.1 (2002::/16)
	"http://[64:ff9b::a00:1]/", // NAT64 wrapping 10.0.0.1
}

func TestValidateURL_RefusesSpecialPurposeRanges(t *testing.T) {
	for _, raw := range specialPurposeTargets {
		if err := validateURL(mustParseURL(t, raw)); err == nil {
			t.Errorf("validateURL(%s) admitted a special-purpose address", raw)
		}
	}
}

func TestUnfurlClient_RefusesSpecialPurposeRangesAtDialTime(t *testing.T) {
	client := NewUnfurlService(nil).client
	for _, raw := range specialPurposeTargets {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		res, err := client.Do(req)
		cancel()
		if res != nil {
			_ = res.Body.Close()
		}
		if !errors.Is(err, ssrf.ErrProhibitedIP) {
			t.Errorf("dial %s err = %v, want ErrProhibitedIP", raw, err)
		}
	}
}

// A hostname is checked on the address it resolves to, at dial time — the
// same check every redirect hop goes through.
func TestUnfurlClient_RefusesNamesResolvingToLoopback(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)

	_, err := NewUnfurlService(nil).client.Get("http://localhost:" + u.Port() + "/page")
	if !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("localhost dial err = %v, want ErrProhibitedIP", err)
	}
	if hits.Load() != 0 {
		t.Fatal("the loopback server was reached")
	}
	tr, ok := NewUnfurlService(nil).client.Transport.(*http.Transport)
	if !ok || tr.Proxy != nil || !tr.DisableKeepAlives {
		t.Fatalf("unfurl transport = %#v, want guarded, proxy-free, no keep-alives", tr)
	}
}

// The stored type is what the bytes are, not what the upstream claimed: a
// comma list such as "image/png, text/html" reads as text/html to a browser
// (the Fetch spec takes the last valid entry).
func TestFetchUpstreamImage_StoresTheSniffedType(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png, text/html")
		_, _ = w.Write(realPNG1x1)
	}))
	defer imgSrv.Close()

	svc := newLoopbackUnfurlService(nil)
	_, contentType, err := svc.fetchUpstreamImage(context.Background(), imgSrv.URL+"/x.png")
	if err != nil {
		t.Fatalf("fetchUpstreamImage: %v", err)
	}
	if contentType != "image/png" {
		t.Fatalf("content type = %q, want the sniffed image/png", contentType)
	}

	store := newFakeImageStore()
	svc.SetImageStore(store)
	if got := svc.ProxyImageURL(context.Background(), imgSrv.URL+"/x.png"); got == "" {
		t.Fatal("image dropped")
	}
	if got := store.puttypes[unfurlImageKey(imgSrv.URL+"/x.png")]; got != "image/png" {
		t.Fatalf("stored content type = %q, want image/png", got)
	}
}

// Once an image is known to be stored, the cache record proves it: no S3 HEAD
// on later posts of the same image.
func TestUnfurlService_CachedImageSkipsHead(t *testing.T) {
	ctx := context.Background()
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(realPNG1x1)
	}))
	defer imgSrv.Close()

	t.Run("plain proxy", func(t *testing.T) {
		store := newFakeImageStore()
		svc := newLoopbackUnfurlService(newFakeUnfurlCache())
		svc.SetImageStore(store)
		for range 3 {
			if got := svc.ProxyImageURL(ctx, imgSrv.URL+"/plain.png"); got == "" {
				t.Fatal("image dropped")
			}
		}
		if store.headCalls != 1 || store.putCalls != 1 {
			t.Fatalf("head=%d put=%d, want one of each", store.headCalls, store.putCalls)
		}
		// The size-aware variant reuses the record (and its dims) too.
		if _, w, h := svc.ProxyImageWithSize(ctx, imgSrv.URL+"/plain.png"); w != 1 || h != 1 {
			t.Fatalf("dims = %dx%d", w, h)
		}
		if store.headCalls != 1 || store.getCalls != 0 {
			t.Fatalf("head=%d get=%d after a cached sized lookup", store.headCalls, store.getCalls)
		}
	})

	t.Run("sized proxy", func(t *testing.T) {
		store := newFakeImageStore()
		svc := newLoopbackUnfurlService(newFakeUnfurlCache())
		svc.SetImageStore(store)
		for range 3 {
			if _, w, h := svc.ProxyImageWithSize(ctx, imgSrv.URL+"/sized.png"); w != 1 || h != 1 {
				t.Fatalf("dims = %dx%d", w, h)
			}
		}
		if store.headCalls != 1 || store.putCalls != 1 {
			t.Fatalf("head=%d put=%d, want one of each", store.headCalls, store.putCalls)
		}
	})

	t.Run("object stored by an earlier process", func(t *testing.T) {
		store := newFakeImageStore()
		key := unfurlImageKey("https://cdn.example/old.png")
		store.existing[key] = true
		store.puts[key] = realPNG1x1
		svc := newLoopbackUnfurlService(newFakeUnfurlCache())
		svc.SetImageStore(store)
		if got := svc.ProxyImageURL(ctx, "https://cdn.example/old.png"); got == "" {
			t.Fatal("image dropped")
		}
		// The HEAD hit is remembered; measuring it reads the object once.
		for range 2 {
			if _, w, h := svc.ProxyImageWithSize(ctx, "https://cdn.example/old.png"); w != 1 || h != 1 {
				t.Fatalf("dims = %dx%d", w, h)
			}
		}
		if store.headCalls != 1 || store.getCalls != 1 || store.putCalls != 0 {
			t.Fatalf("head=%d get=%d put=%d", store.headCalls, store.getCalls, store.putCalls)
		}
	})

	t.Run("undecodable object is measured once", func(t *testing.T) {
		store := newFakeImageStore()
		key := unfurlImageKey("https://cdn.example/odd.ico")
		store.existing[key] = true
		store.puts[key] = []byte("not decodable")
		svc := newLoopbackUnfurlService(newFakeUnfurlCache())
		svc.SetImageStore(store)
		for range 3 {
			if u, w, h := svc.ProxyImageWithSize(ctx, "https://cdn.example/odd.ico"); u == "" || w != 0 || h != 0 {
				t.Fatalf("proxy = %q %dx%d", u, w, h)
			}
		}
		if store.headCalls != 1 || store.getCalls != 1 {
			t.Fatalf("head=%d get=%d, want the object read once", store.headCalls, store.getCalls)
		}
	})

	t.Run("failed read-back is retried", func(t *testing.T) {
		store := newFakeImageStore()
		key := unfurlImageKey("https://cdn.example/flaky.png")
		store.existing[key] = true
		store.failGet = true
		svc := newLoopbackUnfurlService(newFakeUnfurlCache())
		svc.SetImageStore(store)
		if u, w, _ := svc.ProxyImageWithSize(ctx, "https://cdn.example/flaky.png"); u == "" || w != 0 {
			t.Fatalf("first proxy = %q w=%d", u, w)
		}
		// A body that breaks mid-read is no measurement either.
		store.failGet = false
		store.failRead = true
		if u, w, _ := svc.ProxyImageWithSize(ctx, "https://cdn.example/flaky.png"); u == "" || w != 0 {
			t.Fatalf("broken-read proxy = %q w=%d", u, w)
		}
		store.failRead = false
		store.puts[key] = realPNG1x1
		if _, w, h := svc.ProxyImageWithSize(ctx, "https://cdn.example/flaky.png"); w != 1 || h != 1 {
			t.Fatalf("retried dims = %dx%d", w, h)
		}
		if store.headCalls != 1 || store.getCalls != 3 {
			t.Fatalf("head=%d get=%d", store.headCalls, store.getCalls)
		}
	})
}
