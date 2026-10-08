package model

import "time"

type UserStateKind string

const (
	UserStateThreadNotification UserStateKind = "thread_notification"
	UserStateThreadSeen         UserStateKind = "thread_seen"
	UserStateHiddenConversation UserStateKind = "hidden_conversation"
	// UserStateHiddenSkill removes one skill from the "# Workspace skills"
	// discovery index of THIS user's agent runs — a per-user curation knob so
	// a workspace full of skills stays legible. An explicit /skill pick still
	// attaches a hidden skill: hiding is about discovery, not permission.
	UserStateHiddenSkill UserStateKind = "hidden_skill"
)

type UserStateItem struct {
	UserID       string        `json:"userID" dynamodbav:"userID"`
	Kind         UserStateKind `json:"kind" dynamodbav:"kind"`
	TargetID     string        `json:"targetID" dynamodbav:"targetID"`
	ParentID     string        `json:"parentID,omitempty" dynamodbav:"parentID,omitempty"`
	ParentType   string        `json:"parentType,omitempty" dynamodbav:"parentType,omitempty"`
	ThreadRootID string        `json:"threadRootID,omitempty" dynamodbav:"threadRootID,omitempty"`
	SeenAt       *time.Time    `json:"seenAt,omitempty" dynamodbav:"seenAt,omitempty"`
	// Rewound marks a thread_seen row a mark-unread wrote: SeenAt was set back
	// to just before a reply on purpose. An ordinary "seen" write replaces the
	// row without it.
	Rewound   bool      `json:"rewound,omitempty" dynamodbav:"rewound,omitempty"`
	UpdatedAt time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

type UserState struct {
	ThreadNotifications []string          `json:"threadNotifications"`
	ThreadSeen          map[string]string `json:"threadSeen"`
	// ThreadMarkedUnread maps a thread root to WHEN the user marked it unread
	// (its threadSeen entry was rewound to just before a reply). Clients keep
	// the newer of their local and the server's seen time; a rewound entry is
	// older by design, so this tells them a local seen time from before the
	// mark must yield to it.
	ThreadMarkedUnread  map[string]string `json:"threadMarkedUnread"`
	HiddenConversations []string          `json:"hiddenConversations"`
	HiddenSkills        []string          `json:"hiddenSkills"`
}

// MarkUnreadResult is the outcome of marking a message unread. A top-level
// message rewinds the caller's read watermark on its channel/conversation so
// UnreadCount messages (it and everything after it) are unread again; a
// thread reply rewinds the thread's seen time to just before it instead.
type MarkUnreadResult struct {
	ParentID     string     `json:"parentID"`
	ParentType   string     `json:"parentType"`
	MessageID    string     `json:"messageID"`
	UnreadCount  int64      `json:"unreadCount"`
	ThreadRootID string     `json:"threadRootID,omitempty"`
	SeenAt       *time.Time `json:"seenAt,omitempty"`
}
