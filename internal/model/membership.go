package model

import "time"

// ChannelMembership represents a user's membership in a channel (stored on channel side).
type ChannelMembership struct {
	ChannelID   string      `json:"channelID" dynamodbav:"channelID"`
	UserID      string      `json:"userID" dynamodbav:"userID"`
	Role        ChannelRole `json:"role" dynamodbav:"role"`
	DisplayName string      `json:"displayName" dynamodbav:"displayName"` // denormalized
	JoinedAt    time.Time   `json:"joinedAt" dynamodbav:"joinedAt"`
}

// UserChannel represents a channel from the user's perspective (stored on user side).
type UserChannel struct {
	UserID        string      `json:"userID" dynamodbav:"userID"`
	ChannelID     string      `json:"channelID" dynamodbav:"channelID"`
	ChannelName   string      `json:"channelName" dynamodbav:"channelName"`
	ChannelType   ChannelType `json:"channelType" dynamodbav:"channelType"`
	Role          ChannelRole `json:"role" dynamodbav:"role"`
	JoinedAt      time.Time   `json:"joinedAt" dynamodbav:"joinedAt"`
	LastReadMsgID string      `json:"lastReadMsgID,omitempty" dynamodbav:"lastReadMsgID,omitempty"`
	// Muted suppresses notifications (sound + browser popup) for this
	// channel without unsubscribing the user. Real-time event delivery is
	// unaffected; only the notifier respects this flag.
	Muted bool `json:"muted,omitempty" dynamodbav:"muted,omitempty"`
	// Favorite pins the channel to the "Favorites" sidebar section. Per
	// user — flipping it here doesn't affect anyone else's view.
	Favorite bool `json:"favorite,omitempty" dynamodbav:"favorite,omitempty"`
	// CategoryID assigns the channel to a user-defined sidebar category;
	// empty string means "no category" (lands under the default "Other"
	// section). The category record itself lives in UserChannelCategory.
	CategoryID string `json:"categoryID,omitempty" dynamodbav:"categoryID,omitempty"`
	// SidebarPosition is a sparse per-user ordering key inside the
	// channel's current sidebar bucket.
	SidebarPosition int `json:"sidebarPosition,omitempty" dynamodbav:"sidebarPosition,omitempty"`
}

// UserChannelCategory is a user-defined grouping for the sidebar. Users
// with 100+ channels create categories like "Engineering" or "Customer
// support" and assign channels to them so the sidebar stays navigable.
// Categories are per-user — there's no shared workspace concept.
type UserChannelCategory struct {
	UserID    string    `json:"userID" dynamodbav:"userID"`
	ID        string    `json:"id" dynamodbav:"id"`
	Name      string    `json:"name" dynamodbav:"name"`
	Position  int       `json:"position" dynamodbav:"position"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
}

// UserConversation represents a conversation from the user's perspective.
type UserConversation struct {
	UserID         string           `json:"userID" dynamodbav:"userID"`
	ConversationID string           `json:"conversationID" dynamodbav:"conversationID"`
	Type           ConversationType `json:"type" dynamodbav:"type"`
	DisplayName    string           `json:"displayName" dynamodbav:"displayName"` // other user's name for DM, group name for group
	ParticipantIDs []string         `json:"participantIDs" dynamodbav:"participantIDs"`
	CreatedBy      string           `json:"createdBy,omitempty" dynamodbav:"createdBy,omitempty"`
	Activated      bool             `json:"activated" dynamodbav:"activated"`
	JoinedAt       time.Time        `json:"joinedAt" dynamodbav:"joinedAt"`
	UpdatedAt      time.Time        `json:"updatedAt,omitempty" dynamodbav:"updatedAt,omitempty"`
	LastReadMsgID  string           `json:"lastReadMsgID,omitempty" dynamodbav:"lastReadMsgID,omitempty"`
	// Favorite pins this DM/group to the user's "Favorites" sidebar
	// section. Same per-user semantics as on UserChannel.
	Favorite bool `json:"favorite,omitempty" dynamodbav:"favorite,omitempty"`
	// CategoryID assigns this DM/group to one of the user's sidebar
	// categories. The same SidebarCategory namespace holds both channels
	// and conversations so a category like "Engineering" can hold both
	// #eng-channel and a DM with the team lead.
	CategoryID string `json:"categoryID,omitempty" dynamodbav:"categoryID,omitempty"`
	// SidebarPosition is a sparse per-user ordering key inside the
	// conversation's current sidebar bucket.
	SidebarPosition int `json:"sidebarPosition,omitempty" dynamodbav:"sidebarPosition,omitempty"`
}
