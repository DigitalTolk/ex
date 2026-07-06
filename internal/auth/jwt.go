package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/golang-jwt/jwt/v5"
)

// jwtIssuer / jwtAudience pin the `iss` and `aud` claims so a token minted for
// this app can't be replayed against a different service that happens to share
// the signing secret. Validation rejects any token missing or mismatching them.
const (
	jwtIssuer   = "ex"
	jwtAudience = "ex"
)

// randRead is a seam for crypto/rand.Read so tests can exercise the
// entropy-failure path, which is otherwise unreachable in practice.
var randRead = rand.Read

// JWTManager handles creation and validation of JWT access tokens and refresh tokens.
type JWTManager struct {
	secret     []byte
	accessTTL  time.Duration
	refreshTTL time.Duration
}

// NewJWTManager creates a JWTManager with the given signing secret and TTLs.
func NewJWTManager(secret string, accessTTL, refreshTTL time.Duration) *JWTManager {
	return &JWTManager{
		secret:     []byte(secret),
		accessTTL:  accessTTL,
		refreshTTL: refreshTTL,
	}
}

// RefreshTTL returns the configured refresh token TTL.
func (m *JWTManager) RefreshTTL() time.Duration {
	return m.refreshTTL
}

// GenerateAccessToken creates a signed JWT containing the user's claims.
func (m *JWTManager) GenerateAccessToken(user *model.User) (string, error) {
	now := time.Now()
	claims := model.TokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(m.accessTTL)),
		},
		UserID:      user.ID,
		Email:       user.Email,
		DisplayName: user.DisplayName,
		SystemRole:  user.SystemRole,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(m.secret)
}

// GenerateRefreshToken produces a cryptographically random refresh token.
// It returns the raw base64url-encoded value (to send to the client) and the
// SHA-256 hash of that value (to store server-side).
func (m *JWTManager) GenerateRefreshToken() (raw string, hash string, err error) {
	b := make([]byte, 32)
	if _, err = randRead(b); err != nil {
		return "", "", fmt.Errorf("generate refresh token: %w", err)
	}

	raw = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(raw))
	hash = base64.RawURLEncoding.EncodeToString(h[:])
	return raw, hash, nil
}

// ValidateToken parses and validates a JWT string, returning the embedded claims.
func (m *JWTManager) ValidateToken(tokenStr string) (*model.TokenClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &model.TokenClaims{}, func(t *jwt.Token) (interface{}, error) {
		// WithValidMethods below rejects any alg other than HS256 BEFORE this
		// keyfunc runs (parser invariant), so t.Method is always the HMAC
		// HS256 method here — alg-confusion (RS256/none) can never reach us.
		return m.secret, nil
	},
		// Pin to exactly HS256 — blocks alg-confusion to RS256/HS384/512 or
		// alg:none before the keyfunc runs — and make `exp` mandatory so a
		// token minted without an expiry can never validate.
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithExpirationRequired(),
		jwt.WithIssuer(jwtIssuer), jwt.WithAudience(jwtAudience))
	if err != nil {
		return nil, fmt.Errorf("invalid token: %w", err)
	}

	// Library invariant: a nil error from ParseWithClaims implies token.Valid
	// is set, and token.Claims is always the *model.TokenClaims passed in —
	// the direct type assertion cannot fail.
	return token.Claims.(*model.TokenClaims), nil
}
