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

// BotTransport selects the wire format ex uses to POST an event to an external
// bot's callback URL.
type BotTransport string

const (
	// BotTransportEx is ex's own JSON event, authenticated by an HMAC
	// X-Ex-Signature header. The default for a bot created without an explicit
	// transport, and the only option before MM compatibility landed.
	BotTransportEx BotTransport = "ex"
	// BotTransportMattermost is Mattermost's outgoing-webhook format:
	// form-encoded fields with the shared secret carried as the body's `token`.
	// An unmodified Mattermost outgoing-webhook receiver works against this.
	BotTransportMattermost BotTransport = "mattermost"
)

// Valid reports whether t is a transport ex knows how to speak. The empty
// string is valid and means BotTransportEx.
func (t BotTransport) Valid() bool {
	switch t {
	case "", BotTransportEx, BotTransportMattermost:
		return true
	}
	return false
}

// Normalized resolves the empty string to the default transport, so callers
// never have to special-case an older bot row that predates the field.
func (t BotTransport) Normalized() BotTransport {
	if t == "" {
		return BotTransportEx
	}
	return t
}

// BotTriggerWhen selects where a trigger word must appear in a message for the
// bot to fire. It mirrors Mattermost's `trigger_when` on outgoing webhooks.
type BotTriggerWhen int

const (
	// BotTriggerWhenStartsWith fires only when the message *begins* with the
	// trigger word. Mattermost's default, and ex's.
	BotTriggerWhenStartsWith BotTriggerWhen = 0
	// BotTriggerWhenContains fires when the trigger word appears anywhere in the
	// message as a standalone word.
	BotTriggerWhenContains BotTriggerWhen = 1
)

// BotAccount is the admin-facing metadata for a bot identity. The bot's actual
// identity — what makes it a channel member, a message author, and a mention
// target — is a real User row whose ID equals UserID here; this record only
// carries the fields a human user has no use for.
type BotAccount struct {
	UserID      string    `json:"user_id" dynamodbav:"userID"`
	Name        string    `json:"name" dynamodbav:"name"`
	Description string    `json:"description,omitempty" dynamodbav:"description,omitempty"`
	CreatedBy   string    `json:"created_by" dynamodbav:"createdBy"`
	CreatedAt   time.Time `json:"create_at" dynamodbav:"createdAt"`
	UpdatedAt   time.Time `json:"update_at" dynamodbav:"updatedAt"`
	// Outgoing-webhook transport: when CallbackURL is set, this is an EXTERNAL
	// bot — ex POSTs each @mention/trigger-word event to CallbackURL and posts
	// the response back. Empty → in-process/none.
	CallbackURL string `json:"callback_url,omitempty" dynamodbav:"callbackURL,omitempty"`
	// CallbackSecret authenticates the event to the receiver. Under
	// BotTransportEx it is the HMAC key for X-Ex-Signature; under
	// BotTransportMattermost it is the literal `token` field in the form body,
	// which is what an MM receiver compares against its configured token.
	CallbackSecret string `json:"-" dynamodbav:"callbackSecret,omitempty"` // never serialized to clients
	// Transport is the wire format for CallbackURL. Empty means BotTransportEx.
	Transport BotTransport `json:"transport,omitempty" dynamodbav:"transport,omitempty"`
	// TriggerWords fire the bot on a message that is not an @mention — MM's
	// outgoing-webhook trigger model, which is how most existing MM bots are
	// invoked. Matched case-insensitively as whole words.
	TriggerWords []string `json:"trigger_words,omitempty" dynamodbav:"triggerWords,omitempty"`
	// TriggerWhen selects start-of-message (default) vs anywhere matching.
	TriggerWhen BotTriggerWhen `json:"trigger_when,omitempty" dynamodbav:"triggerWhen,omitempty"`
}

// BotToken is a revocable bearer credential for a BotAccount. Only the SHA-256
// hash of the secret is persisted (TokenHash, never serialized): the plaintext
// is returned once at issuance and is unrecoverable afterwards, so a leaked
// database dump can't be replayed against the API.
type BotToken struct {
	TokenHash string `json:"-" dynamodbav:"tokenHash"`
	// TokenID is the admin-visible handle used to revoke this token, so the UI
	// never has to hold (or display) the hash.
	TokenID    string     `json:"token_id" dynamodbav:"tokenID"`
	BotUserID  string     `json:"bot_user_id" dynamodbav:"botUserID"`
	Label      string     `json:"label,omitempty" dynamodbav:"label,omitempty"`
	CreatedAt  time.Time  `json:"create_at" dynamodbav:"createdAt"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty" dynamodbav:"lastUsedAt,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty" dynamodbav:"revokedAt,omitempty"`
}

// Revoked reports whether this token has been revoked and must no longer
// authenticate a request.
func (t *BotToken) Revoked() bool { return t != nil && t.RevokedAt != nil }
