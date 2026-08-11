package model

import "time"

type SystemRole string

const (
	SystemRoleAdmin  SystemRole = "admin"
	SystemRoleMember SystemRole = "member"
	SystemRoleGuest  SystemRole = "guest"
)

// AuthProvider records how a user authenticates. It is authoritative for
// "is this user managed by an external IdP?" — OIDC users have their display
// name owned by the IdP and cannot rename themselves locally.
type AuthProvider string

const (
	AuthProviderOIDC  AuthProvider = "oidc"
	AuthProviderGuest AuthProvider = "guest"
	// AuthProviderBot marks a bot account: a real user row that authenticates
	// with a bot API token instead of a session JWT, so it can hold channel
	// memberships and author messages like any other member.
	AuthProviderBot AuthProvider = "bot"
)

type User struct {
	ID            string       `json:"id" dynamodbav:"id"`
	Email         string       `json:"email" dynamodbav:"email"`
	DisplayName   string       `json:"displayName" dynamodbav:"displayName"`
	AvatarKey     string       `json:"-" dynamodbav:"avatarKey,omitempty"` // S3 object key (persistent)
	AvatarURL     string       `json:"avatarURL,omitempty" dynamodbav:"-"` // presigned URL, regenerated on each fetch
	SystemRole    SystemRole   `json:"systemRole" dynamodbav:"systemRole"`
	AuthProvider  AuthProvider `json:"authProvider,omitempty" dynamodbav:"authProvider,omitempty"`
	PasswordHash  string       `json:"-" dynamodbav:"passwordHash,omitempty"`
	EmojiSkinTone string       `json:"emojiSkinTone,omitempty" dynamodbav:"emojiSkinTone,omitempty"`
	UserStatus    *UserStatus  `json:"userStatus,omitempty" dynamodbav:"userStatus,omitempty"`
	TimeZone      string       `json:"timeZone,omitempty" dynamodbav:"timeZone,omitempty"`
	// NotificationSettings is the user's account-level notification baseline
	// (desktop/mobile levels, thread replies, group mentions, follow-all, and
	// the global keyword list). Nil means the user has never customised it and
	// DefaultNotificationSettings applies.
	NotificationSettings *NotificationSettings `json:"notificationSettings,omitempty" dynamodbav:"notificationSettings,omitempty"`
	Status               string                `json:"status" dynamodbav:"status"` // "active", "deactivated"
	LastSeenAt           *time.Time            `json:"lastSeenAt,omitempty" dynamodbav:"lastSeenAt,omitempty"`
	CreatedAt            time.Time             `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt            time.Time             `json:"updatedAt" dynamodbav:"updatedAt"`

	// Phone and Manager are directory attributes synced from Microsoft 365
	// at SSO login when the Graph integration is enabled. They are owned by
	// the directory (read-only in the app) and shown on profile surfaces.
	Phone   string       `json:"phone,omitempty" dynamodbav:"phone,omitempty"`
	Manager *UserManager `json:"manager,omitempty" dynamodbav:"manager,omitempty"`

	// MSObjectID is the user's Azure AD directory object id (the verified
	// `oid` ID-token claim), captured at login so Graph lookups don't depend
	// on email == userPrincipalName. Internal only — never serialized to
	// clients.
	MSObjectID string `json:"-" dynamodbav:"msObjectID,omitempty"`
}

// UserManager is a lightweight reference to a user's manager from the
// employee directory. UserID is set when the manager is also an Ex user
// (matched by email) so clients can link to their profile.
type UserManager struct {
	DisplayName string `json:"displayName" dynamodbav:"displayName"`
	Email       string `json:"email,omitempty" dynamodbav:"email,omitempty"`
	UserID      string `json:"userID,omitempty" dynamodbav:"userID,omitempty"`
}

// Equal reports whether two manager references carry the same directory data.
// Used to decide whether a login-time directory sync actually changed the
// profile (and therefore whether to broadcast user.updated).
func (m *UserManager) Equal(other *UserManager) bool {
	if m == nil || other == nil {
		return m == other
	}
	return *m == *other
}

// IsBot reports whether this user is a bot account, so callers don't have to
// hardcode the AuthProvider string.
func (u *User) IsBot() bool { return u != nil && u.AuthProvider == AuthProviderBot }

type UserStatus struct {
	Emoji   string     `json:"emoji" dynamodbav:"emoji"`
	Text    string     `json:"text" dynamodbav:"text"`
	ClearAt *time.Time `json:"clearAt,omitempty" dynamodbav:"clearAt,omitempty"`
}
