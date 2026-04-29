package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
)

// stubSearcher records each query and returns canned hits so we can
// assert both invocation and response shape without a live cluster.
type stubSearcher struct {
	calls        []string
	usersHits    []search.SearchHit
	channelsHits []search.SearchHit
	messagesHits []search.SearchHit
	filesHits    []search.SearchHit
	allowedSeen  []string
	lastOpts     search.MessageQuery
}

func (s *stubSearcher) Users(_ context.Context, q string, _ int) (*search.SearchResult, error) {
	s.calls = append(s.calls, "users:"+q)
	return &search.SearchResult{Total: len(s.usersHits), Hits: s.usersHits}, nil
}

func (s *stubSearcher) Channels(_ context.Context, q string, _ int) (*search.SearchResult, error) {
	s.calls = append(s.calls, "channels:"+q)
	return &search.SearchResult{Total: len(s.channelsHits), Hits: s.channelsHits}, nil
}

func (s *stubSearcher) Messages(_ context.Context, opts search.MessageQuery) (*search.SearchResult, error) {
	s.calls = append(s.calls, "messages:"+opts.Q)
	s.allowedSeen = append(s.allowedSeen, opts.AllowedParentIDs...)
	s.lastOpts = opts
	return &search.SearchResult{Total: len(s.messagesHits), Hits: s.messagesHits}, nil
}

func (s *stubSearcher) Files(_ context.Context, opts search.MessageQuery) (*search.SearchResult, error) {
	s.calls = append(s.calls, "files:"+opts.Q)
	s.allowedSeen = append(s.allowedSeen, opts.AllowedParentIDs...)
	s.lastOpts = opts
	return &search.SearchResult{Total: len(s.filesHits), Hits: s.filesHits}, nil
}

type stubAccess struct {
	parents []string
	err     error
}

func (s *stubAccess) AllowedParentIDs(_ context.Context, _ string) ([]string, error) {
	return s.parents, s.err
}

func setupSearchTest(t *testing.T) (*SearchHandler, *stubSearcher, *stubAccess, *auth.JWTManager) {
	t.Helper()
	s := &stubSearcher{}
	a := &stubAccess{}
	h := NewSearchHandler(s, a)
	jwtMgr := auth.NewJWTManager("search-secret", 15*time.Minute, 24*time.Hour)
	return h, s, a, jwtMgr
}

func TestSearchHandler_Users_OK(t *testing.T) {
	h, sr, _, jwtMgr := setupSearchTest(t)
	sr.usersHits = []search.SearchHit{{ID: "u-1", Source: map[string]any{"displayName": "Alice"}}}
	user := &model.User{ID: "u-2", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search/users?q=alice", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchUsers)).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got search.SearchResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Hits) != 1 || got.Hits[0].ID != "u-1" {
		t.Fatalf("unexpected hits: %+v", got.Hits)
	}
	if len(sr.calls) != 1 || sr.calls[0] != "users:alice" {
		t.Fatalf("expected stub Users(alice), got %v", sr.calls)
	}
}

func TestSearchHandler_Channels_OK(t *testing.T) {
	h, sr, _, jwtMgr := setupSearchTest(t)
	sr.channelsHits = []search.SearchHit{{ID: "c-1"}}
	user := &model.User{ID: "u-2", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search/channels?q=eng", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchChannels)).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(sr.calls) != 1 || sr.calls[0] != "channels:eng" {
		t.Fatalf("expected Channels(eng), got %v", sr.calls)
	}
}

func TestSearchHandler_Messages_AppliesRBACFilter(t *testing.T) {
	h, sr, ac, jwtMgr := setupSearchTest(t)
	ac.parents = []string{"ch-1", "conv-2"}
	user := &model.User{ID: "u-2", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search/messages?q=hello", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchMessages)).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(sr.allowedSeen) != 2 || sr.allowedSeen[0] != "ch-1" || sr.allowedSeen[1] != "conv-2" {
		t.Fatalf("expected allowed=[ch-1 conv-2], got %v", sr.allowedSeen)
	}
}

func TestSearchHandler_Messages_RejectsUnauthenticated(t *testing.T) {
	h, _, _, _ := setupSearchTest(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search/messages?q=x", nil)
	// No auth wrapper — context lacks a userID.
	h.SearchMessages(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestSearchHandler_NilSearcher_ReturnsEmpty(t *testing.T) {
	// When search isn't configured the handler degrades to empty
	// results so the UI can show a clean "no results" state. Hit
	// each endpoint so the nil-searcher branch in all three is
	// exercised.
	h := NewSearchHandler(nil, nil)
	for _, path := range []string{"/api/v1/search/users", "/api/v1/search/channels", "/api/v1/search/messages"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path+"?q=x", nil)
		switch path {
		case "/api/v1/search/users":
			h.SearchUsers(rec, req)
		case "/api/v1/search/channels":
			h.SearchChannels(rec, req)
		case "/api/v1/search/messages":
			h.SearchMessages(rec, req)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, rec.Code)
		}
		var got search.SearchResult
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s decode: %v", path, err)
		}
		if len(got.Hits) != 0 {
			t.Fatalf("%s: expected empty hits, got %v", path, got.Hits)
		}
	}
}

// erroringSearcher returns errors from every method so we can drive
// the 500 path on each endpoint.
type erroringSearcher struct{}

func (erroringSearcher) Users(context.Context, string, int) (*search.SearchResult, error) {
	return nil, errSearch
}
func (erroringSearcher) Channels(context.Context, string, int) (*search.SearchResult, error) {
	return nil, errSearch
}
func (erroringSearcher) Messages(context.Context, search.MessageQuery) (*search.SearchResult, error) {
	return nil, errSearch
}
func (erroringSearcher) Files(context.Context, search.MessageQuery) (*search.SearchResult, error) {
	return nil, errSearch
}

var errSearch = errors.New("opensearch fell over")

func TestSearchHandler_BackendError_ReturnsStatus500(t *testing.T) {
	h := NewSearchHandler(erroringSearcher{}, &stubAccess{parents: []string{"x"}})
	jwtMgr := auth.NewJWTManager("err-secret", 15*time.Minute, 24*time.Hour)
	user := &model.User{ID: "u-2", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	for _, route := range []struct {
		path string
		fn   http.HandlerFunc
	}{
		{"/api/v1/search/users?q=x", h.SearchUsers},
		{"/api/v1/search/channels?q=x", h.SearchChannels},
		{"/api/v1/search/messages?q=x", h.SearchMessages},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, route.path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		middleware.Auth(jwtMgr)(route.fn).ServeHTTP(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("%s: status = %d, want 500", route.path, rec.Code)
		}
	}
}

func TestSearchHandler_Files_PassesQueryParams(t *testing.T) {
	h, sr, ac, jwtMgr := setupSearchTest(t)
	ac.parents = []string{"ch-1"}
	sr.filesHits = []search.SearchHit{{ID: "m-7", Source: map[string]any{"body": "see attached"}}}
	user := &model.User{ID: "u-2", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search/files?q=design.pdf&from=u-1&in=ch-1&sort=newest", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchFiles)).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if sr.lastOpts.Q != "design.pdf" || sr.lastOpts.FromUserID != "u-1" || sr.lastOpts.InParentID != "ch-1" || sr.lastOpts.Sort != "newest" {
		t.Fatalf("opts not threaded: %+v", sr.lastOpts)
	}
}

func TestSearchHandler_Messages_AccessError_Returns500(t *testing.T) {
	// Failing to compute the user's allowed parent IDs is a hard error —
	// returning unfiltered results would leak.
	h := NewSearchHandler(&stubSearcher{}, &stubAccess{err: errors.New("boom")})
	jwtMgr := auth.NewJWTManager("err-secret-2", 15*time.Minute, 24*time.Hour)
	user := &model.User{ID: "u-2", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search/messages?q=x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.SearchMessages)).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
