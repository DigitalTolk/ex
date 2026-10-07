package service

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Paired ex-runner installs. Pairing is a browser approval bound to the
// runner's PKCE challenge:
//
//	ex-runner (CLI)                 browser (signed-in SPA)              server
//	listen 127.0.0.1:<port>
//	open /runner/connect?port&state&challenge&name ──▶ user clicks Connect
//	                                                   CreateGrant ───────▶ one-time code
//	                    ◀── 127.0.0.1:<port>/callback?code&state
//	Exchange(code, verifier) ─────────────────────────────────────────────▶ runner token
//
// The token never crosses the browser, and the code is worthless without the
// verifier that only the CLI holds. Each issued token is a RunnerToken row
// named by the JWT's jti; the runner middleware rejects a JWT whose row is
// gone, so revoking one install never signs anyone else out.

const (
	// RunnerTokenTTL is how long a runner token lives without renewal. The
	// runner renews itself in its last week, so only a machine left off for
	// a month needs `ex-runner login` again.
	RunnerTokenTTL = 30 * 24 * time.Hour
	// runnerGrantTTL bounds the browser-to-CLI handoff: seconds in practice.
	runnerGrantTTL = 5 * time.Minute
	// runnerGrantCodeBytes is the entropy behind a one-time code.
	runnerGrantCodeBytes = 32
	// runnerLabelMax caps the machine name shown on the Runners page.
	runnerLabelMax = 64
)

var (
	// ErrRunnerGrantInvalid covers every failed code exchange — unknown,
	// used, expired, wrong verifier, account gone — deliberately alike, so a
	// prober learns nothing about which part was wrong.
	ErrRunnerGrantInvalid = errors.New("runner: this sign-in link is invalid or has expired")
	// ErrRunnerTokenRevoked reports a runner token whose record is gone or
	// expired (renewal of a dead install).
	ErrRunnerTokenRevoked = errors.New("runner: this runner was disconnected")
)

// pkcePattern matches a base64url SHA-256 (the S256 challenge) and the RFC
// 7636 verifier alphabet/length respectively.
var (
	pkceChallengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pkceVerifierPattern  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

// RunnerTokenStore persists runner tokens and pairing grants.
type RunnerTokenStore interface {
	PutRunnerGrant(ctx context.Context, g *model.RunnerGrant) error
	TakeRunnerGrant(ctx context.Context, codeHash string) (*model.RunnerGrant, error)
	PutRunnerToken(ctx context.Context, t *model.RunnerToken) error
	GetRunnerToken(ctx context.Context, id string) (*model.RunnerToken, error)
	SetRunnerTokenExpiry(ctx context.Context, id string, expiresAt time.Time) error
	ListRunnerTokens(ctx context.Context, userID string) ([]*model.RunnerToken, error)
	DeleteRunnerToken(ctx context.Context, id string) error
	DeleteAllRunnerTokensForUser(ctx context.Context, userID string) error
}

// RunnerRevoker disconnects every ex-runner a user has paired. Account
// deactivation and password reset call it next to wiping refresh tokens: a
// runner is a machine credential of the same account.
type RunnerRevoker interface {
	RevokeAllForUser(ctx context.Context, userID string) error
}

type runnerTokenUsers interface {
	GetByID(ctx context.Context, id string) (*model.User, error)
}

type runnerTokenMinter interface {
	GenerateRunnerToken(user *model.User, tokenID string, expiresAt time.Time) (string, error)
}

// IssuedRunnerToken is a freshly minted or renewed runner token.
type IssuedRunnerToken struct {
	Token     string    `json:"token"`
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	ExpiresAt time.Time `json:"expiresAt"`
	UserName  string    `json:"userName"`
}

// RunnerTokenService owns pairing, renewal and revocation of ex-runner
// installs.
type RunnerTokenService struct {
	store RunnerTokenStore
	users runnerTokenUsers
	jwt   runnerTokenMinter
	now   func() time.Time
	newID func() string
}

// NewRunnerTokenService wires the service.
func NewRunnerTokenService(st RunnerTokenStore, users runnerTokenUsers, jwt runnerTokenMinter) *RunnerTokenService {
	return &RunnerTokenService{store: st, users: users, jwt: jwt, now: time.Now, newID: store.NewID}
}

// cleanRunnerLabel makes the runner-reported machine name safe to show:
// control characters out, whitespace collapsed, length capped (on rune
// boundaries). An empty result falls back to a neutral name.
func cleanRunnerLabel(raw string) string {
	// Format characters (zero-width spaces, bidi overrides) go too: a label
	// must read on the Runners page exactly as it is stored.
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
	})
	label := strings.Join(fields, " ")
	if runes := []rune(label); len(runes) > runnerLabelMax {
		label = strings.TrimSpace(string(runes[:runnerLabelMax]))
	}
	if label == "" {
		return "Unnamed computer"
	}
	return label
}

func hashRunnerCode(code string) string {
	h := sha256.Sum256([]byte(code))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// usableRunnerOwner reports whether a user may own a runner: a real, active
// human. Agent users never run runners, and a deactivated account's runners
// must not come back through a code minted just before deactivation.
func usableRunnerOwner(u *model.User) bool {
	return !u.IsAgent() && u.Status != "deactivated"
}

// CreateGrant records the signed-in user's approval of one pairing attempt
// and returns the one-time code the browser hands to the CLI.
func (s *RunnerTokenService) CreateGrant(ctx context.Context, userID, challenge, label string) (code string, expiresAt time.Time, err error) {
	if !pkceChallengePattern.MatchString(challenge) {
		return "", time.Time{}, fmt.Errorf("%w: challenge must be an S256 PKCE challenge", ErrValidation)
	}
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("runner grant: load user: %w", err)
	}
	if !usableRunnerOwner(user) {
		return "", time.Time{}, fmt.Errorf("%w: this account can't connect a runner", ErrForbidden)
	}
	b := make([]byte, runnerGrantCodeBytes)
	if _, err := randRead(b); err != nil {
		return "", time.Time{}, fmt.Errorf("runner grant: generate code: %w", err)
	}
	code = base64.RawURLEncoding.EncodeToString(b)
	expiresAt = s.now().Add(runnerGrantTTL)
	if err := s.store.PutRunnerGrant(ctx, &model.RunnerGrant{
		CodeHash:  hashRunnerCode(code),
		UserID:    userID,
		Challenge: challenge,
		Label:     cleanRunnerLabel(label),
		ExpiresAt: expiresAt,
	}); err != nil {
		return "", time.Time{}, fmt.Errorf("runner grant: store: %w", err)
	}
	return code, expiresAt, nil
}

// Exchange redeems a one-time code plus its PKCE verifier for a runner
// token. The grant is consumed BEFORE any check, so a wrong verifier burns
// the code — no retries against one code.
func (s *RunnerTokenService) Exchange(ctx context.Context, code, verifier string) (*IssuedRunnerToken, error) {
	if code == "" || !pkceVerifierPattern.MatchString(verifier) {
		return nil, ErrRunnerGrantInvalid
	}
	grant, err := s.store.TakeRunnerGrant(ctx, hashRunnerCode(code))
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrRunnerGrantInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("runner exchange: take grant: %w", err)
	}
	now := s.now()
	sum := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if !now.Before(grant.ExpiresAt) || subtle.ConstantTimeCompare([]byte(want), []byte(grant.Challenge)) != 1 {
		return nil, ErrRunnerGrantInvalid
	}
	user, err := s.users.GetByID(ctx, grant.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrRunnerGrantInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("runner exchange: load user: %w", err)
	}
	if !usableRunnerOwner(user) {
		return nil, ErrRunnerGrantInvalid
	}
	rec := &model.RunnerToken{
		ID:        s.newID(),
		UserID:    user.ID,
		Label:     grant.Label,
		CreatedAt: now,
		ExpiresAt: now.Add(RunnerTokenTTL),
	}
	token, err := s.jwt.GenerateRunnerToken(user, rec.ID, rec.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("runner exchange: mint: %w", err)
	}
	if err := s.store.PutRunnerToken(ctx, rec); err != nil {
		return nil, fmt.Errorf("runner exchange: store token: %w", err)
	}
	return &IssuedRunnerToken{Token: token, ID: rec.ID, Label: rec.Label, ExpiresAt: rec.ExpiresAt, UserName: user.DisplayName}, nil
}

// activeRecord loads the runner token a request's claims name, nil when the
// install is gone, expired, or not the caller's.
func (s *RunnerTokenService) activeRecord(ctx context.Context, claims *model.TokenClaims) (*model.RunnerToken, error) {
	if claims.ID == "" {
		return nil, nil // pre-revocation token without a jti: never valid now
	}
	rec, err := s.store.GetRunnerToken(ctx, claims.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("runner token: load: %w", err)
	}
	if rec.UserID != claims.UserID || !s.now().Before(rec.ExpiresAt) {
		return nil, nil
	}
	return rec, nil
}

// RunnerTokenActive is the runner middleware's revocation check.
func (s *RunnerTokenService) RunnerTokenActive(ctx context.Context, claims *model.TokenClaims) (bool, error) {
	rec, err := s.activeRecord(ctx, claims)
	return rec != nil, err
}

// Renew extends a live install's token by another RunnerTokenTTL. The jti
// stays the same, so revoking the install still kills old and new JWTs alike
// — and a renewal whose response is lost leaves the old token working.
func (s *RunnerTokenService) Renew(ctx context.Context, claims *model.TokenClaims) (*IssuedRunnerToken, error) {
	rec, err := s.activeRecord(ctx, claims)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, ErrRunnerTokenRevoked
	}
	user, err := s.users.GetByID(ctx, rec.UserID)
	if err != nil {
		return nil, fmt.Errorf("runner renew: load user: %w", err)
	}
	if !usableRunnerOwner(user) {
		return nil, ErrRunnerTokenRevoked
	}
	expiresAt := s.now().Add(RunnerTokenTTL)
	if err := s.store.SetRunnerTokenExpiry(ctx, rec.ID, expiresAt); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrRunnerTokenRevoked // revoked mid-renewal
		}
		return nil, fmt.Errorf("runner renew: store: %w", err)
	}
	token, err := s.jwt.GenerateRunnerToken(user, rec.ID, expiresAt)
	if err != nil {
		return nil, fmt.Errorf("runner renew: mint: %w", err)
	}
	return &IssuedRunnerToken{Token: token, ID: rec.ID, Label: rec.Label, ExpiresAt: expiresAt, UserName: user.DisplayName}, nil
}

// List returns the user's live runner installs, newest first.
func (s *RunnerTokenService) List(ctx context.Context, userID string) ([]*model.RunnerToken, error) {
	all, err := s.store.ListRunnerTokens(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("runner tokens: list: %w", err)
	}
	now := s.now()
	live := make([]*model.RunnerToken, 0, len(all))
	for _, t := range all {
		if now.Before(t.ExpiresAt) {
			live = append(live, t)
		}
	}
	sort.SliceStable(live, func(i, j int) bool { return live[i].CreatedAt.After(live[j].CreatedAt) })
	return live, nil
}

// Revoke removes one of the user's own installs. Someone else's install
// answers ErrNotFound — exactly like a missing one, so IDs can't be probed.
func (s *RunnerTokenService) Revoke(ctx context.Context, userID, id string) error {
	rec, err := s.store.GetRunnerToken(ctx, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.ErrNotFound
		}
		return fmt.Errorf("runner tokens: load: %w", err)
	}
	if rec.UserID != userID {
		return store.ErrNotFound
	}
	if err := s.store.DeleteRunnerToken(ctx, id); err != nil {
		return fmt.Errorf("runner tokens: revoke: %w", err)
	}
	return nil
}

// RevokeSelf is `ex-runner logout`: the runner retires its own token.
// Already-gone is success — there is nothing left to undo.
func (s *RunnerTokenService) RevokeSelf(ctx context.Context, claims *model.TokenClaims) error {
	if err := s.store.DeleteRunnerToken(ctx, claims.ID); err != nil {
		return fmt.Errorf("runner tokens: revoke self: %w", err)
	}
	return nil
}

// RevokeAllForUser disconnects every runner the user has paired — account
// deactivation and password reset.
func (s *RunnerTokenService) RevokeAllForUser(ctx context.Context, userID string) error {
	if err := s.store.DeleteAllRunnerTokensForUser(ctx, userID); err != nil {
		return fmt.Errorf("runner tokens: revoke all: %w", err)
	}
	return nil
}
