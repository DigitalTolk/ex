package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/oauth2"
)

type memTokenStore struct {
	mu     sync.Mutex
	sealed map[string][]byte
	getErr error
	putErr error
	puts   int
}

func (m *memTokenStore) GetDelegatedToken(_ context.Context, userID string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getErr != nil {
		return nil, m.getErr
	}
	b, ok := m.sealed[userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return b, nil
}

func (m *memTokenStore) PutDelegatedToken(_ context.Context, userID string, sealed []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.puts++
	if m.putErr != nil {
		return m.putErr
	}
	m.sealed[userID] = sealed
	return nil
}

var testTokenKey = bytes.Repeat([]byte{7}, 32)

// refreshServer answers the refresh-token grant with a renewed token.
func refreshServer(t *testing.T, status int) (*oauth2.Config, *int) {
	t.Helper()
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = r.ParseForm()
		if r.PostFormValue("grant_type") != "refresh_token" || r.PostFormValue("refresh_token") != "refresh-1" {
			t.Errorf("refresh form = %v", r.PostForm)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != http.StatusOK {
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600, "token_type": "Bearer"})
	}))
	t.Cleanup(srv.Close)
	return &oauth2.Config{ClientID: "ex", ClientSecret: "s", Endpoint: oauth2.Endpoint{TokenURL: srv.URL, AuthStyle: oauth2.AuthStyleInParams}}, &calls
}

func TestNewDelegatedTokensNeedsA32ByteKey(t *testing.T) {
	if _, err := NewDelegatedTokens(&memTokenStore{}, []byte("short"), &oauth2.Config{}); err == nil {
		t.Fatal("want a short key refused")
	}
}

func TestDelegatedTokensSealAndRenew(t *testing.T) {
	ctx := context.Background()
	st := &memTokenStore{sealed: map[string][]byte{}}
	conf, calls := refreshServer(t, http.StatusOK)
	vault, err := NewDelegatedTokens(st, testTokenKey, conf)
	if err != nil {
		t.Fatalf("NewDelegatedTokens: %v", err)
	}

	// Nothing to keep without a refresh token.
	if err := vault.SaveDelegatedToken(ctx, "u-1", nil); err != nil || st.puts != 0 {
		t.Fatalf("nil token: %v, puts %d", err, st.puts)
	}
	if err := vault.SaveDelegatedToken(ctx, "u-1", &oauth2.Token{AccessToken: "a"}); err != nil || st.puts != 0 {
		t.Fatalf("no refresh token: %v, puts %d", err, st.puts)
	}
	if _, err := vault.TokenSource(ctx, "u-1"); !errors.Is(err, ErrNoDelegatedToken) {
		t.Fatalf("nothing stored: err = %v", err)
	}

	// Stored sealed: neither token appears in the stored bytes.
	expired := &oauth2.Token{AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Hour)}
	if err := vault.SaveDelegatedToken(ctx, "u-1", expired); err != nil {
		t.Fatalf("save: %v", err)
	}
	if b := st.sealed["u-1"]; bytes.Contains(b, []byte("refresh-1")) || bytes.Contains(b, []byte("access-1")) {
		t.Fatal("token stored in the clear")
	}

	// An expired token is renewed once and the renewed one saved.
	ts, err := vault.TokenSource(ctx, "u-1")
	if err != nil {
		t.Fatalf("TokenSource: %v", err)
	}
	for range 2 {
		tok, err := ts.Token()
		if err != nil || tok.AccessToken != "access-2" {
			t.Fatalf("Token = %+v, %v", tok, err)
		}
	}
	if *calls != 1 || st.puts != 2 {
		t.Fatalf("refreshes %d, puts %d", *calls, st.puts)
	}
	ts, _ = vault.TokenSource(ctx, "u-1")
	if tok, _ := ts.Token(); tok.AccessToken != "access-2" || tok.RefreshToken != "refresh-2" || *calls != 1 {
		t.Fatalf("the saved renewal is used next time: %+v, refreshes %d", tok, *calls)
	}
	if st.puts != 2 {
		t.Fatalf("a token that wasn't renewed was saved again (puts %d)", st.puts)
	}

	// A renewal that can't be saved still hands out the token.
	st.sealed["u-1"] = vault.seal("u-1", expired)
	st.putErr = errors.New("dynamo")
	ts, _ = vault.TokenSource(ctx, "u-1")
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "access-2" {
		t.Fatalf("Token = %+v, %v", tok, err)
	}
}

func TestDelegatedTokensRefusedRenewal(t *testing.T) {
	st := &memTokenStore{sealed: map[string][]byte{}}
	conf, _ := refreshServer(t, http.StatusBadRequest)
	vault, _ := NewDelegatedTokens(st, testTokenKey, conf)
	st.sealed["u-1"] = vault.seal("u-1", &oauth2.Token{AccessToken: "a", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Hour)})
	ts, err := vault.TokenSource(context.Background(), "u-1")
	if err != nil {
		t.Fatalf("TokenSource: %v", err)
	}
	var re *oauth2.RetrieveError
	if _, err := ts.Token(); !errors.As(err, &re) || re.ErrorCode != "invalid_grant" {
		t.Fatalf("err = %v, want the refusal", err)
	}
}

func TestDelegatedTokensUnreadable(t *testing.T) {
	ctx := context.Background()
	st := &memTokenStore{sealed: map[string][]byte{}}
	vault, _ := NewDelegatedTokens(st, testTokenKey, &oauth2.Config{})
	other, _ := NewDelegatedTokens(st, bytes.Repeat([]byte{9}, 32), &oauth2.Config{})
	tok := &oauth2.Token{AccessToken: "a", RefreshToken: "r"}

	for name, sealed := range map[string][]byte{
		"sealed for someone else":  vault.seal("u-2", tok),
		"sealed under another key": other.seal("u-1", tok),
		"too short":                {1, 2},
		"not a token":              vault.aead.Seal(make([]byte, 12), make([]byte, 12), []byte("not json"), []byte("u-1")),
	} {
		st.sealed["u-1"] = sealed
		if _, err := vault.TokenSource(ctx, "u-1"); !errors.Is(err, ErrNoDelegatedToken) {
			t.Errorf("%s: err = %v, want ErrNoDelegatedToken", name, err)
		}
	}
	st.getErr = errors.New("dynamo")
	if _, err := vault.TokenSource(ctx, "u-1"); err == nil || errors.Is(err, ErrNoDelegatedToken) || !strings.Contains(err.Error(), "dynamo") {
		t.Fatalf("store error: err = %v", err)
	}
}

func TestMustAEADPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("want a panic")
		}
	}()
	mustAEAD(0, errors.New("bad key"))
}
