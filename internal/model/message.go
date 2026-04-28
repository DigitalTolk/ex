package model

import "time"

type Message struct {
	ID              string              `json:"id" dynamodbav:"id"`
	ParentID        string              `json:"parentID" dynamodbav:"parentID"` // channel or conversation ID
	AuthorID        string              `json:"authorID" dynamodbav:"authorID"`
	Body            string              `json:"body" dynamodbav:"body"`
	System          bool                `json:"system,omitempty" dynamodbav:"system,omitempty"`
	ParentMessageID string              `json:"parentMessageID,omitempty" dynamodbav:"parentMessageID,omitempty"` // root message of the thread
	ReplyCount      int                 `json:"replyCount,omitempty" dynamodbav:"replyCount,omitempty"`           // count of replies (only set on root messages)
	LastReplyAt     *time.Time          `json:"lastReplyAt,omitempty" dynamodbav:"lastReplyAt,omitempty"`         // timestamp of the latest reply (only set on root messages)
	// RecentReplyAuthorIDs holds up to 3 most-recent distinct author IDs
	// for the thread, newest first. Used by the client to render an
	// avatar stack on the thread-action bar without re-fetching the full
	// thread. Only set on root messages.
	RecentReplyAuthorIDs []string `json:"recentReplyAuthorIDs,omitempty" dynamodbav:"recentReplyAuthorIDs,omitempty"`
	Reactions       map[string][]string `json:"reactions,omitempty" dynamodbav:"reactions,omitempty"`             // emoji -> userIDs that reacted
	AttachmentIDs   []string            `json:"attachmentIDs,omitempty" dynamodbav:"attachmentIDs,omitempty"`     // ordered list of attachments referenced by this message
	Pinned          bool                `json:"pinned,omitempty" dynamodbav:"pinned,omitempty"`                   // pinned to the parent (channel/conversation)
	PinnedAt        *time.Time          `json:"pinnedAt,omitempty" dynamodbav:"pinnedAt,omitempty"`
	PinnedBy        string              `json:"pinnedBy,omitempty" dynamodbav:"pinnedBy,omitempty"`
	CreatedAt       time.Time           `json:"createdAt" dynamodbav:"createdAt"`
	EditedAt        *time.Time          `json:"editedAt,omitempty" dynamodbav:"editedAt,omitempty"`
	// Deleted is set on soft-delete: the row stays in the list so the
	// thread structure (replies referencing this ID) is preserved, but
	// Body / AttachmentIDs / Reactions are cleared and the client
	// renders a "(Message deleted)" placeholder.
	Deleted bool `json:"deleted,omitempty" dynamodbav:"deleted,omitempty"`
	// NoUnfurl suppresses the link-preview card the client would
	// otherwise render below the body. Set when the author dismisses
	// the unfurl — the suppression is global (every viewer sees it
	// off), which is what authors expect when the preview is wrong.
	NoUnfurl bool `json:"noUnfurl,omitempty" dynamodbav:"noUnfurl,omitempty"`
}
