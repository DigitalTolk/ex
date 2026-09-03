package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeProvider serves the three provider endpoints from canned maps.
type fakeProvider struct {
	list      string            // body for /v1/connectors
	listCode  int               // 0 → 200
	manifests map[string]string // slug → manifest body ("" → 500)
	files     map[string]string // "slug/name" → content ("" → 500)
	sawAuth   string
}

func (p *fakeProvider) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.sawAuth = r.Header.Get("Authorization")
		path := strings.TrimPrefix(r.URL.Path, "/v1/connectors")
		switch {
		case path == "" || path == "/":
			if p.listCode != 0 {
				w.WriteHeader(p.listCode)
				return
			}
			_, _ = w.Write([]byte(p.list))
		case strings.Contains(path, "/files/"):
			parts := strings.SplitN(strings.TrimPrefix(path, "/"), "/files/", 2)
			body, ok := p.files[parts[0]+"/"+parts[1]]
			if !ok || body == "" {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(body))
		default:
			slug := strings.TrimPrefix(path, "/")
			body, ok := p.manifests[slug]
			if !ok || body == "" {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(body))
		}
	})
}

func TestSyncFromProvider_NotConfigured(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	if _, err := svc.SyncFromProvider(context.Background(), "admin"); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("unconfigured: want ErrConnectorInvalid, got %v", err)
	}
	if svc.ProviderConfigured() {
		t.Fatal("ProviderConfigured: want false")
	}
}

func TestSyncFromProvider_ListErrors(t *testing.T) {
	t.Run("unreachable", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		srv.Close() // dead endpoint → transport error
		svc := NewConnectorService(newMemConnectorStore())
		svc.SetProvider(srv.URL, "k")
		if _, err := svc.SyncFromProvider(context.Background(), "admin"); err == nil || !strings.Contains(err.Error(), "unreachable") {
			t.Fatalf("dead provider: want unreachable error, got %v", err)
		}
	})
	t.Run("http 500", func(t *testing.T) {
		p := &fakeProvider{listCode: http.StatusInternalServerError}
		srv := httptest.NewServer(p.handler())
		defer srv.Close()
		svc := NewConnectorService(newMemConnectorStore())
		svc.SetProvider(srv.URL, "k")
		if _, err := svc.SyncFromProvider(context.Background(), "admin"); err == nil || !strings.Contains(err.Error(), "HTTP 500") {
			t.Fatalf("500 list: want HTTP 500 error, got %v", err)
		}
	})
	t.Run("garbage body", func(t *testing.T) {
		p := &fakeProvider{list: "{not json"}
		srv := httptest.NewServer(p.handler())
		defer srv.Close()
		svc := NewConnectorService(newMemConnectorStore())
		svc.SetProvider(srv.URL, "k")
		if _, err := svc.SyncFromProvider(context.Background(), "admin"); err == nil || !strings.Contains(err.Error(), "list") {
			t.Fatalf("garbage list: want parse error, got %v", err)
		}
	})
}

// One sync over a mixed catalog: every skip reason plus a success, so a bad
// source never blocks the rest.
func TestSyncFromProvider_MixedCatalog(t *testing.T) {
	goodManifest := `{
		"slug": "good", "revision": "abc", "title": "", "description": "provider desc",
		"files": [{"name": "api.yaml"}],
		"registration": {"title": "", "description": "", "baseURL": "https://api.example.net", "authKind": "paste", "verifyURL": "https://api.example.net/me"}
	}`
	badIngestManifest := `{
		"slug": "badingest", "revision": "abc",
		"files": [{"name": "api.yaml"}],
		"registration": {"title": "Bad", "baseURL": "https://x.example.net", "authKind": "weird"}
	}`
	noRegManifest := `{"slug": "noreg", "revision": "abc", "files": [{"name": "api.yaml"}]}`
	noFileManifest := `{
		"slug": "nofile", "revision": "abc",
		"files": [{"name": "missing.yaml"}],
		"registration": {"title": "NF", "baseURL": "https://nf.example.net", "authKind": "none"}
	}`

	p := &fakeProvider{
		list: `{"connectors": [
			{"slug": "norev", "revision": ""},
			{"slug": "gone", "revision": "abc"},
			{"slug": "badmanifest", "revision": "abc"},
			{"slug": "noreg", "revision": "abc"},
			{"slug": "nofile", "revision": "abc"},
			{"slug": "badingest", "revision": "abc"},
			{"slug": "good", "revision": "abc"}
		]}`,
		manifests: map[string]string{
			"badmanifest": "{not json",
			"noreg":       noRegManifest,
			"nofile":      noFileManifest,
			"badingest":   badIngestManifest,
			"good":        goodManifest,
			// "gone" absent → 500 on its manifest fetch
		},
		files: map[string]string{
			"good/api.yaml":      "service: api\nendpoints: []\n",
			"badingest/api.yaml": "service: api\nendpoints: []\n",
			// nofile/missing.yaml absent → 500 on file fetch
		},
	}
	srv := httptest.NewServer(p.handler())
	defer srv.Close()

	st := newMemConnectorStore()
	svc := NewConnectorService(st)
	svc.SetProvider(srv.URL+"/", "secret-key") // trailing slash exercises TrimRight

	res, err := svc.SyncFromProvider(context.Background(), "admin")
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(res.Synced) != 1 || res.Synced[0] != "good" {
		t.Fatalf("synced: want [good], got %v", res.Synced)
	}
	for slug, wantFrag := range map[string]string{
		"norev":       "no published revision",
		"gone":        "HTTP 500",
		"badmanifest": "manifest parse",
		"noreg":       "no registration",
		"nofile":      "file fetch",
		"badingest":   "ingest",
	} {
		if got, ok := res.Skipped[slug]; !ok || !strings.Contains(got, wantFrag) {
			t.Fatalf("skipped[%s]: want %q fragment, got %q (ok=%v)", slug, wantFrag, got, ok)
		}
	}

	// The good connector really landed, with title falling back to the slug
	// (registration and manifest titles both empty) and the provider's auth.
	c, ok := st.connectors["good"]
	if !ok {
		t.Fatal("good connector not ingested")
	}
	if c.Title != "good" || c.BaseURL != "https://api.example.net" || c.AuthKind != "paste" {
		t.Fatalf("ingested connector mismatch: %+v", c)
	}
	if c.Description != "provider desc" {
		t.Fatalf("description fallback: want provider desc, got %q", c.Description)
	}
	if len(st.files["good"]) != 1 || st.files["good"][0].Content == "" {
		t.Fatalf("files not ingested: %+v", st.files["good"])
	}
	if p.sawAuth != "Bearer secret-key" {
		t.Fatalf("provider auth header: got %q", p.sawAuth)
	}
}

// A slug that can't form a valid URL drives providerGet's request-build error
// arm; the sync skips that connector instead of failing.
func TestSyncFromProvider_BadSlugURL(t *testing.T) {
	p := &fakeProvider{list: `{"connectors": [{"slug": "bad\nslug", "revision": "abc"}]}`}
	srv := httptest.NewServer(p.handler())
	defer srv.Close()
	svc := NewConnectorService(newMemConnectorStore())
	svc.SetProvider(srv.URL, "k")
	res, err := svc.SyncFromProvider(context.Background(), "admin")
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(res.Synced) != 0 || res.Skipped["bad\nslug"] == "" {
		t.Fatalf("bad slug: want skipped, got %+v", res)
	}
}
