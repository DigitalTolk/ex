package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// MattermostHandler is the Mattermost-compatible REST API (/api/v4): the calls
// an integration written against Mattermost makes to open an incident channel,
// add people to it, post, and message someone directly, authenticated with a
// bot's access token. Requests and answers keep Mattermost's wire format — its
// field names, millisecond timestamps, status codes and error body — so such
// an integration only changes its base URL and token.
type MattermostHandler struct {
	bots  *service.BotService
	users *service.UserService
	mm    *service.MattermostService
}

// NewMattermostHandler returns the Mattermost API handler.
func NewMattermostHandler(bots *service.BotService, users *service.UserService, mm *service.MattermostService) *MattermostHandler {
	return &MattermostHandler{bots: bots, users: users, mm: mm}
}

// Mattermost's error ids for the answers integrations tell apart.
const (
	mmErrSession       = "api.context.session_expired.app_error"
	mmErrBody          = "api.context.invalid_body_param.app_error"
	mmErrParam         = "api.context.invalid_param.app_error"
	mmErrPermissions   = "api.context.permissions.app_error"
	mmErrServer        = "api.context.server_error.app_error"
	mmErrChannelExists = "store.sql_channel.save_channel.exists.app_error"
	mmErrNoUser        = "app.user.missing_account.const"
	mmErrNoChannel     = "app.channel.get.existing.app_error"
	mmErrArchived      = "api.post.create_post.can_not_post_to_deleted.error"
	mmErrDeactivated   = "api.channel.add_user.to.channel.failed.deleted.app_error"
)

// mmError is Mattermost's error body.
type mmError struct {
	ID            string `json:"id"`
	Message       string `json:"message"`
	DetailedError string `json:"detailed_error"`
	RequestID     string `json:"request_id"`
	StatusCode    int    `json:"status_code"`
}

func writeMMError(w http.ResponseWriter, r *http.Request, status int, id, message string) {
	writeJSON(w, status, mmError{
		ID:         id,
		Message:    message,
		RequestID:  middleware.RequestIDFromContext(r.Context()),
		StatusCode: status,
	})
}

// writeMMServiceError answers a failed service call: the status the rest of
// the API gives the same error (errorMappings), with Mattermost's id for it.
// notFoundID is the id for what this call can't find.
func writeMMServiceError(w http.ResponseWriter, r *http.Request, err error, notFoundID string) {
	switch {
	case errors.Is(err, service.ErrChannelArchived):
		writeMMError(w, r, http.StatusForbidden, mmErrArchived, "Can not post to deleted channel.")
		return
	case errors.Is(err, service.ErrMemberDeactivated):
		writeMMError(w, r, http.StatusBadRequest, mmErrDeactivated, "Failed to add user to channel because they have been deactivated.")
		return
	}
	m, ok := lookupError(err)
	if !ok || m.status >= http.StatusInternalServerError {
		slog.ErrorContext(r.Context(), "mattermost api request failed",
			"requestID", middleware.RequestIDFromContext(r.Context()),
			"method", r.Method,
			"path", middleware.RedactPath(r.URL.Path),
			"error", err)
		writeMMError(w, r, http.StatusInternalServerError, mmErrServer, "An internal error occurred.")
		return
	}
	id := mmErrParam
	switch m.status {
	case http.StatusForbidden:
		id = mmErrPermissions
	case http.StatusNotFound:
		id = notFoundID
	}
	writeMMError(w, r, m.status, id, m.text(err))
}

// readMMJSON decodes a request body (up to 1 MB). Unlike readJSON it ignores
// fields it doesn't know: Mattermost does, and its clients send many this API
// has no use for.
func readMMJSON(r *http.Request, dest any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(dest)
}

// mmToken reads the token as Mattermost does: `Authorization: Bearer <token>`
// or `Token <token>`, the scheme in any case.
func mmToken(r *http.Request) string {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "bearer") && !strings.EqualFold(scheme, "token") {
		return ""
	}
	return strings.TrimSpace(token)
}

// Authenticate admits requests made with a bot's token: the request then acts
// as that bot, with a member's rights. Session tokens are refused here, and
// bot tokens everywhere else.
func (h *MattermostHandler) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := h.bots.Authenticate(r.Context(), mmToken(r))
		if errors.Is(err, service.ErrBotTokenInvalid) {
			writeMMError(w, r, http.StatusUnauthorized, mmErrSession, "Invalid or expired session, please login again.")
			return
		}
		if err != nil {
			writeMMServiceError(w, r, err, mmErrNoUser)
			return
		}
		next.ServeHTTP(w, r.WithContext(middleware.ContextWithClaims(r.Context(), claims)))
	})
}

// millis is a Mattermost timestamp: milliseconds since the epoch, 0 for none.
func millis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// mmUser is Mattermost's User, the fields integrations read.
type mmUser struct {
	ID             string            `json:"id"`
	CreateAt       int64             `json:"create_at"`
	UpdateAt       int64             `json:"update_at"`
	DeleteAt       int64             `json:"delete_at"`
	Username       string            `json:"username"`
	AuthData       string            `json:"auth_data"`
	AuthService    string            `json:"auth_service"`
	Email          string            `json:"email"`
	EmailVerified  bool              `json:"email_verified"`
	Nickname       string            `json:"nickname"`
	FirstName      string            `json:"first_name"`
	LastName       string            `json:"last_name"`
	Position       string            `json:"position"`
	Roles          string            `json:"roles"`
	Locale         string            `json:"locale"`
	Timezone       map[string]string `json:"timezone"`
	IsBot          bool              `json:"is_bot"`
	BotDescription string            `json:"bot_description,omitempty"`
}

// mmUsername is the Mattermost username: a bot's own, or (for a person, or a
// bot migrated without one) one made from the email's local part or the
// display name.
func mmUsername(u *model.User) string {
	if u.Username != "" {
		return u.Username
	}
	base := u.DisplayName
	if !u.IsBot {
		base, _, _ = strings.Cut(u.Email, "@")
	}
	var b strings.Builder
	for _, r := range strings.ToLower(base) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return strings.ToLower(u.ID)
	}
	return b.String()
}

func mmUserFrom(u *model.User) mmUser {
	out := mmUser{
		ID:            u.ID,
		CreateAt:      millis(u.CreatedAt),
		UpdateAt:      millis(u.UpdatedAt),
		Username:      mmUsername(u),
		Email:         u.Email,
		EmailVerified: true,
		Roles:         "system_user",
		Locale:        "en",
		Timezone:      map[string]string{"automaticTimezone": u.TimeZone, "manualTimezone": "", "useAutomaticTimezone": "true"},
		IsBot:         u.IsBot,
	}
	if u.Status == "deactivated" {
		out.DeleteAt = out.UpdateAt
	}
	switch u.SystemRole {
	case model.SystemRoleAdmin:
		out.Roles = "system_admin system_user"
	case model.SystemRoleGuest:
		out.Roles = "system_guest"
	}
	// Mattermost keeps a bot's display name as its first name; a person's
	// one display name splits into first and last at its first space.
	if u.IsBot {
		out.FirstName, out.BotDescription = u.DisplayName, u.BotDescription
	} else {
		out.FirstName, out.LastName, _ = strings.Cut(u.DisplayName, " ")
	}
	return out
}

// mmChannel is Mattermost's Channel.
type mmChannel struct {
	ID            string `json:"id"`
	CreateAt      int64  `json:"create_at"`
	UpdateAt      int64  `json:"update_at"`
	DeleteAt      int64  `json:"delete_at"`
	TeamID        string `json:"team_id"`
	Type          string `json:"type"`
	DisplayName   string `json:"display_name"`
	Name          string `json:"name"`
	Header        string `json:"header"`
	Purpose       string `json:"purpose"`
	LastPostAt    int64  `json:"last_post_at"`
	TotalMsgCount int64  `json:"total_msg_count"`
	ExtraUpdateAt int64  `json:"extra_update_at"`
	CreatorID     string `json:"creator_id"`
}

// mmMember is Mattermost's ChannelMember.
type mmMember struct {
	ChannelID    string            `json:"channel_id"`
	UserID       string            `json:"user_id"`
	Roles        string            `json:"roles"`
	LastViewedAt int64             `json:"last_viewed_at"`
	MsgCount     int64             `json:"msg_count"`
	MentionCount int64             `json:"mention_count"`
	NotifyProps  map[string]string `json:"notify_props"`
	LastUpdateAt int64             `json:"last_update_at"`
	SchemeGuest  bool              `json:"scheme_guest"`
	SchemeUser   bool              `json:"scheme_user"`
	SchemeAdmin  bool              `json:"scheme_admin"`
}

// mmPost is Mattermost's Post.
type mmPost struct {
	ID            string         `json:"id"`
	CreateAt      int64          `json:"create_at"`
	UpdateAt      int64          `json:"update_at"`
	EditAt        int64          `json:"edit_at"`
	DeleteAt      int64          `json:"delete_at"`
	IsPinned      bool           `json:"is_pinned"`
	UserID        string         `json:"user_id"`
	ChannelID     string         `json:"channel_id"`
	RootID        string         `json:"root_id"`
	OriginalID    string         `json:"original_id"`
	Message       string         `json:"message"`
	Type          string         `json:"type"`
	Props         map[string]any `json:"props"`
	Hashtags      string         `json:"hashtags"`
	PendingPostID string         `json:"pending_post_id"`
	ReplyCount    int64          `json:"reply_count"`
	Metadata      map[string]any `json:"metadata"`
}

// Me answers GET /api/v4/users/me: the bot itself.
func (h *MattermostHandler) Me(w http.ResponseWriter, r *http.Request) {
	u, err := h.users.GetByID(r.Context(), middleware.UserIDFromContext(r.Context()))
	if err != nil {
		writeMMServiceError(w, r, err, mmErrNoUser)
		return
	}
	writeJSON(w, http.StatusOK, mmUserFrom(u))
}

// UserByEmail answers GET /api/v4/users/email/{email}.
func (h *MattermostHandler) UserByEmail(w http.ResponseWriter, r *http.Request) {
	u, err := h.users.GetByEmail(r.Context(), pathParam(r, "email"))
	if err != nil {
		writeMMServiceError(w, r, err, mmErrNoUser)
		return
	}
	writeJSON(w, http.StatusOK, mmUserFrom(u))
}

// CreateChannel answers POST /api/v4/channels. ex has one workspace, so any
// team_id is taken, and channels have one name, so display_name and header
// are answered back but not kept; the purpose becomes the description.
func (h *MattermostHandler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TeamID      string `json:"team_id"`
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Type        string `json:"type"`
		Header      string `json:"header"`
		Purpose     string `json:"purpose"`
	}
	if err := readMMJSON(r, &body); err != nil {
		writeMMError(w, r, http.StatusBadRequest, mmErrBody, "Invalid or missing channel in request body.")
		return
	}
	switch {
	case body.TeamID == "":
		writeMMError(w, r, http.StatusBadRequest, "model.channel.is_valid.team_id.app_error", "Invalid team id.")
		return
	case body.DisplayName == "":
		writeMMError(w, r, http.StatusBadRequest, "model.channel.is_valid.display_name.app_error", "Invalid display name.")
		return
	case body.Type != "O" && body.Type != "P":
		writeMMError(w, r, http.StatusBadRequest, "model.channel.is_valid.type.app_error", "Invalid type.")
		return
	}
	ch, err := h.mm.CreateChannel(r.Context(), middleware.UserIDFromContext(r.Context()), body.Name, body.Type == "P", body.Purpose)
	if errors.Is(err, service.ErrAlreadyExists) {
		writeMMError(w, r, http.StatusBadRequest, mmErrChannelExists, "A channel with that name already exists on the same team.")
		return
	}
	if err != nil {
		writeMMServiceError(w, r, err, mmErrNoChannel)
		return
	}
	writeJSON(w, http.StatusCreated, mmChannel{
		ID:          ch.ID,
		CreateAt:    millis(ch.CreatedAt),
		UpdateAt:    millis(ch.UpdatedAt),
		TeamID:      body.TeamID,
		Type:        body.Type,
		DisplayName: body.DisplayName,
		Name:        ch.Name,
		Header:      body.Header,
		Purpose:     ch.Description,
		CreatorID:   ch.CreatedBy,
	})
}

// CreateDirectChannel answers POST /api/v4/channels/direct: the body is the
// two user IDs, the bot's own among them. The conversation shows up for the
// other person with its first message.
func (h *MattermostHandler) CreateDirectChannel(w http.ResponseWriter, r *http.Request) {
	var ids []string
	if err := readMMJSON(r, &ids); err != nil {
		writeMMError(w, r, http.StatusBadRequest, mmErrBody, "Invalid or missing user ids in request body.")
		return
	}
	conv, err := h.mm.DirectChannel(r.Context(), middleware.UserIDFromContext(r.Context()), ids)
	if err != nil {
		writeMMServiceError(w, r, err, mmErrNoUser)
		return
	}
	// Mattermost names a direct channel after its two users, in order.
	pair := slices.Clone(ids)
	slices.Sort(pair)
	writeJSON(w, http.StatusCreated, mmChannel{
		ID:        conv.ID,
		CreateAt:  millis(conv.CreatedAt),
		UpdateAt:  millis(conv.UpdatedAt),
		Type:      "D",
		Name:      pair[0] + "__" + pair[1],
		CreatorID: conv.CreatedBy,
	})
}

// AddChannelMember answers POST /api/v4/channels/{channel_id}/members.
func (h *MattermostHandler) AddChannelMember(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID string `json:"user_id"`
	}
	if err := readMMJSON(r, &body); err != nil || body.UserID == "" {
		writeMMError(w, r, http.StatusBadRequest, mmErrParam, "Invalid user_id parameter.")
		return
	}
	m, err := h.mm.AddChannelMember(r.Context(), middleware.UserIDFromContext(r.Context()), pathParam(r, "channel_id"), body.UserID)
	if err != nil {
		writeMMServiceError(w, r, err, mmErrNoUser)
		return
	}
	admin := m.Role >= model.ChannelRoleAdmin
	roles := "channel_user"
	if admin {
		roles = "channel_user channel_admin"
	}
	writeJSON(w, http.StatusCreated, mmMember{
		ChannelID:    m.ChannelID,
		UserID:       m.UserID,
		Roles:        roles,
		NotifyProps:  map[string]string{"desktop": "default", "email": "default", "mark_unread": "all", "push": "default", "ignore_channel_mentions": "default"},
		LastUpdateAt: millis(m.JoinedAt),
		SchemeUser:   true,
		SchemeAdmin:  admin,
	})
}

// CreatePost answers POST /api/v4/posts: to a channel the bot is a member of,
// or a direct channel it opened; root_id makes it a thread reply.
func (h *MattermostHandler) CreatePost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ChannelID     string `json:"channel_id"`
		Message       string `json:"message"`
		RootID        string `json:"root_id"`
		PendingPostID string `json:"pending_post_id"`
	}
	if err := readMMJSON(r, &body); err != nil {
		writeMMError(w, r, http.StatusBadRequest, mmErrBody, "Invalid or missing post in request body.")
		return
	}
	if body.ChannelID == "" {
		writeMMError(w, r, http.StatusBadRequest, mmErrParam, "Invalid channel_id parameter.")
		return
	}
	msg, err := h.mm.CreatePost(r.Context(), middleware.UserIDFromContext(r.Context()), body.ChannelID, body.Message, body.RootID)
	if err != nil {
		writeMMServiceError(w, r, err, mmErrNoChannel)
		return
	}
	writeJSON(w, http.StatusCreated, mmPost{
		ID:            msg.ID,
		CreateAt:      millis(msg.CreatedAt),
		UpdateAt:      millis(msg.CreatedAt),
		UserID:        msg.AuthorID,
		ChannelID:     body.ChannelID,
		RootID:        body.RootID,
		Message:       body.Message,
		Props:         map[string]any{},
		PendingPostID: body.PendingPostID,
		Metadata:      map[string]any{},
	})
}
