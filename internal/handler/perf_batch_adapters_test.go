package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// Fallback arms of the batch/participation adapter methods: backings without
// the optional capability (like the data fakes here) must keep working with
// equivalent semantics. The capability arms run against the real DynamoDB
// impls in adapters_integration_test.go / perf_batch_adapters_integration_test.go.

func TestConversationStoreAdapter_GetConversationsByIDs_Forwards(t *testing.T) {
	adapter := NewConversationStoreAdapter(&adapterConversationBacking{})
	got, err := adapter.GetConversationsByIDs(context.Background(), []string{"conv-batch"})
	if err != nil || len(got) != 1 || got[0].ID != "conv-batch" {
		t.Fatalf("GetConversationsByIDs = %+v (err=%v), want the backing's row", got, err)
	}
}

// fallbackMessageBacking has NO GetMessagesByIDs — the adapter must loop
// per-ID with skip-missing semantics.
type fallbackMessageBacking struct {
	adapterMessageBacking
	msgs map[string]*model.Message // key: parentID + "#" + msgID
}

func (b *fallbackMessageBacking) GetByID(_ context.Context, parentID, msgID string) (*model.Message, error) {
	if m, ok := b.msgs[parentID+"#"+msgID]; ok {
		return m, nil
	}
	return nil, errors.New("not found")
}

func TestMessageStoreAdapter_GetMessagesByIDs_FallbackLoop(t *testing.T) {
	backing := &fallbackMessageBacking{msgs: map[string]*model.Message{
		"ch-1#m-1": {ID: "m-1", ParentID: "ch-1"},
		"ch-1#m-3": {ID: "m-3", ParentID: "ch-1"},
	}}
	adapter := NewMessageStoreAdapter(backing)
	got, err := adapter.GetMessagesByIDs(context.Background(), "ch-1", []string{"m-1", "m-missing", "m-3"})
	if err != nil {
		t.Fatalf("GetMessagesByIDs: %v", err)
	}
	if len(got) != 2 || got[0].ID != "m-1" || got[1].ID != "m-3" {
		t.Fatalf("fallback resolve = %+v, want m-1 + m-3 with the miss skipped", got)
	}
}

func TestThreadFollowStoreAdapter_ParticipationFallbacks(t *testing.T) {
	ctx := context.Background()
	backing := newDataThreadFollowStore()
	adapter := &ThreadFollowStoreAdapter{s: backing}

	// Without the marker capability the adapter reports "not seeded" and
	// treats marking as a no-op — callers stay on the legacy scan.
	seeded, err := adapter.IsThreadIndexSeeded(ctx, "u-1")
	if err != nil || seeded {
		t.Fatalf("IsThreadIndexSeeded fallback = %v (err=%v), want false", seeded, err)
	}
	if err := adapter.MarkThreadIndexSeeded(ctx, "u-1"); err != nil {
		t.Fatalf("MarkThreadIndexSeeded fallback: %v", err)
	}

	// SetThreadFollowIfAbsent falls back to read-then-write: absent → written…
	follow := &model.ThreadFollow{
		UserID: "u-1", ParentID: "ch-1", ParentType: service.ParentChannel,
		ThreadRootID: "root-1", Following: true, UpdatedAt: time.Now(),
	}
	if err := adapter.SetThreadFollowIfAbsent(ctx, follow); err != nil {
		t.Fatalf("SetThreadFollowIfAbsent: %v", err)
	}
	got, err := adapter.GetThreadFollow(ctx, "u-1", "ch-1", "root-1")
	if err != nil || !got.Following {
		t.Fatalf("follow after if-absent = %+v (err=%v), want Following=true", got, err)
	}

	// …and an existing record (a deliberate unfollow) is left untouched.
	unfollow := &model.ThreadFollow{
		UserID: "u-1", ParentID: "ch-1", ParentType: service.ParentChannel,
		ThreadRootID: "root-out", Following: false, UpdatedAt: time.Now(),
	}
	if err := adapter.SetThreadFollow(ctx, unfollow); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	refollow := &model.ThreadFollow{
		UserID: "u-1", ParentID: "ch-1", ParentType: service.ParentChannel,
		ThreadRootID: "root-out", Following: true, UpdatedAt: time.Now(),
	}
	if err := adapter.SetThreadFollowIfAbsent(ctx, refollow); err != nil {
		t.Fatalf("SetThreadFollowIfAbsent over existing: %v", err)
	}
	got, err = adapter.GetThreadFollow(ctx, "u-1", "ch-1", "root-out")
	if err != nil || got.Following {
		t.Fatalf("unfollow after if-absent = %+v (err=%v), want Following=false preserved", got, err)
	}
}

// Hashed build assets must carry immutable cache headers — without them every
// app open re-downloads the whole bundle, and on a mobile webview a stalled
// re-fetch is the "opens blank" failure. index.html stays no-store so a new
// deploy's hashes propagate immediately.
func TestSpaHandler_CacheHeaders(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<html><head></head><body>ok</body></html>")},
		"assets/main-abc.js": &fstest.MapFile{Data: []byte("console.log('ok')")},
		"favicon.svg":        &fstest.MapFile{Data: []byte("<svg/>")},
	}
	spa := newSPAHandler(memFS, "v1", SentryFrontendConfig{})

	tests := []struct {
		path      string
		wantCache string
	}{
		{"/", "no-store"},
		{"/some/spa/route", "no-store"},
		{"/assets/main-abc.js", "public, max-age=31536000, immutable"},
		{"/favicon.svg", "public, max-age=3600"},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, tt.path, nil)
		rec := httptest.NewRecorder()
		spa.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", tt.path, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != tt.wantCache {
			t.Errorf("%s: Cache-Control = %q, want %q", tt.path, got, tt.wantCache)
		}
	}
}
