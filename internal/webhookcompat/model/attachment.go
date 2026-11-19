// Package model (directory webhookcompat/model) is a frozen copy of the
// attachment types of main's classic webhook payload; see the parent
// package. Never edit these types.
package model

// MessageAttachment is main's attachment, field for field (no blocks).
type MessageAttachment struct {
	Fallback    string                   `json:"fallback,omitempty"`
	Color       string                   `json:"color,omitempty"`
	Pretext     string                   `json:"pretext,omitempty"`
	Text        string                   `json:"text,omitempty"`
	AuthorName  string                   `json:"author_name,omitempty"`
	AuthorLink  string                   `json:"author_link,omitempty"`
	AuthorIcon  string                   `json:"author_icon,omitempty"`
	Title       string                   `json:"title,omitempty"`
	TitleLink   string                   `json:"title_link,omitempty"`
	Fields      []MessageAttachmentField `json:"fields,omitempty"`
	ImageURL    string                   `json:"image_url,omitempty"`
	ImageWidth  int                      `json:"image_width,omitempty"`
	ImageHeight int                      `json:"image_height,omitempty"`
	ThumbURL    string                   `json:"thumb_url,omitempty"`
	Footer      string                   `json:"footer,omitempty"`
	FooterIcon  string                   `json:"footer_icon,omitempty"`
}

// MessageAttachmentField is main's attachment field.
type MessageAttachmentField struct {
	Title string `json:"title,omitempty"`
	Value string `json:"value,omitempty"`
	Short bool   `json:"short,omitempty"`
}
