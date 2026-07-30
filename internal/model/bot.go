package model

import (
	"strings"
	"time"
)

// BotTokenPrefix marks a bearer credential as a bot API token rather than a
// session JWT. The auth middleware routes on this prefix, which is safe because
// a JWT always begins "eyJ" (the base64url of `{"`). External integrations may
// pattern-match on it, so it is permanent API surface.
const BotTokenPrefix = "exbot_"

// BotUserIDPrefix namespaces bot user IDs. It keeps a bot's ID visually
// distinct from a human's bare ULID in logs and message authorship, and it
// guarantees a bot can never collide with the non-User sentinel author IDs
// ("webhook", "cliffy") that predate bot accounts.
const BotUserIDPrefix = "bot_"

// IsBotUserID reports whether an author/user ID belongs to a bot account.
// Callers that only hold an ID (message authorship, mention handling) use this
// instead of loading the User row.
func IsBotUserID(id string) bool { return strings.HasPrefix(id, BotUserIDPrefix) }

// BotAccount is the admin-facing metadata for a bot identity. The bot's actual
// identity — what makes it a channel member, a message author, and a mention
// target — is a real User row whose ID equals UserID here; this record only
// carries the fields a human user has no use for.
type BotAccount struct {
	UserID      string    `json:"userID" dynamodbav:"userID"`
	Name        string    `json:"name" dynamodbav:"name"`
	Description string    `json:"description,omitempty" dynamodbav:"description,omitempty"`
	CreatedBy   string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt   time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
	// Outgoing-webhook transport: when CallbackURL is set, this is an EXTERNAL
	// bot — ex POSTs each @mention/command event to CallbackURL (HMAC-signed with
	// CallbackSecret) and posts the response back. Empty → in-process/none.
	CallbackURL    string `json:"callbackURL,omitempty" dynamodbav:"callbackURL,omitempty"`
	CallbackSecret string `json:"-" dynamodbav:"callbackSecret,omitempty"` // never serialized to clients
}

// BotToken is a revocable bearer credential for a BotAccount. Only the SHA-256
// hash of the secret is persisted (TokenHash, never serialized): the plaintext
// is returned once at issuance and is unrecoverable afterwards, so a leaked
// database dump can't be replayed against the API.
type BotToken struct {
	TokenHash string `json:"-" dynamodbav:"tokenHash"`
	// TokenID is the admin-visible handle used to revoke this token, so the UI
	// never has to hold (or display) the hash.
	TokenID    string     `json:"tokenID" dynamodbav:"tokenID"`
	BotUserID  string     `json:"botUserID" dynamodbav:"botUserID"`
	Label      string     `json:"label,omitempty" dynamodbav:"label,omitempty"`
	CreatedAt  time.Time  `json:"createdAt" dynamodbav:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty" dynamodbav:"lastUsedAt,omitempty"`
	RevokedAt  *time.Time `json:"revokedAt,omitempty" dynamodbav:"revokedAt,omitempty"`
}

// Revoked reports whether this token has been revoked and must no longer
// authenticate a request.
func (t *BotToken) Revoked() bool { return t != nil && t.RevokedAt != nil }
