package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func testUser() *model.User {
	return &model.User{
		ID:          "user-123",
		Email:       "test@example.com",
		DisplayName: "Test User",
		SystemRole:  model.SystemRoleMember,
	}
}

func TestGenerateAccessToken(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	user := testUser()

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: unexpected error: %v", err)
	}
	if token == "" {
		t.Fatal("GenerateAccessToken returned empty token")
	}

	// JWT has 3 dot-separated parts
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Errorf("expected 3 JWT parts, got %d", len(parts))
	}
}

func TestValidateTokenRoundtrip(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	user := testUser()

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	claims, err := mgr.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken: unexpected error: %v", err)
	}

	if claims.UserID != user.ID {
		t.Errorf("UserID = %q, want %q", claims.UserID, user.ID)
	}
	if claims.Email != user.Email {
		t.Errorf("Email = %q, want %q", claims.Email, user.Email)
	}
	if claims.DisplayName != user.DisplayName {
		t.Errorf("DisplayName = %q, want %q", claims.DisplayName, user.DisplayName)
	}
	if claims.SystemRole != user.SystemRole {
		t.Errorf("SystemRole = %q, want %q", claims.SystemRole, user.SystemRole)
	}
	if claims.Subject != user.ID {
		t.Errorf("Subject = %q, want %q", claims.Subject, user.ID)
	}
}

func TestValidateTokenExpired(t *testing.T) {
	// Use a negative TTL so the token is already expired.
	mgr := NewJWTManager("test-secret", -1*time.Hour, 720*time.Hour)
	user := testUser()

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	_, err = mgr.ValidateToken(token)
	if err == nil {
		t.Fatal("ValidateToken: expected error for expired token, got nil")
	}
}

func TestValidateTokenInvalid(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)

	tests := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"garbage", "not-a-jwt"},
		{"wrong secret", ""},
	}

	// Generate a token with a different secret for the "wrong secret" test.
	otherMgr := NewJWTManager("other-secret", 15*time.Minute, 720*time.Hour)
	wrongToken, _ := otherMgr.GenerateAccessToken(testUser())
	tests[2].token = wrongToken

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := mgr.ValidateToken(tt.token)
			if err == nil {
				t.Errorf("ValidateToken(%q): expected error, got nil", tt.token)
			}
		})
	}
}

func TestGenerateRefreshToken(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)

	raw, hash, err := mgr.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("GenerateRefreshToken: %v", err)
	}

	if raw == "" {
		t.Error("raw token is empty")
	}
	if hash == "" {
		t.Error("hash is empty")
	}

	// Verify hash is deterministic from raw.
	h := sha256.Sum256([]byte(raw))
	expectedHash := base64.RawURLEncoding.EncodeToString(h[:])
	if hash != expectedHash {
		t.Errorf("hash = %q, want %q (sha256 of raw)", hash, expectedHash)
	}

	// Two calls should produce different tokens.
	raw2, hash2, err := mgr.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("GenerateRefreshToken (second call): %v", err)
	}
	if raw == raw2 {
		t.Error("two consecutive raw tokens should differ")
	}
	if hash == hash2 {
		t.Error("two consecutive hashes should differ")
	}
}

func TestRefreshTTL(t *testing.T) {
	ttl := 720 * time.Hour
	mgr := NewJWTManager("secret", 15*time.Minute, ttl)
	if got := mgr.RefreshTTL(); got != ttl {
		t.Errorf("RefreshTTL() = %v, want %v", got, ttl)
	}
}

func TestGenerateAccessToken_AdminRole(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{
		ID:          "admin-1",
		Email:       "admin@example.com",
		DisplayName: "Admin User",
		SystemRole:  model.SystemRoleAdmin,
	}

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	claims, err := mgr.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}

	if claims.SystemRole != model.SystemRoleAdmin {
		t.Errorf("SystemRole = %q, want %q", claims.SystemRole, model.SystemRoleAdmin)
	}
	if claims.Email != "admin@example.com" {
		t.Errorf("Email = %q, want %q", claims.Email, "admin@example.com")
	}
}

func TestGenerateAccessToken_GuestRole(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{
		ID:          "guest-1",
		Email:       "guest@example.com",
		DisplayName: "Guest User",
		SystemRole:  model.SystemRoleGuest,
	}

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	claims, err := mgr.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}

	if claims.SystemRole != model.SystemRoleGuest {
		t.Errorf("SystemRole = %q, want %q", claims.SystemRole, model.SystemRoleGuest)
	}
}

func TestValidateToken_WrongSigningKey(t *testing.T) {
	mgr1 := NewJWTManager("secret-one", 15*time.Minute, 720*time.Hour)
	mgr2 := NewJWTManager("secret-two", 15*time.Minute, 720*time.Hour)

	user := testUser()
	token, err := mgr1.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	_, err = mgr2.ValidateToken(token)
	if err == nil {
		t.Fatal("expected error validating token with wrong key, got nil")
	}
}

func TestValidateToken_ExpiredToken(t *testing.T) {
	mgr := NewJWTManager("test-secret", -5*time.Minute, 720*time.Hour)
	user := testUser()

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	_, err = mgr.ValidateToken(token)
	if err == nil {
		t.Fatal("expected error for expired token, got nil")
	}
	if !strings.Contains(err.Error(), "invalid token") {
		t.Errorf("error = %q, want it to contain 'invalid token'", err.Error())
	}
}

func TestRefreshTTL_DifferentValues(t *testing.T) {
	tests := []time.Duration{
		1 * time.Hour,
		24 * time.Hour,
		720 * time.Hour,
		0,
	}

	for _, ttl := range tests {
		mgr := NewJWTManager("secret", 15*time.Minute, ttl)
		if got := mgr.RefreshTTL(); got != ttl {
			t.Errorf("RefreshTTL() = %v, want %v", got, ttl)
		}
	}
}

func TestValidateToken_TamperedPayload(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	user := testUser()

	token, err := mgr.GenerateAccessToken(user)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	// Tamper with the payload part (middle section of JWT).
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 JWT parts, got %d", len(parts))
	}

	// Modify a character in the payload.
	payload := []byte(parts[1])
	if len(payload) > 5 {
		payload[5] = 'X'
	}
	tampered := parts[0] + "." + string(payload) + "." + parts[2]

	_, err = mgr.ValidateToken(tampered)
	if err == nil {
		t.Fatal("expected error for tampered token, got nil")
	}
}

func TestGenerateRefreshToken_HashDeterminism(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)

	raw, hash, err := mgr.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("GenerateRefreshToken: %v", err)
	}

	// Recompute hash from raw and verify.
	h := sha256.Sum256([]byte(raw))
	recomputed := base64.RawURLEncoding.EncodeToString(h[:])
	if hash != recomputed {
		t.Errorf("hash mismatch: got %q, recomputed %q", hash, recomputed)
	}
}
