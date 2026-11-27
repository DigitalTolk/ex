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
	// OhmagifAPIKey, when non-empty, turns on the GIF picker in the
	// composer. The picker asks ohmagif.com directly, so this key goes to
	// every signed-in client; ohmagif refuses it on any site the key does
	// not list. GIFs in messages need no key: they show from their files'
	// lasting addresses.
	OhmagifAPIKey string `json:"ohmagifAPIKey,omitempty" dynamodbav:"ohmagifAPIKey,omitempty"`
	// RunnersInApp turns on the Runners tab in the AI hub, where people set
	// up, start and disconnect ex-runner (the desktop app can install and run
	// it for them). Off by default: until an admin turns it on, runners are
	// set up from the command line and the account menu's Runners dialog.
	RunnersInApp bool `json:"runnersInApp" dynamodbav:"runnersInApp"`
	// AgentModels are the models agents may run on, per engine: the agents
	// page and the admin panel offer them in a dropdown. Empty means the
	// built-in list (DefaultAgentModels). Changed only through its own admin
	// route, never by a save of the other settings.
	AgentModels []AgentModelOption `json:"agentModels" dynamodbav:"agentModels,omitempty"`
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
