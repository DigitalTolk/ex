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
	if _, err = rand.Read(b); err != nil {
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
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, fmt.Errorf("invalid token: %w", err)
	}

	claims, ok := token.Claims.(*model.TokenClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}
	return claims, nil
}
