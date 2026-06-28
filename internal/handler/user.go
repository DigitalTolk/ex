package handler

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/paginate"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// UserHandler exposes HTTP endpoints for user operations.
type UserHandler struct {
	userSvc *service.UserService
	// s3 is an interface (satisfied by *storage.S3Client) so tests can inject a
	// signer whose presign fails, reaching the avatar presign-error branch a
	// real S3 client (which presigns locally) cannot.
	s3 uploadSigner
}

// NewUserHandler creates a UserHandler.
func NewUserHandler(userSvc *service.UserService, s3 *storage.S3Client) *UserHandler {
	if s3 == nil {
		// Keep nil-interface semantics so the h.s3 == nil guard fires.
		return &UserHandler{userSvc: userSvc}
	}
	return &UserHandler{userSvc: userSvc, s3: s3}
}

// GetMe returns the authenticated user's profile.
func (h *UserHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	user, err := h.userSvc.GetByID(r.Context(), userID)
	if err != nil {
		writeInternalError(w, r, "user_error", err)
		return
	}

	// A deactivated user must not be able to act on the API. The JWT itself
	// is still cryptographically valid until expiry, so the handler is the
	// gate that turns it into a 401 — combined with refresh-token wipe in
	// SetStatus, this ends the session immediately.
	if user.Status == "deactivated" {
		writeError(w, http.StatusUnauthorized, "deactivated", "account has been deactivated")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// UpdateMe updates the authenticated user's profile.
func (h *UserHandler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var body struct {
		DisplayName   *string `json:"displayName"`
		AvatarKey     *string `json:"avatarKey"`
		EmojiSkinTone *string `json:"emojiSkinTone"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	user, err := h.userSvc.Update(r.Context(), userID, body.DisplayName, body.AvatarKey, body.EmojiSkinTone)
	if err != nil {
		writeInternalError(w, r, "update_error", err)
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// SetMyNotificationSettings replaces the authenticated user's account-level
// notification settings (levels, toggles, keywords) and returns the updated
// profile. Body is the full NotificationSettings object.
func (h *UserHandler) SetMyNotificationSettings(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var settings model.NotificationSettings
	if err := readJSON(r, &settings); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	user, err := h.userSvc.SetNotificationSettings(r.Context(), userID, settings)
	if err != nil {
		writeError(w, http.StatusBadRequest, "notification_settings_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// SetMyUserStatus sets the authenticated user's visible status message.
func (h *UserHandler) SetMyUserStatus(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var body struct {
		Emoji             string `json:"emoji"`
		Text              string `json:"text"`
		ClearAfterSeconds *int64 `json:"clearAfterSeconds"`
		TimeZone          string `json:"timeZone"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	var clearAfter *time.Duration
	if body.ClearAfterSeconds != nil {
		d := time.Duration(*body.ClearAfterSeconds) * time.Second
		clearAfter = &d
	}
	user, err := h.userSvc.SetUserStatusMessage(r.Context(), userID, &model.UserStatus{
		Emoji: body.Emoji,
		Text:  body.Text,
	}, clearAfter, body.TimeZone)
	if err != nil {
		writeError(w, http.StatusBadRequest, "status_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// ClearMyUserStatus clears the authenticated user's visible status message.
func (h *UserHandler) ClearMyUserStatus(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		TimeZone string `json:"timeZone"`
	}
	if r.Body != nil {
		_ = readJSON(r, &body)
	}
	user, err := h.userSvc.SetUserStatusMessage(r.Context(), userID, nil, nil, body.TimeZone)
	if err != nil {
		writeError(w, http.StatusBadRequest, "status_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// GetUser returns a user by ID. Non-admin callers receive limited fields.
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "user ID is required")
		return
	}

	user, err := h.userSvc.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "user not found")
			return
		}
		writeInternalError(w, r, "user_error", err)
		return
	}

	// Non-admins see the limited public projection.
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil || claims.SystemRole != model.SystemRoleAdmin {
		writeJSON(w, http.StatusOK, publicUserJSON(user))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// BatchGetUsers returns users matching a list of IDs in a single request.
func (h *UserHandler) BatchGetUsers(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if len(body.IDs) == 0 {
		writeJSON(w, http.StatusOK, []*model.User{})
		return
	}
	if len(body.IDs) > 100 {
		writeError(w, http.StatusBadRequest, "too_many_ids", "maximum 100 IDs per request")
		return
	}

	users, err := h.userSvc.GetBatch(r.Context(), body.IDs)
	if err != nil { // coverage-ignore: UserService.GetBatch swallows per-user errors (continue) and always returns a nil error — no request can drive this branch; the guard is defensive against a future contract change.
		writeInternalError(w, r, "batch_error", err)
		return
	}
	if users == nil { // coverage-ignore: GetBatch returns a make()-initialized slice that is never nil; coercion is defensive against a future contract change.
		users = []*model.User{}
	}

	// Return the same limited public projection as GetUser / ListUsers.
	writeJSON(w, http.StatusOK, publicUserList(users))
}

// listAllMaxRounds caps the inner pagination loop served by
// ListUsers's `?all=true` mode so a misbehaving backend (or a wildly
// large workspace) can't pin the request indefinitely. 200 rounds *
// 500 users = up to 100k users — well above any realistic team size,
// short enough to fail fast if something is wrong.
const listAllMaxRounds = 200
const listAllPageSize = 500

// publicUserJSON projects a user to the fields safe for ANY authenticated member
// (the limited shape BatchGetUsers returns to non-admins, plus email for mention
// matching). systemRole / authProvider are admin-only and must never leak
// through a roster fetch by a regular member or guest.
func publicUserJSON(u *model.User) JSON {
	return JSON{
		"id":          u.ID,
		"displayName": u.DisplayName,
		"email":       u.Email,
		"avatarURL":   u.AvatarURL,
		"status":      u.Status,
		"userStatus":  u.UserStatus,
		"timeZone":    u.TimeZone,
		"lastSeenAt":  u.LastSeenAt,
	}
}

func publicUserList(users []*model.User) []JSON {
	out := make([]JSON, 0, len(users))
	for _, u := range users {
		out = append(out, publicUserJSON(u))
	}
	return out
}

// usersForCaller returns the FULL user objects to an admin caller (the admin
// directory page needs systemRole/authProvider to render roles and gate
// promote/demote) and the limited public projection to everyone else, so a
// regular member or guest can't read those admin-only fields.
func usersForCaller(r *http.Request, users []*model.User) any {
	claims := middleware.ClaimsFromContext(r.Context())
	if claims != nil && claims.SystemRole == model.SystemRoleAdmin {
		return users
	}
	return publicUserList(users)
}

// ListUsers returns a paginated list of users. If the "q" query parameter is
// provided, it searches users by display name or email prefix instead.
// `?all=true` returns the whole roster by paginating internally — used by the
// mention popup which caches the list client-side, so it's ALWAYS the limited
// public projection. The directory (default + `?q=`) paths give the full record
// to admins and the public projection to everyone else (see usersForCaller).
func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	q := queryParam(r, "q", "")
	if q != "" {
		users, err := h.userSvc.Search(r.Context(), q, 20)
		if err != nil {
			writeInternalError(w, r, "search_error", err)
			return
		}
		writeJSON(w, http.StatusOK, usersForCaller(r, users))
		return
	}

	if queryParam(r, "all", "") == "true" {
		users, err := paginate.All(r.Context(), func(ctx context.Context, cursor string) ([]*model.User, string, error) {
			return h.userSvc.List(ctx, listAllPageSize, cursor)
		}, listAllMaxRounds)
		if err != nil {
			writeInternalError(w, r, "list_error", err)
			return
		}
		writeJSON(w, http.StatusOK, publicUserList(users))
		return
	}

	limit := queryInt(r, "limit", 50)
	cursor := queryParam(r, "cursor", "")

	users, _, err := h.userSvc.List(r.Context(), limit, cursor)
	if err != nil {
		writeInternalError(w, r, "list_error", err)
		return
	}

	writeJSON(w, http.StatusOK, usersForCaller(r, users))
}

// UpdateUserRole changes a user's system role. Admin-only.
func (h *UserHandler) UpdateUserRole(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	targetID := pathParam(r, "id")
	if targetID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "user ID is required")
		return
	}

	var body struct {
		Role string `json:"role"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	role := model.SystemRole(body.Role)
	if role != model.SystemRoleAdmin && role != model.SystemRoleMember && role != model.SystemRoleGuest {
		writeError(w, http.StatusBadRequest, "invalid_role", "role must be admin, member, or guest")
		return
	}

	user, err := h.userSvc.UpdateRole(r.Context(), middleware.UserIDFromContext(r.Context()), targetID, role)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "user not found")
			return
		}
		writeInternalError(w, r, "update_error", err)
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// SetUserStatus deactivates or reactivates a guest user account. Admin-only.
func (h *UserHandler) SetUserStatus(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	targetID := pathParam(r, "id")
	if targetID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "user ID is required")
		return
	}

	var body struct {
		Deactivated bool `json:"deactivated"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	user, err := h.userSvc.SetStatus(r.Context(), targetID, body.Deactivated)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "user not found")
			return
		}
		writeError(w, http.StatusBadRequest, "status_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// CreateAvatarUploadURL returns a presigned PUT URL the browser can use to
// upload an avatar directly to S3 without the bytes passing through this
// server. The browser then PATCHes /users/me with the returned key to
// associate the new avatar with the user.
func (h *UserHandler) CreateAvatarUploadURL(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	if h.s3 == nil {
		writeError(w, http.StatusServiceUnavailable, "no_storage", "file storage not configured")
		return
	}

	var body struct {
		ContentType string `json:"contentType"`
		Size        int64  `json:"size"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.ContentType != "image/jpeg" && body.ContentType != "image/png" && body.ContentType != "image/webp" {
		writeError(w, http.StatusBadRequest, "invalid_type", "only JPEG, PNG, or WebP images allowed")
		return
	}
	if body.Size <= 0 || body.Size > 2*1024*1024 {
		writeError(w, http.StatusBadRequest, "invalid_size", "avatar size is required and too large")
		return
	}

	key := "avatars/" + userID + "/" + store.NewID()
	url, err := h.s3.PresignedPutURL(r.Context(), key, body.ContentType, 10*time.Minute)
	if err != nil {
		writeInternalError(w, r, "presign_error", err)
		return
	}

	writeJSON(w, http.StatusOK, JSON{
		"uploadURL": url,
		"key":       key,
	})
}
