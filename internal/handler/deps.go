package handler

import (
	"io/fs"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// Deps is the single set of dependencies the HTTP router needs to wire
// up the API surface. Bundling them into a struct (instead of a long
// positional parameter list on NewRouter) means adding a new endpoint
// only requires adding a field here — not editing every call-site or
// rotating positional args.
//
// Optional handlers (Search, Sidebar, Unfurl, …) may be left nil; the
// router skips their route registrations. The required core (Auth,
// User, Channel, Conversation, WS, JWT) is asserted in NewRouter.
type Deps struct {
	// Required core.
	Auth         *AuthHandler
	User         *UserHandler
	Channel      *ChannelHandler
	Conversation *ConversationHandler
	WS           *WSHandler
	JWT          *auth.JWTManager

	// Optional resource handlers — nil disables the corresponding routes.
	UserState  *UserStateHandler
	Upload     *UploadHandler
	Emoji      *EmojiHandler
	Presence   *PresenceHandler
	Attachment *AttachmentHandler
	Admin      *AdminHandler
	Thread     *ThreadHandler
	Draft      *DraftHandler
	Version    *VersionHandler
	Unfurl     *UnfurlHandler
	Sidebar    *SidebarHandler
	Search     *SearchHandler
	Webhook    *WebhookHandler
	Activity   *ActivityHandler

	// SPA/static.
	FrontendFS fs.FS
	AppVersion string

	// CORS / cross-origin policy. The first non-empty entry is treated
	// as the canonical primary origin in the middleware.
	AllowOrigins []string

	// RateLimiter throttles unauthenticated auth + webhook endpoints per client
	// IP. Nil disables rate limiting (e.g. in tests).
	RateLimiter middleware.RateLimitCounter
}
