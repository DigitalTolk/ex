package model

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Token scopes. An empty Scope is an ordinary interactive session token.
// Scoped tokens are accepted ONLY by their dedicated middleware — the
// regular Auth middleware rejects them, so a leaked runner or run token can
// never drive the interactive API.
const (
	TokenScopeRunner = "runner" // desktop runner: register/claim/heartbeat/report
	TokenScopeRun    = "run"    // one run's MCP tool calls, invoker-scoped
)

type TokenClaims struct {
	jwt.RegisteredClaims
	UserID      string     `json:"uid"`
	Email       string     `json:"email"`
	DisplayName string     `json:"name"`
	SystemRole  SystemRole `json:"role"`

	// Scope marks non-interactive tokens (see TokenScope*). Empty = session.
	Scope string `json:"scope,omitempty"`
	// RunID binds a run-scoped token to exactly one run.
	RunID string `json:"runID,omitempty"`
	// ActorID is the agent user a run-scoped token posts as. UserID stays
	// the invoker — permissions are always the invoking human's; ActorID is
	// authorship only.
	ActorID string `json:"actorID,omitempty"`
}

type RefreshToken struct {
	TokenHash string    `json:"tokenHash" dynamodbav:"tokenHash"`
	UserID    string    `json:"userID" dynamodbav:"userID"`
	ExpiresAt time.Time `json:"expiresAt" dynamodbav:"expiresAt"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
	// RotatedAt marks the moment this token was used and superseded by a
	// successor. A rotated token is NOT deleted: the Set-Cookie carrying its
	// successor rides exactly one HTTP response, and on mobile networks that
	// response is regularly lost — the client then legitimately retries with
	// the only token it ever received. Deleting on rotation turned every
	// lost response into a forced re-login (see AuthService.RefreshAccessToken
	// for the reuse rules that keep rotation's replay protection intact).
	RotatedAt *time.Time `json:"rotatedAt,omitempty" dynamodbav:"rotatedAt,omitempty"`
	// SupersededBy is the hash of the successor issued when this token was
	// rotated. Reuse of a rotated token is allowed ONLY while that successor
	// is itself unused — a lost response means the successor's raw value was
	// destroyed with it, so nobody can ever present it.
	SupersededBy string `json:"supersededBy,omitempty" dynamodbav:"supersededBy,omitempty"`
}
