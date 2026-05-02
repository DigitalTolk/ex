package model

// WorkspaceSettings holds workspace-wide knobs an admin controls. The
// document is keyed in the single-table store under a fixed PK/SK so
// there's exactly one record. Settings are read on every upload, so
// callers should rely on the cache layer.
type WorkspaceSettings struct {
	// MaxUploadBytes is the maximum file size accepted by the
	// attachment-upload endpoint. 0 means "use the built-in default".
	MaxUploadBytes int64 `json:"maxUploadBytes" dynamodbav:"maxUploadBytes"`
	// AllowedExtensions is a lowercase list (without the leading dot)
	// of file extensions that may be uploaded. Empty list means "use
	// the built-in default".
	AllowedExtensions []string `json:"allowedExtensions" dynamodbav:"allowedExtensions"`
	// GiphyAPIKey, when non-empty, enables the Giphy picker in the
	// composer. Stored verbatim and proxied server-side — never sent
	// to non-admin clients.
	GiphyAPIKey string `json:"giphyAPIKey,omitempty" dynamodbav:"giphyAPIKey,omitempty"`
}

// DefaultMaxUploadBytes is the fallback ceiling when the workspace hasn't
// overridden it (50 MiB).
const DefaultMaxUploadBytes int64 = 50 * 1024 * 1024

// DefaultAllowedExtensions is the conservative ship-with default — common
// document, image, and archive formats. Admins can broaden or narrow it.
var DefaultAllowedExtensions = []string{
	"png", "jpg", "jpeg", "gif", "webp", "svg",
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	"txt", "md", "csv", "log",
	"zip", "tar", "gz",
	"mp4", "mov", "webm",
	"mp3", "wav", "ogg",
}
