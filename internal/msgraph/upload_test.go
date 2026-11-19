package msgraph

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// A small file goes in one request, into the folder under the user's
// OneDrive root, renamed rather than replacing a file of the same name.
func TestDelegatedUploadSmallFile(t *testing.T) {
	var got struct {
		path, query, auth, body string
		length                  int64
	}
	d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.path, got.query, got.auth, got.body, got.length = r.URL.EscapedPath(), r.URL.RawQuery, r.Header.Get("Authorization"), string(b), r.ContentLength
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "it-1", "name": "Q3 plan.docx", "size": 5, "webUrl": "https://contoso-my.sharepoint.com/personal/a/Q3%20plan.docx"})
	})
	item, err := d.Upload(context.Background(), staticToken("tok"), []string{"Ex", "deal room"}, "Q3 plan.docx", strings.NewReader("hello and more"), 5)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if item.ID != "it-1" || item.WebURL == "" {
		t.Fatalf("item = %+v", item)
	}
	if got.path != "/me/drive/root:/Ex/deal%20room/Q3%20plan.docx:/content" || got.query != "@microsoft.graph.conflictBehavior=rename" {
		t.Fatalf("PUT %s?%s", got.path, got.query)
	}
	// Exactly the declared bytes, as the user.
	if got.auth != "Bearer tok" || got.body != "hello" || got.length != 5 {
		t.Fatalf("auth %q body %q length %d", got.auth, got.body, got.length)
	}
}

// A large file goes through an upload session: created as the user, then
// sent chunk by chunk to the session's own address with no token, each
// chunk placed by its Content-Range; the last answer is the new item.
func TestDelegatedUploadLargeFileInChunks(t *testing.T) {
	size := int64(uploadChunk + 1234)
	data := bytes.Repeat([]byte("x"), int(size))
	var mu sync.Mutex
	var ranges []string
	var received int
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, ":/createUploadSession"):
			if r.Header.Get("Authorization") != "Bearer tok" || r.URL.EscapedPath() != "/me/drive/root:/Ex/ops/big.pptx:/createUploadSession" {
				t.Errorf("session request %s auth %q", r.URL.EscapedPath(), r.Header.Get("Authorization"))
			}
			var body map[string]map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["item"]["@microsoft.graph.conflictBehavior"] != "rename" {
				t.Errorf("session body = %v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"uploadUrl": srv.URL + "/session/abc"})
		case r.URL.Path == "/session/abc" && r.Method == http.MethodPut:
			if r.Header.Get("Authorization") != "" {
				t.Errorf("a token went to the session address")
			}
			b, _ := io.ReadAll(r.Body)
			received += len(b)
			ranges = append(ranges, r.Header.Get("Content-Range"))
			if received < int(size) {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "big-1", "webUrl": "https://contoso-my.sharepoint.com/big.pptx"})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	d, err := NewDelegated(srv.URL, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	item, err := d.Upload(context.Background(), staticToken("tok"), []string{"Ex", "ops"}, "big.pptx", bytes.NewReader(data), size)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if item.ID != "big-1" || received != int(size) {
		t.Fatalf("item %+v, received %d of %d", item, received, size)
	}
	want := []string{
		fmt.Sprintf("bytes 0-%d/%d", uploadChunk-1, size),
		fmt.Sprintf("bytes %d-%d/%d", uploadChunk, size-1, size),
	}
	if strings.Join(ranges, "|") != strings.Join(want, "|") {
		t.Fatalf("ranges = %v, want %v", ranges, want)
	}
}

// A chunk Graph refuses ends the upload and lets the session go; so does a
// body shorter than it said.
func TestDelegatedUploadSessionFailures(t *testing.T) {
	size := int64(uploadChunk * 2)
	for _, c := range []struct {
		name     string
		body     io.Reader
		chunkErr bool
	}{
		{"refused chunk", bytes.NewReader(make([]byte, size)), true},
		{"short body", bytes.NewReader(make([]byte, uploadChunk+10)), false},
	} {
		var deleted bool
		var srv *httptest.Server
		srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasSuffix(r.URL.Path, ":/createUploadSession"):
				_ = json.NewEncoder(w).Encode(map[string]string{"uploadUrl": srv.URL + "/session/x"})
			case r.Method == http.MethodDelete:
				deleted = true
				w.WriteHeader(http.StatusNoContent)
			case c.chunkErr:
				w.WriteHeader(http.StatusInsufficientStorage)
			default:
				_, _ = io.Copy(io.Discard, r.Body)
				w.WriteHeader(http.StatusAccepted)
			}
		}))
		d, _ := NewDelegated(srv.URL, srv.Client())
		_, err := d.Upload(context.Background(), staticToken("tok"), []string{"Ex"}, "a.xlsx", c.body, size)
		srv.Close()
		if err == nil || !deleted {
			t.Errorf("%s: err %v, session deleted %v", c.name, err, deleted)
		}
	}
}

func TestDelegatedUploadRefusals(t *testing.T) {
	ctx := context.Background()
	big := int64(simpleUploadMax + 1)

	// No session, or one with an address that isn't https.
	for _, answer := range []func(w http.ResponseWriter){
		func(w http.ResponseWriter) { w.WriteHeader(http.StatusForbidden) },
		func(w http.ResponseWriter) { _ = json.NewEncoder(w).Encode(map[string]string{"uploadUrl": "http://plain.example.com/s"}) },
	} {
		d := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { answer(w) })
		if _, err := d.Upload(ctx, staticToken("tok"), []string{"Ex"}, "a.docx", bytes.NewReader(make([]byte, big)), big); err == nil {
			t.Error("want the upload refused")
		}
	}

	// A refused small upload keeps Graph's verdict.
	d := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) })
	if _, err := d.Upload(ctx, staticToken("tok"), []string{"Ex"}, "a.docx", strings.NewReader("x"), 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("small upload refused: %v", err)
	}

	// No token, no request.
	if _, err := d.Upload(ctx, failingTokens{err: errors.New("offline")}, []string{"Ex"}, "a.docx", strings.NewReader("x"), 1); err == nil {
		t.Fatal("want the token failure")
	}
}
