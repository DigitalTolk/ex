package msgraph

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// newTokenServer returns an httptest server answering the client-credentials
// grant, plus a counter of token requests served.
func newTokenServer(t *testing.T, expiresIn int64) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse token form: %v", err)
		}
		for key, want := range map[string]string{
			"client_id":     "client",
			"client_secret": "secret",
			"scope":         defaultScope,
			"grant_type":    "client_credentials",
		} {
			if got := r.PostFormValue(key); got != want {
				t.Errorf("token form %s = %q, want %q", key, got, want)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok-1", "expires_in": expiresIn})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func newClient(t *testing.T, tokenURL, baseURL string) *Client {
	t.Helper()
	c, err := New(Config{
		TenantID:     "tenant",
		ClientID:     "client",
		ClientSecret: "secret",
		TokenURL:     tokenURL,
		BaseURL:      baseURL,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestNewDisabledWhenUnconfigured(t *testing.T) {
	for name, cfg := range map[string]Config{
		"empty":     {},
		"no tenant": {ClientID: "c", ClientSecret: "s"},
		"no id":     {TenantID: "t", ClientSecret: "s"},
		"no secret": {TenantID: "t", ClientID: "c"},
	} {
		c, err := New(cfg)
		if c != nil || err != nil {
			t.Errorf("%s: New = (%v, %v), want (nil, nil)", name, c, err)
		}
	}
}

func TestNewValidatesURLs(t *testing.T) {
	if _, err := New(Config{TenantID: "t", ClientID: "c", ClientSecret: "s", TokenURL: "://bad"}); err == nil {
		t.Fatal("expected token URL error")
	}
	if _, err := New(Config{TenantID: "t", ClientID: "c", ClientSecret: "s", BaseURL: "://bad"}); err == nil {
		t.Fatal("expected base URL error")
	}
}

func TestNewDefaults(t *testing.T) {
	c, err := New(Config{TenantID: "my tenant", ClientID: " c ", ClientSecret: " s "})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if want := "https://login.microsoftonline.com/my%20tenant/oauth2/v2.0/token"; c.tokenURL != want {
		t.Errorf("tokenURL = %q, want %q", c.tokenURL, want)
	}
	if c.baseURL != defaultBaseURL {
		t.Errorf("baseURL = %q, want default", c.baseURL)
	}
	if c.clientID != "c" || c.clientSecret != "s" {
		t.Errorf("credentials not trimmed: %q %q", c.clientID, c.clientSecret)
	}
	if c.client == nil || c.client.Timeout != 10*time.Second {
		t.Errorf("default HTTP client not applied: %+v", c.client)
	}
}

func TestTokenCachedAcrossCalls(t *testing.T) {
	tokenSrv, tokenCalls := newTokenServer(t, 3600)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok-1" {
			t.Errorf("Authorization = %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "u1"})
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	for range 2 {
		if _, err := c.GetUserProfile(context.Background(), "alice@example.com"); err != nil {
			t.Fatalf("GetUserProfile: %v", err)
		}
	}
	if got := tokenCalls.Load(); got != 1 {
		t.Errorf("token fetched %d times, want 1 (cached)", got)
	}
}

func TestTokenShortExpiryRefetches(t *testing.T) {
	// expires_in below the safety margin clamps the cached TTL to zero, so
	// the next call fetches a fresh token.
	tokenSrv, tokenCalls := newTokenServer(t, 30)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "u1"})
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	for range 2 {
		if _, err := c.GetUserProfile(context.Background(), "alice@example.com"); err != nil {
			t.Fatalf("GetUserProfile: %v", err)
		}
	}
	if got := tokenCalls.Load(); got != 2 {
		t.Errorf("token fetched %d times, want 2 (expired immediately)", got)
	}
}

func TestTokenErrors(t *testing.T) {
	t.Run("network error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		srv.Close() // dead endpoint
		c := newClient(t, srv.URL, "http://unused.invalid")
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "token request") {
			t.Fatalf("err = %v, want token request error", err)
		}
	})
	t.Run("non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		}))
		defer srv.Close()
		c := newClient(t, srv.URL, "http://unused.invalid")
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "status 400") {
			t.Fatalf("err = %v, want status 400 error", err)
		}
	})
	t.Run("bad JSON", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("{not json"))
		}))
		defer srv.Close()
		c := newClient(t, srv.URL, "http://unused.invalid")
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "parse token response") {
			t.Fatalf("err = %v, want parse error", err)
		}
	})
	t.Run("empty access token", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"expires_in": 3600})
		}))
		defer srv.Close()
		c := newClient(t, srv.URL, "http://unused.invalid")
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "no access token") {
			t.Fatalf("err = %v, want no-access-token error", err)
		}
	})
}

func TestGetUserProfile(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want := "/users/alice@example.com"; r.URL.Path != want {
			t.Errorf("path = %q, want %q", r.URL.Path, want)
		}
		if got := r.URL.Query().Get("$select"); !strings.Contains(got, "mobilePhone") {
			t.Errorf("$select = %q, want mobilePhone included", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                "u1",
			"displayName":       "Alice",
			"mail":              "alice@example.com",
			"userPrincipalName": "alice@corp.example.com",
			"mobilePhone":       "+46 70 123 45 67",
			"businessPhones":    []string{"+46 8 123 456"},
		})
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	p, err := c.GetUserProfile(context.Background(), "alice@example.com")
	if err != nil {
		t.Fatalf("GetUserProfile: %v", err)
	}
	if p.ID != "u1" || p.DisplayName != "Alice" || p.Phone() != "+46 70 123 45 67" {
		t.Errorf("unexpected profile: %+v", p)
	}
}

func TestGetUserManager(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want := "/users/u1/manager"; r.URL.Path != want {
			t.Errorf("path = %q, want %q", r.URL.Path, want)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "m1", "displayName": "Boss"})
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	p, err := c.GetUserManager(context.Background(), "u1")
	if err != nil {
		t.Fatalf("GetUserManager: %v", err)
	}
	if p.ID != "m1" || p.DisplayName != "Boss" {
		t.Errorf("unexpected manager: %+v", p)
	}
}

func TestGetUserManagerError(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	if _, err := c.GetUserManager(context.Background(), "u1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestDoJSONErrorMapping(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	t.Run("404 is ErrNotFound", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()
		c := newClient(t, tokenSrv.URL, srv.URL)
		if _, err := c.GetUserProfile(context.Background(), "ghost"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
	t.Run("5xx is status error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		}))
		defer srv.Close()
		c := newClient(t, tokenSrv.URL, srv.URL)
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "status 502") {
			t.Fatalf("err = %v, want status 502 error", err)
		}
	})
	t.Run("bad body JSON", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("{broken"))
		}))
		defer srv.Close()
		c := newClient(t, tokenSrv.URL, srv.URL)
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "parse response") {
			t.Fatalf("err = %v, want parse error", err)
		}
	})
	t.Run("network error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		srv.Close()
		c := newClient(t, tokenSrv.URL, srv.URL)
		if _, err := c.GetUserProfile(context.Background(), "a"); err == nil || !strings.Contains(err.Error(), "msgraph: request:") {
			t.Fatalf("err = %v, want request error", err)
		}
	})
}

func TestCreateOnlineMeeting(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	var got onlineMeetingPayload
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want := "/users/org-1/onlineMeetings"; r.URL.Path != want || r.Method != http.MethodPost {
			t.Errorf("%s %s, want POST %s", r.Method, r.URL.Path, want)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "m1", "joinWebUrl": "https://teams.microsoft.com/l/meetup-join/x", "subject": got.Subject})
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	start := time.Date(2026, 7, 12, 18, 0, 0, 0, time.UTC)
	meeting, err := c.CreateOnlineMeeting(context.Background(), "org-1", OnlineMeetingRequest{
		Subject:      "Teams meeting · ~general",
		StartAt:      start,
		EndAt:        start.Add(time.Hour),
		AttendeeUPNs: []string{"bob@example.com", "  ", "carol@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateOnlineMeeting: %v", err)
	}
	if meeting.JoinURL != "https://teams.microsoft.com/l/meetup-join/x" || meeting.ID != "m1" {
		t.Errorf("unexpected meeting: %+v", meeting)
	}
	if got.StartDateTime != "2026-07-12T18:00:00Z" || got.EndDateTime != "2026-07-12T19:00:00Z" {
		t.Errorf("times = %q → %q", got.StartDateTime, got.EndDateTime)
	}
	if len(got.Participants.Attendees) != 2 ||
		got.Participants.Attendees[0] != (meetingParticipantPayload{UPN: "bob@example.com", Role: "attendee"}) ||
		got.Participants.Attendees[1].UPN != "carol@example.com" {
		t.Errorf("attendees = %+v", got.Participants.Attendees)
	}
}

func TestCreateOnlineMeetingWithoutJoinURL(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "m1"})
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	if _, err := c.CreateOnlineMeeting(context.Background(), "org-1", OnlineMeetingRequest{}); err == nil || !strings.Contains(err.Error(), "join URL") {
		t.Fatalf("err = %v, want join URL error", err)
	}
}

func TestCreateOnlineMeetingError(t *testing.T) {
	tokenSrv, _ := newTokenServer(t, 3600)
	graphSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer graphSrv.Close()

	c := newClient(t, tokenSrv.URL, graphSrv.URL)
	if _, err := c.CreateOnlineMeeting(context.Background(), "org-1", OnlineMeetingRequest{}); err == nil || !strings.Contains(err.Error(), "status 403") {
		t.Fatalf("err = %v, want status 403 error", err)
	}
}

func TestProfileAccessors(t *testing.T) {
	p := &UserProfile{MobilePhone: "m", BusinessPhones: []string{"b"}}
	if p.Phone() != "m" {
		t.Errorf("Phone() = %q, want mobile", p.Phone())
	}
	p.MobilePhone = ""
	if p.Phone() != "b" {
		t.Errorf("Phone() = %q, want business", p.Phone())
	}
	p.BusinessPhones = nil
	if p.Phone() != "" {
		t.Errorf("Phone() = %q, want empty", p.Phone())
	}

	p = &UserProfile{Mail: "mail@x.com", UserPrincipalName: "upn@x.com"}
	if p.EmailAddress() != "mail@x.com" {
		t.Errorf("EmailAddress() = %q, want mail", p.EmailAddress())
	}
	p.Mail = ""
	if p.EmailAddress() != "upn@x.com" {
		t.Errorf("EmailAddress() = %q, want UPN", p.EmailAddress())
	}
}

func TestMustHelpersPanic(t *testing.T) {
	assertPanics := func(name string, fn func()) {
		defer func() {
			if recover() == nil {
				t.Errorf("%s: expected panic", name)
			}
		}()
		fn()
	}
	assertPanics("mustRequest", func() { mustRequest(nil, errors.New("boom")) })
	assertPanics("mustJSON", func() { mustJSON(nil, errors.New("boom")) })
}
