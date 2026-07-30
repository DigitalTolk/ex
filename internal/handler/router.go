package handler

import (
	"bytes"
	"html"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
)

// NewRouter builds the application HTTP handler, registering all routes.
// All dependencies are bundled in *Deps — adding a new endpoint only
// requires adding a field to that struct (see deps.go).
//
// Deps.FrontendFS should be the frontend/dist subtree (already
// sub-rooted); pass nil to disable the embedded SPA. Deps.AppVersion
// is the build identifier the SPA embeds in its `<meta
// name="app-version">` tag — main computes it once and forwards the
// same value here to avoid re-hashing index.html.
func NewRouter(d *Deps) http.Handler {
	if d == nil {
		panic("handler.NewRouter: nil Deps")
	}
	authH := d.Auth
	userH := d.User
	userStateH := d.UserState
	channelH := d.Channel
	convH := d.Conversation
	wsH := d.WS
	uploadH := d.Upload
	emojiH := d.Emoji
	presenceH := d.Presence
	attachmentH := d.Attachment
	adminH := d.Admin
	threadH := d.Thread
	draftH := d.Draft
	versionH := d.Version
	unfurlH := d.Unfurl
	sidebarH := d.Sidebar
	searchH := d.Search
	webhookH := d.Webhook
	activityH := d.Activity
	commandH := d.Command
	jwtMgr := d.JWT
	frontendFS := d.FrontendFS
	appVersion := d.AppVersion
	allowOrigins := d.AllowOrigins

	mux := http.NewServeMux()

	// d.BotTokens (when set) additionally accepts bot API tokens on every route
	// below; nil keeps auth JWT-only.
	authMW := middleware.AuthWithBots(jwtMgr, nil, d.BotTokens)
	if userH != nil && userH.userSvc != nil {
		authMW = middleware.AuthWithBots(jwtMgr, userH.userSvc, d.BotTokens)
	}

	// ------------------------------------------------------------------ Health
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, JSON{"status": "ok"})
	})

	// ------------------------------------------------------------------ Version
	// Public — the frontend polls this to detect deploys (the JS bundle
	// pins the version it shipped with; mismatch → reload banner).
	if versionH != nil {
		mux.HandleFunc("GET /api/v1/version", versionH.Get)
	}
	if unfurlH != nil {
		mux.Handle("GET /api/v1/unfurl", middleware.WrapFunc(unfurlH.Get, authMW))
	}
	// Cliffy identity-bridge session probe — only wired when the bridge is
	// configured. Establishes/refreshes the caller's CliffHub session; the
	// token stays server-side.
	if d.Cliffy != nil {
		mux.Handle("POST /api/v1/cliffy/session", middleware.WrapFunc(d.Cliffy.CreateSession, authMW))
		// Streaming proxy to CliffHub's agent — the bridged token is injected
		// server-side; the per-user cost cap lives in the handler.
		mux.Handle("POST /api/v1/cliffy/chat", middleware.WrapFunc(d.Cliffy.Chat, authMW))
		// Write passthrough for approved writeApi calls (token injected server-side).
		mux.Handle("POST /api/v1/cliffy/api", middleware.WrapFunc(d.Cliffy.ProxyAPI, authMW))
		// Share a Cliffy card into the current conversation (both participants see it).
		mux.Handle("POST /api/v1/cliffy/share", middleware.WrapFunc(d.Cliffy.Share, authMW))
		// Revoke the caller's bridged CliffHub session (called on logout).
		mux.Handle("POST /api/v1/cliffy/revoke", middleware.WrapFunc(d.Cliffy.Revoke, authMW))
		// Collective (shared) Cliffy sessions — a Cliffy thread shared with chosen
		// ex users, synced live; the agent runs server-side (read-only).
	}

	// ------------------------------------------------------------------ Auth (public)
	// Throttle the unauthenticated, brute-forceable endpoints per client IP
	// (no-op when d.RateLimiter is nil). Credential/invite/refresh guessing and
	// token churn are the threats; logout and the provider-driven OIDC handshake
	// stay unthrottled.
	authLimit := middleware.RateLimit(d.RateLimiter, 20, time.Minute)
	// Per-user flood guard on write endpoints (message sends + reactions). 120/min
	// is generous for a human but stops a single account from flooding channels
	// and amplifying the notification fan-out. Runs after authMW so the user is
	// known; a nil RateLimiter makes it a no-op.
	writeLimit := middleware.RateLimitPerUser(d.RateLimiter, 120, time.Minute)
	mux.HandleFunc("GET /auth/oidc/login", authH.OIDCLogin)
	mux.HandleFunc("GET /auth/oidc/callback", authH.OIDCCallback)
	mux.HandleFunc("GET /auth/desktop/complete", authH.DesktopComplete)
	mux.Handle("POST /auth/token/refresh", middleware.WrapFunc(authH.RefreshToken, authLimit))
	mux.HandleFunc("POST /auth/logout", authH.Logout)
	mux.Handle("POST /auth/invite/accept", middleware.WrapFunc(authH.AcceptInvite, authLimit))
	mux.Handle("POST /auth/login", middleware.WrapFunc(authH.GuestLogin, authLimit))

	// ------------------------------------------------------------------ Auth (protected)
	mux.Handle("POST /auth/invite", middleware.WrapFunc(authH.CreateInvite, authMW))

	// ------------------------------------------------------------------ Users
	mux.Handle("GET /api/v1/users/me", middleware.WrapFunc(userH.GetMe, authMW))
	mux.Handle("PATCH /api/v1/users/me", middleware.WrapFunc(userH.UpdateMe, authMW))
	mux.Handle("PATCH /api/v1/users/me/status", middleware.WrapFunc(userH.SetMyUserStatus, authMW))
	mux.Handle("DELETE /api/v1/users/me/status", middleware.WrapFunc(userH.ClearMyUserStatus, authMW))
	mux.Handle("PUT /api/v1/users/me/notification-settings", middleware.WrapFunc(userH.SetMyNotificationSettings, authMW))
	mux.Handle("POST /api/v1/users/me/avatar/upload-url", middleware.WrapFunc(userH.CreateAvatarUploadURL, authMW))
	mux.Handle("POST /api/v1/users/batch", middleware.WrapFunc(userH.BatchGetUsers, authMW))
	mux.Handle("GET /api/v1/users/{id}", middleware.WrapFunc(userH.GetUser, authMW))
	mux.Handle("PATCH /api/v1/users/{id}/role", middleware.WrapFunc(userH.UpdateUserRole, authMW))
	mux.Handle("PATCH /api/v1/users/{id}/status", middleware.WrapFunc(userH.SetUserStatus, authMW))
	mux.Handle("GET /api/v1/users", middleware.WrapFunc(userH.ListUsers, authMW))

	if userStateH != nil {
		mux.Handle("GET /api/v1/user-state", middleware.WrapFunc(userStateH.Get, authMW))
		mux.Handle("PUT /api/v1/user-state/threads/{parentType}/{parentID}/{threadRootID}/seen", middleware.WrapFunc(userStateH.MarkThreadSeen, authMW))
		mux.Handle("PUT /api/v1/user-state/conversations/{id}/hidden", middleware.WrapFunc(userStateH.HideConversation, authMW))
		mux.Handle("DELETE /api/v1/user-state/conversations/{id}/hidden", middleware.WrapFunc(userStateH.UnhideConversation, authMW))
	}

	// ------------------------------------------------------------------ Channels
	mux.Handle("POST /api/v1/channels", middleware.WrapFunc(channelH.Create, authMW))
	mux.Handle("GET /api/v1/channels", middleware.WrapFunc(channelH.List, authMW))
	mux.Handle("GET /api/v1/channels/browse", middleware.WrapFunc(channelH.BrowsePublic, authMW))
	mux.Handle("GET /api/v1/channels/{id}", middleware.WrapFunc(channelH.Get, authMW))
	mux.Handle("PATCH /api/v1/channels/{id}", middleware.WrapFunc(channelH.Update, authMW))
	mux.Handle("DELETE /api/v1/channels/{id}", middleware.WrapFunc(channelH.Archive, authMW))

	mux.Handle("POST /api/v1/channels/{id}/join", middleware.WrapFunc(channelH.Join, authMW))
	mux.Handle("POST /api/v1/channels/{id}/leave", middleware.WrapFunc(channelH.Leave, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/read", middleware.WrapFunc(channelH.MarkRead, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/mute", middleware.WrapFunc(channelH.SetMute, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/notification-preferences", middleware.WrapFunc(channelH.SetNotificationPrefs, authMW))

	mux.Handle("GET /api/v1/channels/{id}/members", middleware.WrapFunc(channelH.ListMembers, authMW))
	mux.Handle("POST /api/v1/channels/{id}/members", middleware.WrapFunc(channelH.AddMember, authMW))
	mux.Handle("DELETE /api/v1/channels/{id}/members/{uid}", middleware.WrapFunc(channelH.RemoveMember, authMW))
	mux.Handle("PATCH /api/v1/channels/{id}/members/{uid}", middleware.WrapFunc(channelH.UpdateMemberRole, authMW))

	mux.Handle("GET /api/v1/channels/{id}/messages", middleware.WrapFunc(channelH.ListMessages, authMW))
	mux.Handle("POST /api/v1/channels/{id}/messages", middleware.WrapFunc(channelH.SendMessage, authMW, writeLimit))
	mux.Handle("PATCH /api/v1/channels/{id}/messages/{msgId}", middleware.WrapFunc(channelH.EditMessage, authMW))
	mux.Handle("DELETE /api/v1/channels/{id}/messages/{msgId}", middleware.WrapFunc(channelH.DeleteMessage, authMW))
	mux.Handle("GET /api/v1/channels/{id}/messages/{msgId}/thread", middleware.WrapFunc(channelH.GetThread, authMW))
	mux.Handle("POST /api/v1/channels/{id}/messages/{msgId}/reactions", middleware.WrapFunc(channelH.ToggleReaction, authMW, writeLimit))
	mux.Handle("PUT /api/v1/channels/{id}/messages/{msgId}/pinned", middleware.WrapFunc(channelH.SetPinned, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/messages/{msgId}/no-unfurl", middleware.WrapFunc(channelH.SetNoUnfurl, authMW))
	mux.Handle("GET /api/v1/channels/{id}/pinned", middleware.WrapFunc(channelH.ListPinned, authMW))
	mux.Handle("GET /api/v1/channels/{id}/files", middleware.WrapFunc(channelH.ListFiles, authMW))

	// ------------------------------------------------------------------ Conversations
	mux.Handle("POST /api/v1/conversations", middleware.WrapFunc(convH.Create, authMW))
	mux.Handle("GET /api/v1/conversations", middleware.WrapFunc(convH.List, authMW))
	mux.Handle("GET /api/v1/conversations/{id}", middleware.WrapFunc(convH.Get, authMW))
	mux.Handle("PUT /api/v1/conversations/{id}/read", middleware.WrapFunc(convH.MarkRead, authMW))

	mux.Handle("GET /api/v1/conversations/{id}/messages", middleware.WrapFunc(convH.ListMessages, authMW))
	mux.Handle("POST /api/v1/conversations/{id}/messages", middleware.WrapFunc(convH.SendMessage, authMW, writeLimit))
	mux.Handle("PATCH /api/v1/conversations/{id}/messages/{msgId}", middleware.WrapFunc(convH.EditMessage, authMW))
	mux.Handle("DELETE /api/v1/conversations/{id}/messages/{msgId}", middleware.WrapFunc(convH.DeleteMessage, authMW))
	mux.Handle("GET /api/v1/conversations/{id}/messages/{msgId}/thread", middleware.WrapFunc(convH.GetThread, authMW))
	mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/reactions", middleware.WrapFunc(convH.ToggleReaction, authMW, writeLimit))
	mux.Handle("PUT /api/v1/conversations/{id}/messages/{msgId}/pinned", middleware.WrapFunc(convH.SetPinned, authMW))
	mux.Handle("PUT /api/v1/conversations/{id}/messages/{msgId}/no-unfurl", middleware.WrapFunc(convH.SetNoUnfurl, authMW))
	mux.Handle("GET /api/v1/conversations/{id}/pinned", middleware.WrapFunc(convH.ListPinned, authMW))
	mux.Handle("GET /api/v1/conversations/{id}/files", middleware.WrapFunc(convH.ListFiles, authMW))

	// ------------------------------------------------------------------ Threads (cross-parent)
	if threadH != nil {
		mux.Handle("GET /api/v1/threads", middleware.WrapFunc(threadH.List, authMW))
		mux.Handle("PUT /api/v1/threads/{parentType}/{parentID}/{threadRootID}/follow", middleware.WrapFunc(threadH.Follow, authMW))
		mux.Handle("DELETE /api/v1/threads/{parentType}/{parentID}/{threadRootID}/follow", middleware.WrapFunc(threadH.Unfollow, authMW))
	}

	// ------------------------------------------------------------------ Drafts
	if draftH != nil {
		mux.Handle("GET /api/v1/drafts", middleware.WrapFunc(draftH.List, authMW))
		mux.Handle("PUT /api/v1/drafts", middleware.WrapFunc(draftH.Upsert, authMW))
		mux.Handle("DELETE /api/v1/drafts/{id}", middleware.WrapFunc(draftH.Delete, authMW))
	}

	// ----------------------------------------------------------- Activity + reminders
	if activityH != nil {
		mux.Handle("GET /api/v1/activity", middleware.WrapFunc(activityH.Feed, authMW))
		mux.Handle("PUT /api/v1/activity/read", middleware.WrapFunc(activityH.MarkRead, authMW))
		mux.Handle("POST /api/v1/reminders", middleware.WrapFunc(activityH.CreateReminder, authMW, writeLimit))
		mux.Handle("GET /api/v1/reminders", middleware.WrapFunc(activityH.ListReminders, authMW))
		mux.Handle("DELETE /api/v1/reminders/{id}", middleware.WrapFunc(activityH.CancelReminder, authMW))
	}

	// ------------------------------------------------------------------ Slash commands
	if commandH != nil {
		mux.Handle("GET /api/v1/commands", middleware.WrapFunc(commandH.List, authMW))
		// Runs post messages into chats, so they share the per-user write limit.
		mux.Handle("POST /api/v1/commands/run", middleware.WrapFunc(commandH.Run, authMW, writeLimit))
	}

	// ------------------------------------------------------------------ Sidebar (per-user)
	if sidebarH != nil {
		mux.Handle("PUT /api/v1/channels/{id}/favorite", middleware.WrapFunc(sidebarH.SetFavorite, authMW))
		mux.Handle("PUT /api/v1/channels/{id}/category", middleware.WrapFunc(sidebarH.SetCategory, authMW))
		mux.Handle("PUT /api/v1/conversations/{id}/favorite", middleware.WrapFunc(sidebarH.SetConversationFavorite, authMW))
		mux.Handle("PUT /api/v1/conversations/{id}/category", middleware.WrapFunc(sidebarH.SetConversationCategory, authMW))
		mux.Handle("GET /api/v1/sidebar/categories", middleware.WrapFunc(sidebarH.ListCategories, authMW))
		mux.Handle("POST /api/v1/sidebar/categories", middleware.WrapFunc(sidebarH.CreateCategory, authMW))
		mux.Handle("PATCH /api/v1/sidebar/categories/{id}", middleware.WrapFunc(sidebarH.UpdateCategory, authMW))
		mux.Handle("DELETE /api/v1/sidebar/categories/{id}", middleware.WrapFunc(sidebarH.DeleteCategory, authMW))
		// Event-shaped reorders: the client reports the drop ("X after A");
		// the server owns every resulting position.
		mux.Handle("PUT /api/v1/sidebar/move", middleware.WrapFunc(sidebarH.Move, authMW))
		mux.Handle("PUT /api/v1/sidebar/categories/{id}/move", middleware.WrapFunc(sidebarH.MoveCategory, authMW))
	}

	// ------------------------------------------------------------------ Uploads
	if uploadH != nil {
		mux.Handle("POST /api/v1/uploads/url", middleware.WrapFunc(uploadH.CreateUploadURL, authMW))
	}

	// ------------------------------------------------------------------ Attachments
	if attachmentH != nil {
		mux.HandleFunc("GET /api/v1/media/{token}/{filename...}", attachmentH.Media)
		mux.Handle("POST /api/v1/attachments/url", middleware.WrapFunc(attachmentH.CreateUploadURL, authMW))
		mux.Handle("POST /api/v1/attachments/{id}/process", middleware.WrapFunc(attachmentH.ProcessUpload, authMW))
		mux.Handle("GET /api/v1/attachments", middleware.WrapFunc(attachmentH.List, authMW))
		mux.Handle("GET /api/v1/attachments/{id}", middleware.WrapFunc(attachmentH.Get, authMW))
		mux.Handle("DELETE /api/v1/attachments/{id}", middleware.WrapFunc(attachmentH.Delete, authMW))
	}

	// ------------------------------------------------------------------ Custom emojis
	if emojiH != nil {
		mux.Handle("GET /api/v1/emojis", middleware.WrapFunc(emojiH.List, authMW))
		mux.Handle("POST /api/v1/emojis", middleware.WrapFunc(emojiH.Create, authMW))
		mux.Handle("GET /api/v1/emojis/frequent", middleware.WrapFunc(emojiH.ListFrequent, authMW))
		mux.Handle("POST /api/v1/emojis/frequent", middleware.WrapFunc(emojiH.RecordFrequent, authMW))
		mux.Handle("DELETE /api/v1/emojis/{name}", middleware.WrapFunc(emojiH.Delete, authMW))
	}

	// ------------------------------------------------------------------ Presence
	if presenceH != nil {
		mux.Handle("GET /api/v1/presence", middleware.WrapFunc(presenceH.List, authMW))
	}

	// ------------------------------------------------------------------ Search
	if searchH != nil {
		mux.Handle("GET /api/v1/search/users", middleware.WrapFunc(searchH.SearchUsers, authMW))
		mux.Handle("GET /api/v1/search/channels", middleware.WrapFunc(searchH.SearchChannels, authMW))
		mux.Handle("GET /api/v1/search/messages", middleware.WrapFunc(searchH.SearchMessages, authMW))
		mux.Handle("GET /api/v1/search/files", middleware.WrapFunc(searchH.SearchFiles, authMW))
	}

	// ------------------------------------------------------------------ Admin / settings
	if adminH != nil {
		// GET is open to any authenticated user — the upload UI shows
		// the current limits before posting. PUT enforces admin-only
		// inside the handler.
		mux.Handle("GET /api/v1/admin/settings", middleware.WrapFunc(adminH.GetSettings, authMW))
		mux.Handle("PUT /api/v1/admin/settings", middleware.WrapFunc(adminH.UpdateSettings, authMW))
		mux.Handle("GET /api/v1/admin/search/status", middleware.WrapFunc(adminH.SearchStatus, authMW))
		mux.Handle("POST /api/v1/admin/search/reindex", middleware.WrapFunc(adminH.StartSearchReindex, authMW))
		mux.Handle("POST /api/v1/admin/search/rebuild-mapping", middleware.WrapFunc(adminH.StartSearchMappingRebuild, authMW))
	}
	if webhookH != nil {
		mux.Handle("GET /api/v1/admin/webhooks", middleware.WrapFunc(webhookH.List, authMW))
		mux.Handle("POST /api/v1/admin/webhooks", middleware.WrapFunc(webhookH.Create, authMW))
		mux.Handle("PATCH /api/v1/admin/webhooks/{id}", middleware.WrapFunc(webhookH.Update, authMW))
		mux.Handle("DELETE /api/v1/admin/webhooks/{id}", middleware.WrapFunc(webhookH.Delete, authMW))
		// Public webhook ingress: throttle per IP to blunt ID-enumeration and
		// spam amplification (a touch higher than the auth limit since busy
		// integrations legitimately post more often).
		mux.Handle("POST /hooks/{id}", middleware.WrapFunc(webhookH.Execute, middleware.RateLimit(d.RateLimiter, 60, time.Minute)))
	}
	// Bot accounts: admin-only identity + credential management. There is no
	// bot-specific messaging route — a bot is a real user, so it joins channels
	// and posts through the same endpoints as everyone else, authenticated by
	// the token issued here.
	if d.Bot != nil {
		mux.Handle("GET /api/v1/admin/bots", middleware.WrapFunc(d.Bot.List, authMW))
		mux.Handle("POST /api/v1/admin/bots", middleware.WrapFunc(d.Bot.Create, authMW))
		mux.Handle("GET /api/v1/admin/bots/{id}", middleware.WrapFunc(d.Bot.Get, authMW))
		mux.Handle("DELETE /api/v1/admin/bots/{id}", middleware.WrapFunc(d.Bot.Delete, authMW))
		mux.Handle("PUT /api/v1/admin/bots/{id}/webhook", middleware.WrapFunc(d.Bot.SetWebhook, authMW))
	}

	// MCP server — bots/agents reach ex's tools over the Model Context Protocol,
	// behind AuthWithBots so tools run as the calling bot/user. Streamable-HTTP
	// uses one path for POST (requests) + GET (event stream).
	if d.Bot != nil {
		mux.Handle("/api/v1/mcp", middleware.Wrap(NewMCPHTTPHandler(d.MCPChat), authMW))
		mux.Handle("GET /api/v1/admin/bots/{id}/tokens", middleware.WrapFunc(d.Bot.ListTokens, authMW))
		mux.Handle("POST /api/v1/admin/bots/{id}/tokens", middleware.WrapFunc(d.Bot.CreateToken, authMW))
		mux.Handle("DELETE /api/v1/admin/bots/{id}/tokens/{tokenID}", middleware.WrapFunc(d.Bot.RevokeToken, authMW))
	}

	// ------------------------------------------------------------------ WebSocket
	// Browsers can't set an Authorization header on a WebSocket, so the
	// upgrade authenticates with a single-use ticket minted here (authed +
	// per-user rate limited — which transitively caps upgrade attempts per
	// account; the old unlimited upgrades let one account open unbounded
	// connections). The upgrade route itself gets a per-IP limit to blunt
	// ticket-guessing, and falls through to header auth for non-browser
	// clients.
	mux.Handle("POST /api/v1/ws/ticket", middleware.WrapFunc(wsH.MintTicket, authMW, middleware.RateLimitPerUser(d.RateLimiter, 30, time.Minute)))
	mux.Handle("GET /api/v1/ws", middleware.WrapFunc(wsH.Connect, wsH.UpgradeAuth(authMW), middleware.RateLimit(d.RateLimiter, 60, time.Minute)))

	// ------------------------------------------------------------------ SPA
	if frontendFS != nil {
		spa := newSPAHandler(frontendFS, appVersion, d.SentryFrontend)
		mux.Handle("/", spa)
	}

	var base http.Handler = mux
	if appVersion != "" {
		base = appVersionHeader(base, appVersion)
	}

	// Apply global middleware: SecurityHeaders, CORS, RequestID, Logging, and a
	// 30s per-request timeout (skips the WebSocket upgrade) so a hung dependency
	// can't pin a request goroutine forever.
	handler := middleware.Wrap(base,
		middleware.SecurityHeadersWith(d.UploadConnectSrc...),
		middleware.CORS(allowOrigins...),
		middleware.RequestID,
		middleware.Logging(!d.DisableAccessLog),
		middleware.RequestTimeout(30*time.Second),
	)

	return handler
}

func appVersionHeader(next http.Handler, version string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(AppVersionHeaderName, version)
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves the embedded SPA. Static asset requests pass through
// to http.FileServer; navigations land on a pre-built index.html augmented
// with an app-version meta tag for reload detection and a build-version meta
// tag for display-only release metadata.
type spaHandler struct {
	fs         http.FileSystem
	fileServer http.Handler
	indexHTML  []byte
}

func newSPAHandler(frontendFS fs.FS, version string, sentry SentryFrontendConfig) *spaHandler {
	httpFS := http.FS(frontendFS)
	h := &spaHandler{fs: httpFS, fileServer: http.FileServer(httpFS)}

	if f, err := frontendFS.Open("index.html"); err == nil {
		defer func() { _ = f.Close() }()
		if raw, err := io.ReadAll(f); err == nil {
			meta := []byte(`<meta name="` + AppVersionMetaName + `" content="` + version + `">` +
				`<meta name="` + BuildVersionMetaName + `" content="` + DisplayVersion(version) + `">`)
			if sentry.DSN != "" {
				// html.EscapeString defends the attribute even though the DSN
				// comes from trusted server config.
				meta = append(meta, []byte(`<meta name="`+SentryDSNMetaName+`" content="`+html.EscapeString(sentry.DSN)+`">`)...)
				// Sample rates ride along only when non-zero — absent means
				// off, and none of them mean anything without a DSN.
				for _, rate := range []struct {
					name  string
					value float64
				}{
					{SentryTracesSampleRateMetaName, sentry.TracesSampleRate},
					{SentryReplaySessionSampleRateMetaName, sentry.ReplaySessionSampleRate},
					{SentryReplayErrorSampleRateMetaName, sentry.ReplayErrorSampleRate},
				} {
					if rate.value > 0 {
						meta = append(meta, []byte(`<meta name="`+rate.name+`" content="`+strconv.FormatFloat(rate.value, 'g', -1, 64)+`">`)...)
					}
				}
			}
			// Insert just before </head>; if the marker isn't present
			// (extremely unlikely with Vite output) fall back to the
			// untouched bytes — the API endpoint still reports the
			// version and polling alone is enough for detection.
			if i := bytes.Index(raw, []byte("</head>")); i >= 0 {
				h.indexHTML = append(append(append([]byte{}, raw[:i]...), meta...), raw[i:]...)
			} else {
				h.indexHTML = raw
			}
		}
	}
	return h
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Don't serve SPA for API or auth routes.
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
		http.NotFound(w, r)
		return
	}

	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}

	// SPA navigations (root or unknown route) get the version-augmented
	// index.html. Static assets pass through to http.FileServer.
	if path == "/index.html" || isUnknown(h.fs, path) {
		if h.indexHTML != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(h.indexHTML)
			return
		}
	}

	// The embedded FS has no mod times, so http.FileServer emits neither
	// validators nor freshness info — meaning every client re-downloaded the
	// multi-MB bundle on every app open. On a mobile webview waking its radio
	// that re-fetch regularly stalled, leaving the app blank (nothing cached
	// to fall back on). Vite content-hashes everything under /assets/, so
	// those files are immutable by construction: cache them for a year.
	// A new deploy ships a new hash via the (no-store) index.html above.
	// Other static files (favicon, manifest) are mutable-in-place — give them
	// a short TTL so updates propagate within the hour.
	if strings.HasPrefix(path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}

	h.fileServer.ServeHTTP(w, r)
}

func isUnknown(httpFS http.FileSystem, path string) bool {
	f, err := httpFS.Open(strings.TrimPrefix(path, "/"))
	if err != nil {
		return true
	}
	_ = f.Close()
	return false
}
