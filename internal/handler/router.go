package handler

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// NewRouter builds the application HTTP handler, registering all routes.
//
// frontendFS should be the frontend/dist subtree (already sub-rooted); pass nil
// to disable the embedded SPA. appVersion is the build identifier the SPA
// embeds in its `<meta name="app-version">` tag — main computes it once
// and forwards the same value here to avoid re-hashing index.html.
func NewRouter(
	authH *AuthHandler,
	userH *UserHandler,
	channelH *ChannelHandler,
	convH *ConversationHandler,
	wsH *WSHandler,
	uploadH *UploadHandler,
	emojiH *EmojiHandler,
	presenceH *PresenceHandler,
	attachmentH *AttachmentHandler,
	adminH *AdminHandler,
	threadH *ThreadHandler,
	versionH *VersionHandler,
	unfurlH *UnfurlHandler,
	sidebarH *SidebarHandler,
	searchH *SearchHandler,
	jwtMgr *auth.JWTManager,
	frontendFS fs.FS,
	appVersion string,
	allowOrigin string,
) http.Handler {
	mux := http.NewServeMux()

	authMW := middleware.Auth(jwtMgr)

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

	// ------------------------------------------------------------------ Auth (public)
	mux.HandleFunc("GET /auth/oidc/login", authH.OIDCLogin)
	mux.HandleFunc("GET /auth/oidc/callback", authH.OIDCCallback)
	mux.HandleFunc("POST /auth/token/refresh", authH.RefreshToken)
	mux.HandleFunc("POST /auth/logout", authH.Logout)
	mux.HandleFunc("POST /auth/invite/accept", authH.AcceptInvite)
	mux.HandleFunc("POST /auth/login", authH.GuestLogin)

	// ------------------------------------------------------------------ Auth (protected)
	mux.Handle("POST /auth/invite", middleware.WrapFunc(authH.CreateInvite, authMW))

	// ------------------------------------------------------------------ Users
	mux.Handle("GET /api/v1/users/me", middleware.WrapFunc(userH.GetMe, authMW))
	mux.Handle("PATCH /api/v1/users/me", middleware.WrapFunc(userH.UpdateMe, authMW))
	mux.Handle("POST /api/v1/users/me/avatar/upload-url", middleware.WrapFunc(userH.CreateAvatarUploadURL, authMW))
	mux.Handle("POST /api/v1/users/batch", middleware.WrapFunc(userH.BatchGetUsers, authMW))
	mux.Handle("GET /api/v1/users/{id}", middleware.WrapFunc(userH.GetUser, authMW))
	mux.Handle("PATCH /api/v1/users/{id}/role", middleware.WrapFunc(userH.UpdateUserRole, authMW))
	mux.Handle("PATCH /api/v1/users/{id}/status", middleware.WrapFunc(userH.SetUserStatus, authMW))
	mux.Handle("GET /api/v1/users", middleware.WrapFunc(userH.ListUsers, authMW))

	// ------------------------------------------------------------------ Channels
	mux.Handle("POST /api/v1/channels", middleware.WrapFunc(channelH.Create, authMW))
	mux.Handle("GET /api/v1/channels", middleware.WrapFunc(channelH.List, authMW))
	mux.Handle("GET /api/v1/channels/browse", middleware.WrapFunc(channelH.BrowsePublic, authMW))
	mux.Handle("GET /api/v1/channels/{id}", middleware.WrapFunc(channelH.Get, authMW))
	mux.Handle("PATCH /api/v1/channels/{id}", middleware.WrapFunc(channelH.Update, authMW))
	mux.Handle("DELETE /api/v1/channels/{id}", middleware.WrapFunc(channelH.Archive, authMW))

	mux.Handle("POST /api/v1/channels/{id}/join", middleware.WrapFunc(channelH.Join, authMW))
	mux.Handle("POST /api/v1/channels/{id}/leave", middleware.WrapFunc(channelH.Leave, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/mute", middleware.WrapFunc(channelH.SetMute, authMW))

	mux.Handle("GET /api/v1/channels/{id}/members", middleware.WrapFunc(channelH.ListMembers, authMW))
	mux.Handle("POST /api/v1/channels/{id}/members", middleware.WrapFunc(channelH.AddMember, authMW))
	mux.Handle("DELETE /api/v1/channels/{id}/members/{uid}", middleware.WrapFunc(channelH.RemoveMember, authMW))
	mux.Handle("PATCH /api/v1/channels/{id}/members/{uid}", middleware.WrapFunc(channelH.UpdateMemberRole, authMW))

	mux.Handle("GET /api/v1/channels/{id}/messages", middleware.WrapFunc(channelH.ListMessages, authMW))
	mux.Handle("POST /api/v1/channels/{id}/messages", middleware.WrapFunc(channelH.SendMessage, authMW))
	mux.Handle("PATCH /api/v1/channels/{id}/messages/{msgId}", middleware.WrapFunc(channelH.EditMessage, authMW))
	mux.Handle("DELETE /api/v1/channels/{id}/messages/{msgId}", middleware.WrapFunc(channelH.DeleteMessage, authMW))
	mux.Handle("GET /api/v1/channels/{id}/messages/{msgId}/thread", middleware.WrapFunc(channelH.GetThread, authMW))
	mux.Handle("POST /api/v1/channels/{id}/messages/{msgId}/reactions", middleware.WrapFunc(channelH.ToggleReaction, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/messages/{msgId}/pinned", middleware.WrapFunc(channelH.SetPinned, authMW))
	mux.Handle("PUT /api/v1/channels/{id}/messages/{msgId}/no-unfurl", middleware.WrapFunc(channelH.SetNoUnfurl, authMW))
	mux.Handle("GET /api/v1/channels/{id}/pinned", middleware.WrapFunc(channelH.ListPinned, authMW))
	mux.Handle("GET /api/v1/channels/{id}/files", middleware.WrapFunc(channelH.ListFiles, authMW))

	// ------------------------------------------------------------------ Conversations
	mux.Handle("POST /api/v1/conversations", middleware.WrapFunc(convH.Create, authMW))
	mux.Handle("GET /api/v1/conversations", middleware.WrapFunc(convH.List, authMW))
	mux.Handle("GET /api/v1/conversations/{id}", middleware.WrapFunc(convH.Get, authMW))

	mux.Handle("GET /api/v1/conversations/{id}/messages", middleware.WrapFunc(convH.ListMessages, authMW))
	mux.Handle("POST /api/v1/conversations/{id}/messages", middleware.WrapFunc(convH.SendMessage, authMW))
	mux.Handle("PATCH /api/v1/conversations/{id}/messages/{msgId}", middleware.WrapFunc(convH.EditMessage, authMW))
	mux.Handle("DELETE /api/v1/conversations/{id}/messages/{msgId}", middleware.WrapFunc(convH.DeleteMessage, authMW))
	mux.Handle("GET /api/v1/conversations/{id}/messages/{msgId}/thread", middleware.WrapFunc(convH.GetThread, authMW))
	mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/reactions", middleware.WrapFunc(convH.ToggleReaction, authMW))
	mux.Handle("PUT /api/v1/conversations/{id}/messages/{msgId}/pinned", middleware.WrapFunc(convH.SetPinned, authMW))
	mux.Handle("PUT /api/v1/conversations/{id}/messages/{msgId}/no-unfurl", middleware.WrapFunc(convH.SetNoUnfurl, authMW))
	mux.Handle("GET /api/v1/conversations/{id}/pinned", middleware.WrapFunc(convH.ListPinned, authMW))
	mux.Handle("GET /api/v1/conversations/{id}/files", middleware.WrapFunc(convH.ListFiles, authMW))

	// ------------------------------------------------------------------ Threads (cross-parent)
	if threadH != nil {
		mux.Handle("GET /api/v1/threads", middleware.WrapFunc(threadH.List, authMW))
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
	}

	// ------------------------------------------------------------------ Uploads
	if uploadH != nil {
		mux.Handle("POST /api/v1/uploads/url", middleware.WrapFunc(uploadH.CreateUploadURL, authMW))
	}

	// ------------------------------------------------------------------ Attachments
	if attachmentH != nil {
		mux.HandleFunc("GET /api/v1/media/{token}/{filename...}", attachmentH.Media)
		mux.Handle("POST /api/v1/attachments/url", middleware.WrapFunc(attachmentH.CreateUploadURL, authMW))
		mux.Handle("GET /api/v1/attachments", middleware.WrapFunc(attachmentH.List, authMW))
		mux.Handle("GET /api/v1/attachments/{id}", middleware.WrapFunc(attachmentH.Get, authMW))
		mux.Handle("DELETE /api/v1/attachments/{id}", middleware.WrapFunc(attachmentH.Delete, authMW))
	}

	// ------------------------------------------------------------------ Custom emojis
	if emojiH != nil {
		mux.Handle("GET /api/v1/emojis", middleware.WrapFunc(emojiH.List, authMW))
		mux.Handle("POST /api/v1/emojis", middleware.WrapFunc(emojiH.Create, authMW))
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
	}

	// ------------------------------------------------------------------ WebSocket
	mux.Handle("GET /api/v1/ws", middleware.WrapFunc(wsH.Connect, authMW))

	// ------------------------------------------------------------------ SPA
	if frontendFS != nil {
		spa := newSPAHandler(frontendFS, appVersion)
		mux.Handle("/", spa)
	}

	// Apply global middleware: CORS, RequestID, Logging.
	handler := middleware.Wrap(mux,
		middleware.CORS(allowOrigin),
		middleware.RequestID,
		middleware.Logging,
	)

	return handler
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

func newSPAHandler(frontendFS fs.FS, version string) *spaHandler {
	httpFS := http.FS(frontendFS)
	h := &spaHandler{fs: httpFS, fileServer: http.FileServer(httpFS)}

	if f, err := frontendFS.Open("index.html"); err == nil {
		defer func() { _ = f.Close() }()
		if raw, err := io.ReadAll(f); err == nil {
			meta := []byte(`<meta name="` + AppVersionMetaName + `" content="` + version + `">` +
				`<meta name="` + BuildVersionMetaName + `" content="` + DisplayVersion(version) + `">`)
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
	// index.html. Static assets pass through to http.FileServer so its
	// caching headers and range support stay intact.
	if path == "/index.html" || isUnknown(h.fs, path) {
		if h.indexHTML != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(h.indexHTML)
			return
		}
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
