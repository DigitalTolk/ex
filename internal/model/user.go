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
	Status        string       `json:"status" dynamodbav:"status"` // "active", "deactivated"
	LastSeenAt    *time.Time   `json:"lastSeenAt,omitempty" dynamodbav:"lastSeenAt,omitempty"`
	CreatedAt     time.Time    `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt     time.Time    `json:"updatedAt" dynamodbav:"updatedAt"`
}
