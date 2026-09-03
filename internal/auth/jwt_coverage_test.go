package auth

import (
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// The runner and run token minters: round-trip through ValidateToken and
// assert the scope/claim wiring the middlewares depend on.
func TestJwtCov_RunnerAndRunTokens(t *testing.T) {
	m := NewJWTManager("test-secret", time.Hour, 24*time.Hour)
	user := &model.User{ID: "u-1", Email: "u1@example.com", DisplayName: "U One", SystemRole: model.SystemRoleMember}

	t.Run("runner token", func(t *testing.T) {
		tok, err := m.GenerateRunnerToken(user, 30*time.Minute)
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		claims, err := m.ValidateToken(tok)
		if err != nil {
			t.Fatalf("validate: %v", err)
		}
		if claims.Scope != model.TokenScopeRunner || claims.UserID != "u-1" || claims.Email != user.Email {
			t.Fatalf("claims mismatch: %+v", claims)
		}
	})

	t.Run("run token", func(t *testing.T) {
		exp := time.Now().Add(10 * time.Minute)
		tok, err := m.GenerateRunToken("run-1", "u-inv", "a-gg", exp)
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		claims, err := m.ValidateToken(tok)
		if err != nil {
			t.Fatalf("validate: %v", err)
		}
		if claims.Scope != model.TokenScopeRun || claims.RunID != "run-1" || claims.ActorID != "a-gg" || claims.UserID != "u-inv" {
			t.Fatalf("claims mismatch: %+v", claims)
		}
		if claims.ExpiresAt == nil || claims.ExpiresAt.Time.Sub(exp).Abs() > time.Second {
			t.Fatalf("expiry not bound to run deadline: %v", claims.ExpiresAt)
		}
	})
}
