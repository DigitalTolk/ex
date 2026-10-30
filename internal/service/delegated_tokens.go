package service

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/oauth2"
)

// ErrNoDelegatedToken: no Microsoft token is stored for the user (they last
// signed in before SharePoint sharing was turned on, or never through SSO).
var ErrNoDelegatedToken = errors.New("delegated token: none stored")

// DelegatedTokenStore persists each user's sealed Microsoft token.
type DelegatedTokenStore interface {
	GetDelegatedToken(ctx context.Context, userID string) ([]byte, error)
	PutDelegatedToken(ctx context.Context, userID string, sealed []byte) error
}

// DelegatedTokens keeps each SSO user's Microsoft (delegated Graph) token,
// the one their login returned, so the app can share SharePoint files as
// them later. Tokens are stored sealed with AES-256-GCM under a key only the
// app holds, bound to their user so a sealed token can't be replayed as
// someone else's. TokenSource renews an expired token with its refresh token
// and stores the renewed one.
type DelegatedTokens struct {
	store DelegatedTokenStore
	aead  cipher.AEAD
	oauth *oauth2.Config
}

// NewDelegatedTokens builds the vault. key must be 32 bytes; oauth is the SSO
// client, which renews the tokens.
func NewDelegatedTokens(st DelegatedTokenStore, key []byte, oauth *oauth2.Config) (*DelegatedTokens, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("delegated tokens: key must be 32 bytes, got %d", len(key))
	}
	aead := mustAEAD(cipher.NewGCM(mustAEAD(aes.NewCipher(key))))
	return &DelegatedTokens{store: st, aead: aead, oauth: oauth}, nil
}

// SaveDelegatedToken stores the token a login returned. A token without a
// refresh token can't be renewed and is not worth keeping.
func (t *DelegatedTokens) SaveDelegatedToken(ctx context.Context, userID string, tok *oauth2.Token) error {
	if tok == nil || tok.RefreshToken == "" {
		return nil
	}
	return t.store.PutDelegatedToken(ctx, userID, t.seal(userID, tok))
}

// TokenSource returns the user's token, renewed when it has expired. Fails
// with ErrNoDelegatedToken when none is stored.
func (t *DelegatedTokens) TokenSource(ctx context.Context, userID string) (oauth2.TokenSource, error) {
	sealed, err := t.store.GetDelegatedToken(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNoDelegatedToken
	}
	if err != nil {
		return nil, fmt.Errorf("delegated tokens: read: %w", err)
	}
	tok, err := t.open(userID, sealed)
	if err != nil {
		// A token sealed under another key (the key was rotated) is as good
		// as none: the next sign-in stores a fresh one.
		slog.WarnContext(ctx, "stored Microsoft token can't be opened", "userID", userID, "error", err)
		return nil, ErrNoDelegatedToken
	}
	return &savingTokenSource{
		base:  t.oauth.TokenSource(ctx, tok),
		saved: tok.AccessToken,
		save: func(renewed *oauth2.Token) {
			if err := t.store.PutDelegatedToken(ctx, userID, t.seal(userID, renewed)); err != nil {
				// The old refresh token stays valid for a while; the next
				// renewal tries again.
				slog.WarnContext(ctx, "renewed Microsoft token not saved", "userID", userID, "error", err)
			}
		},
	}, nil
}

func (t *DelegatedTokens) seal(userID string, tok *oauth2.Token) []byte {
	plain := mustJSONBody(json.Marshal(tok))
	nonce := make([]byte, t.aead.NonceSize())
	_, _ = rand.Read(nonce) // crypto/rand.Read never fails (Go 1.24+)
	return t.aead.Seal(nonce, nonce, plain, []byte(userID))
}

func (t *DelegatedTokens) open(userID string, sealed []byte) (*oauth2.Token, error) {
	n := t.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealed token too short")
	}
	plain, err := t.aead.Open(nil, sealed[:n], sealed[n:], []byte(userID))
	if err != nil {
		return nil, err
	}
	var tok oauth2.Token
	if err := json.Unmarshal(plain, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

// savingTokenSource hands out base's tokens and saves each renewed one, so
// the next job starts from the newest token (and refresh token).
type savingTokenSource struct {
	base oauth2.TokenSource
	save func(*oauth2.Token)

	mu    sync.Mutex
	saved string // the access token last saved
}

func (s *savingTokenSource) Token() (*oauth2.Token, error) {
	tok, err := s.base.Token()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if tok.AccessToken != s.saved {
		s.saved = tok.AccessToken
		s.save(tok)
	}
	return tok, nil
}
