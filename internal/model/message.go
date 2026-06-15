package model

import "time"

type Message struct {
	ID              string     `json:"id" dynamodbav:"id"`
	ParentID        string     `json:"parentID" dynamodbav:"parentID"` // channel or conversation ID
	ParentType      string     `json:"parentType,omitempty" dynamodbav:"-"`
	AuthorID        string     `json:"authorID" dynamodbav:"authorID"`
	Body            string     `json:"body" dynamodbav:"body"`
	System          bool       `json:"system,omitempty" dynamodbav:"system,omitempty"`
	ParentMessageID string     `json:"parentMessageID,omitempty" dynamodbav:"parentMessageID,omitempty"` // root message of the thread
	ReplyCount      int        `json:"replyCount,omitempty" dynamodbav:"replyCount,omitempty"`           // count of replies (only set on root messages)
	LastReplyAt     *time.Time `json:"lastReplyAt,omitempty" dynamodbav:"lastReplyAt,omitempty"`         // timestamp of the latest reply (only set on root messages)
	// RecentReplyAuthorIDs holds up to 3 most-recent distinct author IDs
	// for the thread, newest first. Used by the client to render an
	// avatar stack on the thread-action bar without re-fetching the full
	// thread. Only set on root messages.
	RecentReplyAuthorIDs []string            `json:"recentReplyAuthorIDs,omitempty" dynamodbav:"recentReplyAuthorIDs,omitempty"`
	Reactions            map[string][]string `json:"reactions,omitempty" dynamodbav:"reactions,omitempty"`         // emoji -> userIDs that reacted
	AttachmentIDs        []string            `json:"attachmentIDs,omitempty" dynamodbav:"attachmentIDs,omitempty"` // ordered list of attachments referenced by this message
	Pinned               bool                `json:"pinned,omitempty" dynamodbav:"pinned,omitempty"`               // pinned to the parent (channel/conversation)
	PinnedAt             *time.Time          `json:"pinnedAt,omitempty" dynamodbav:"pinnedAt,omitempty"`
	PinnedBy             string              `json:"pinnedBy,omitempty" dynamodbav:"pinnedBy,omitempty"`
	CreatedAt            time.Time           `json:"createdAt" dynamodbav:"createdAt"`
	EditedAt             *time.Time          `json:"editedAt,omitempty" dynamodbav:"editedAt,omitempty"`
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
	// Rendered is the server-rendered hast tree for Body — populated
	// at read time, never persisted (the `dynamodbav:"-"` tag keeps
	// it out of DDB). Frontend consumers prefer this over re-parsing
	// the markdown source per render. nil means "not yet rendered"
	// (legacy messages, intermediate API paths) — clients fall back
	// to client-side parsing.
	Rendered *HastNode `json:"rendered,omitempty" dynamodbav:"-"`
	// Incoming webhook messages can override the displayed author and carry
	// Mattermost-compatible message attachments. AuthorID remains a stable
	// bot identifier for notifications/search, while these fields drive rendering.
	WebhookUsername    string              `json:"webhookUsername,omitempty" dynamodbav:"webhookUsername,omitempty"`
	WebhookAvatarURL   string              `json:"webhookAvatarURL,omitempty" dynamodbav:"webhookAvatarURL,omitempty"`
	WebhookIconEmoji   string              `json:"webhookIconEmoji,omitempty" dynamodbav:"webhookIconEmoji,omitempty"` // emoji name (no colons) from icon_emoji; rendered as the avatar
	MessageAttachments []MessageAttachment `json:"messageAttachments,omitempty" dynamodbav:"messageAttachments,omitempty"`
}

type MessageAttachment struct {
	Fallback   string                   `json:"fallback,omitempty" dynamodbav:"fallback,omitempty"`
	Color      string                   `json:"color,omitempty" dynamodbav:"color,omitempty"`
	Pretext    string                   `json:"pretext,omitempty" dynamodbav:"pretext,omitempty"`
	Text       string                   `json:"text,omitempty" dynamodbav:"text,omitempty"`
	AuthorName string                   `json:"author_name,omitempty" dynamodbav:"authorName,omitempty"`
	AuthorLink string                   `json:"author_link,omitempty" dynamodbav:"authorLink,omitempty"`
	AuthorIcon string                   `json:"author_icon,omitempty" dynamodbav:"authorIcon,omitempty"`
	Title      string                   `json:"title,omitempty" dynamodbav:"title,omitempty"`
	TitleLink  string                   `json:"title_link,omitempty" dynamodbav:"titleLink,omitempty"`
	Fields     []MessageAttachmentField `json:"fields,omitempty" dynamodbav:"fields,omitempty"`
	ImageURL   string                   `json:"image_url,omitempty" dynamodbav:"imageURL,omitempty"`
	// ImageWidth/ImageHeight are the intrinsic pixel dimensions of the
	// S3-cached image_url, captured server-side at send time so the
	// client can render <img width height> and avoid layout shift in the
	// virtualised message list. Not part of the inbound webhook payload.
	ImageWidth  int    `json:"image_width,omitempty" dynamodbav:"imageWidth,omitempty"`
	ImageHeight int    `json:"image_height,omitempty" dynamodbav:"imageHeight,omitempty"`
	ThumbURL    string `json:"thumb_url,omitempty" dynamodbav:"thumbURL,omitempty"`
	Footer      string `json:"footer,omitempty" dynamodbav:"footer,omitempty"`
	FooterIcon  string `json:"footer_icon,omitempty" dynamodbav:"footerIcon,omitempty"`
}

type MessageAttachmentField struct {
	Title string `json:"title,omitempty" dynamodbav:"title,omitempty"`
	Value string `json:"value,omitempty" dynamodbav:"value,omitempty"`
	Short bool   `json:"short,omitempty" dynamodbav:"short,omitempty"`
}
