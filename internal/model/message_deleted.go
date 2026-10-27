package model

// DeletedContent is what a soft-deleted message said: kept in its row,
// never served. It lives in its own file so tygo leaves it out of the wire
// types: no client ever sees it.
type DeletedContent struct {
	Body               string              `json:"-" dynamodbav:"body,omitempty"`
	AttachmentIDs      []string            `json:"-" dynamodbav:"attachmentIDs,omitempty"`
	MessageAttachments []MessageAttachment `json:"-" dynamodbav:"messageAttachments,omitempty"`
}
