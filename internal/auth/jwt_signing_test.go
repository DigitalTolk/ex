package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/DigitalTolk/ex/internal/model"
)

// A token signed with a non-HMAC method must be rejected by the keyfunc's
// signing-method guard.
func TestValidateToken_UnexpectedSigningMethod(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, &model.TokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "u1",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	})
	signed, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := mgr.ValidateToken(signed); err == nil {
		t.Fatal("expected rejection of non-HMAC token")
	}
}

func TestValidateToken_Garbage(t *testing.T) {
	mgr := NewJWTManager("test-secret", 15*time.Minute, 720*time.Hour)
	if _, err := mgr.ValidateToken("not.a.jwt"); err == nil {
		t.Fatal("expected error for malformed token")
	}
}
