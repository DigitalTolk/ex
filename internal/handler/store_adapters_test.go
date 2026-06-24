package handler

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
)

// TestSpaHandler_ServesIndexHTML verifies that the SPA handler serves index.html
// for unknown paths (client-side routing fallback) and injects the version meta.
func TestSpaHandler_ServesIndexHTML(t *testing.T) {
	BuildVersion = "release-1"
	t.Cleanup(func() { BuildVersion = "" })
	memFS := fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("<html><head><title>app</title></head></html>")},
		"assets/main.js": &fstest.MapFile{Data: []byte("console.log('ok')")},
	}

	spa := newSPAHandler(memFS, "abc123")

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"root serves index with injected app meta", "/", http.StatusOK, `<meta name="app-version" content="abc123">`},
		{"root serves index with injected build meta", "/", http.StatusOK, `<meta name="build-version" content="release-1">`},
		{"static file served directly", "/assets/main.js", http.StatusOK, "console.log('ok')"},
		{"unknown path falls back to index", "/some/route", http.StatusOK, `<meta name="app-version" content="abc123">`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()
			spa.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d for path %q", rec.Code, tt.wantStatus, tt.path)
			}
			if tt.wantBody != "" && !strings.Contains(rec.Body.String(), tt.wantBody) {
				t.Errorf("body = %q, want to contain %q", rec.Body.String(), tt.wantBody)
			}
		})
	}
}

// TestSpaHandler_APIRoutesReturn404 verifies that /api/ and /auth/ paths are
// not handled by the SPA handler.
func TestSpaHandler_APIRoutesReturn404(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
	}

	spa := newSPAHandler(memFS, "v1")

	paths := []string{"/api/v1/users", "/api/v1/channels", "/auth/login"}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			spa.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want %d for path %q", rec.Code, http.StatusNotFound, path)
			}
		})
	}
}

// TestNewRouterWithFrontendFS verifies that the router works when frontendFS is provided.
func TestNewRouterWithFrontendFS(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
	}

	var frontendFS fs.FS = memFS

	jwtMgr := setupJWTManager()
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, FrontendFS: frontendFS, AppVersion: "test", AllowOrigins: []string{"*"},
	})

	// SPA route should return index.html.
	req := httptest.NewRequest(http.MethodGet, "/some-spa-route", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("SPA fallback: status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "<html>app</html>") {
		t.Errorf("SPA fallback: body = %q, expected index.html content", rec.Body.String())
	}
}

// TestReadJSON_NilBody verifies readJSON handles a request with nil body gracefully.
func TestReadJSON_NilBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	var dest struct {
		Name string `json:"name"`
	}
	err := readJSON(req, &dest)
	if err == nil {
		t.Fatal("expected error for nil body, got nil")
	}
}

// TestWriteJSON_UnmarshalableValue verifies writeJSON handles values that can't
// be marshaled to JSON.
func TestWriteJSON_UnmarshalableValue(t *testing.T) {
	rec := httptest.NewRecorder()
	// Channels can't be marshaled to JSON.
	ch := make(chan int)
	writeJSON(rec, http.StatusOK, ch)

	// The function will still set the header and status, but the body will
	// contain an error or be empty since Encode fails.
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

// TestQueryInt_NonNumeric verifies queryInt returns the fallback for non-numeric values.
func TestQueryInt_NonNumeric(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		param    string
		fallback int
		want     int
	}{
		{"letters", "/test?page=abc", "page", 42, 42},
		{"float", "/test?page=3.14", "page", 42, 42},
		{"special chars", "/test?page=@!", "page", 42, 42},
		{"overflow", "/test?page=99999999999999999999999", "page", 42, 42},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.url, nil)
			got := queryInt(req, tt.param, tt.fallback)
			if got != tt.want {
				t.Errorf("queryInt = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestUserStateStoreAdapter(t *testing.T) {
	backing := newUserStateAdapterBacking()
	adapter := NewUserStateStoreAdapter(backing)
	ctx := context.Background()
	item := &model.UserStateItem{UserID: "u-1", Kind: model.UserStateHiddenConversation, TargetID: "conv-1", UpdatedAt: time.Now()}

	if err := adapter.SetUserState(ctx, item); err != nil {
		t.Fatalf("SetUserState: %v", err)
	}
	rows, err := adapter.ListUserState(ctx, "u-1")
	if err != nil {
		t.Fatalf("ListUserState: %v", err)
	}
	if len(rows) != 1 || rows[0].TargetID != "conv-1" {
		t.Fatalf("rows = %+v", rows)
	}
	if err := adapter.DeleteUserState(ctx, "u-1", model.UserStateHiddenConversation, "conv-1"); err != nil {
		t.Fatalf("DeleteUserState: %v", err)
	}
	rows, err = adapter.ListUserState(ctx, "u-1")
	if err != nil {
		t.Fatalf("ListUserState after delete: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows after delete = %+v", rows)
	}
}

func TestConversationAndMessageStoreAdapterDelegates(t *testing.T) {
	ctx := context.Background()
	convBacking := &adapterConversationBacking{}
	convAdapter := NewConversationStoreAdapter(convBacking)
	when := time.Now()
	if err := convAdapter.TouchConversation(ctx, "conv-1", []string{"u-1"}, when); err != nil {
		t.Fatalf("TouchConversation: %v", err)
	}
	if !convBacking.touched.Equal(when) {
		t.Fatalf("touch time = %s, want %s", convBacking.touched, when)
	}

	msgBacking := &adapterMessageBacking{}
	msgAdapter := NewMessageStoreAdapter(msgBacking)
	msg, err := msgAdapter.IncrementReplyMetadata(ctx, "ch-1", "root-1", when, "u-1")
	if err != nil {
		t.Fatalf("IncrementReplyMetadata: %v", err)
	}
	if msg.ID != "root-1" || msg.ReplyCount != 1 {
		t.Fatalf("message = %+v", msg)
	}
	if _, err := msgAdapter.ListThreadReplies(ctx, "root-1"); err != nil {
		t.Fatalf("ListThreadReplies: %v", err)
	}
}

type adapterConversationBacking struct {
	touched time.Time
}

func (b *adapterConversationBacking) Create(context.Context, *model.Conversation, []*model.UserConversation) error {
	return nil
}
func (b *adapterConversationBacking) GetByID(context.Context, string) (*model.Conversation, error) {
	return nil, nil
}
func (b *adapterConversationBacking) ListUserConversations(context.Context, string) ([]*model.UserConversation, error) {
	return nil, nil
}
func (b *adapterConversationBacking) Activate(context.Context, string, []string) error { return nil }
func (b *adapterConversationBacking) Touch(_ context.Context, _ string, _ []string, at time.Time) error {
	b.touched = at
	return nil
}
func (b *adapterConversationBacking) IncrementMessageSeq(context.Context, string) (int64, error) {
	return 0, nil
}
func (b *adapterConversationBacking) SetConversationLastRead(context.Context, string, string, int64) error {
	return nil
}
func (b *adapterConversationBacking) SetUserConversationFavorite(context.Context, string, string, bool) error {
	return nil
}
func (b *adapterConversationBacking) SetUserConversationCategory(context.Context, string, string, string, *int) error {
	return nil
}
func (b *adapterConversationBacking) ListAll(context.Context) ([]*model.Conversation, error) {
	return nil, nil
}

type adapterMessageBacking struct{}

func (b *adapterMessageBacking) Create(context.Context, *model.Message) error { return nil }
func (b *adapterMessageBacking) GetByID(context.Context, string, string) (*model.Message, error) {
	return nil, nil
}
func (b *adapterMessageBacking) Update(context.Context, string, *model.Message) error { return nil }
func (b *adapterMessageBacking) Delete(context.Context, string, string) error         { return nil }
func (b *adapterMessageBacking) ListAfter(context.Context, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}
func (b *adapterMessageBacking) ListAround(context.Context, string, string, int, int) ([]*model.Message, bool, bool, error) {
	return nil, false, false, nil
}
func (b *adapterMessageBacking) List(context.Context, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}
func (b *adapterMessageBacking) ListThreadReplies(context.Context, string) ([]*model.Message, error) {
	return nil, nil
}
func (b *adapterMessageBacking) IncrementReplyMetadata(_ context.Context, parentID, msgID string, _ time.Time, _ string) (*model.Message, error) {
	return &model.Message{ID: msgID, ParentID: parentID, ReplyCount: 1}, nil
}

type userStateAdapterBacking struct {
	rows map[string]*model.UserStateItem
}

func newUserStateAdapterBacking() *userStateAdapterBacking {
	return &userStateAdapterBacking{rows: map[string]*model.UserStateItem{}}
}

func (b *userStateAdapterBacking) key(userID string, kind model.UserStateKind, targetID string) string {
	return userID + "#" + string(kind) + "#" + targetID
}

func (b *userStateAdapterBacking) Set(_ context.Context, item *model.UserStateItem) error {
	cp := *item
	b.rows[b.key(item.UserID, item.Kind, item.TargetID)] = &cp
	return nil
}

func (b *userStateAdapterBacking) Delete(_ context.Context, userID string, kind model.UserStateKind, targetID string) error {
	delete(b.rows, b.key(userID, kind, targetID))
	return nil
}

func (b *userStateAdapterBacking) List(_ context.Context, userID string) ([]*model.UserStateItem, error) {
	out := make([]*model.UserStateItem, 0)
	for _, row := range b.rows {
		if row.UserID != userID {
			continue
		}
		cp := *row
		out = append(out, &cp)
	}
	return out, nil
}

// setupJWTManager creates a JWT manager for test helpers.
func setupJWTManager() *jwtManagerForTest {
	return newJWTManagerForTest()
}

type jwtManagerForTest = auth.JWTManager

func newJWTManagerForTest() *auth.JWTManager {
	return auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
}
