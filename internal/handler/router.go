package handler

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// NewRouter builds the application HTTP handler, registering all routes.
//
// frontendFS should be the frontend/dist subtree (already sub-rooted); pass nil
// to disable the embedded SPA.
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
	jwtMgr *auth.JWTManager,
	frontendFS fs.FS,
	allowOrigin string,
) http.Handler {
	mux := http.NewServeMux()

	authMW := middleware.Auth(jwtMgr)

	// ------------------------------------------------------------------ Health
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, JSON{"status": "ok"})
	})

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

	// ------------------------------------------------------------------ Uploads
	if uploadH != nil {
		mux.Handle("POST /api/v1/uploads/url", middleware.WrapFunc(uploadH.CreateUploadURL, authMW))
	}

	// ------------------------------------------------------------------ Attachments
	if attachmentH != nil {
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

	// ------------------------------------------------------------------ WebSocket
	mux.Handle("GET /api/v1/ws", middleware.WrapFunc(wsH.Connect, authMW))

	// ------------------------------------------------------------------ SPA
	if frontendFS != nil {
		spa := spaHandler{fs: http.FS(frontendFS), fileServer: http.FileServer(http.FS(frontendFS))}
		mux.Handle("/", &spa)
	}

	// Apply global middleware: CORS, RequestID, Logging.
	handler := middleware.Wrap(mux,
		middleware.CORS(allowOrigin),
		middleware.RequestID,
		middleware.Logging,
	)

	return handler
}

// spaHandler serves static files from the embedded filesystem and falls back
// to index.html for client-side routing.
type spaHandler struct {
	fs         http.FileSystem
	fileServer http.Handler
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Don't serve SPA for API or auth routes.
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
		http.NotFound(w, r)
		return
	}

	// Try to serve the file directly.
	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}

	_, err := h.fs.Open(strings.TrimPrefix(path, "/"))
	if err != nil {
		// File not found: serve index.html for SPA client-side routing.
		r.URL.Path = "/"
		h.fileServer.ServeHTTP(w, r)
		return
	}

	h.fileServer.ServeHTTP(w, r)
}
