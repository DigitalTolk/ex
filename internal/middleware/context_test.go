package middleware

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestContextWithClaims(t *testing.T) {
	claims := &model.TokenClaims{UserID: "u1", SystemRole: model.SystemRoleAdmin}
	ctx := ContextWithClaims(context.Background(), claims)
	got := ClaimsFromContext(ctx)
	if got == nil || got.UserID != "u1" {
		t.Fatalf("ClaimsFromContext after ContextWithClaims = %+v", got)
	}
	if id := UserIDFromContext(ctx); id != "u1" {
		t.Errorf("UserIDFromContext = %q, want %q", id, "u1")
	}
}

func TestUserIDFromContext_Empty(t *testing.T) {
	if id := UserIDFromContext(context.Background()); id != "" {
		t.Errorf("UserIDFromContext = %q, want empty", id)
	}
}

func TestClaimsFromContext_Empty(t *testing.T) {
	if c := ClaimsFromContext(context.Background()); c != nil {
		t.Errorf("ClaimsFromContext = %+v, want nil", c)
	}
}
