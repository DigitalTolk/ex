package model

import "time"

// Attachment is a file uploaded to object storage and tracked in DynamoDB so
// messages can reference it by ID. SHA256 dedupes uploads of the same content
// to a single S3 object; MessageIDs is the (Dynamo string-set-backed) refcount
// — when it drops to zero the S3 object and Attachment row are removed.
type Attachment struct {
	ID          string    `json:"id" dynamodbav:"id"`
	SHA256      string    `json:"sha256" dynamodbav:"sha256"`
	Size        int64     `json:"size" dynamodbav:"size"`
	ContentType string    `json:"contentType" dynamodbav:"contentType"`
	Filename    string    `json:"filename" dynamodbav:"filename"`
	S3Key       string    `json:"-" dynamodbav:"s3Key"`
	URL         string    `json:"url,omitempty" dynamodbav:"-"` // resolved at fetch time
	CreatedBy   string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt   time.Time `json:"createdAt" dynamodbav:"createdAt"`
	// MessageIDs is the set of message IDs currently referencing this
	// attachment. Maintained as a Dynamo string set; never serialized to JSON.
	MessageIDs []string `json:"-" dynamodbav:"messageIDs,omitempty,stringset"`
}

// IsImage returns true when the content type starts with "image/".
func (a *Attachment) IsImage() bool {
	if a == nil {
		return false
	}
	return len(a.ContentType) >= 6 && a.ContentType[:6] == "image/"
}
