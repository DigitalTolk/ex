package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// UserHandler exposes HTTP endpoints for user operations.
type UserHandler struct {
	userSvc *service.UserService
	s3      *storage.S3Client
}

// NewUserHandler creates a UserHandler.
func NewUserHandler(userSvc *service.UserService, s3 *storage.S3Client) *UserHandler {
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
		writeError(w, http.StatusInternalServerError, "user_error", err.Error())
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
		DisplayName *string `json:"displayName"`
		AvatarKey   *string `json:"avatarKey"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	user, err := h.userSvc.Update(r.Context(), userID, body.DisplayName, body.AvatarKey)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update_error", err.Error())
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
		writeError(w, http.StatusInternalServerError, "user_error", err.Error())
		return
	}

	// Non-admins see a limited view.
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil || claims.SystemRole != model.SystemRoleAdmin {
		writeJSON(w, http.StatusOK, JSON{
			"id":          user.ID,
			"displayName": user.DisplayName,
			"avatarURL":   user.AvatarURL,
			"status":      user.Status,
		})
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
	if err != nil {
		writeError(w, http.StatusInternalServerError, "batch_error", err.Error())
		return
	}
	if users == nil {
		users = []*model.User{}
	}

	// Return limited fields (same as GetUser for non-admins).
	result := make([]JSON, 0, len(users))
	for _, u := range users {
		result = append(result, JSON{
			"id":          u.ID,
			"displayName": u.DisplayName,
			"avatarURL":   u.AvatarURL,
			"status":      u.Status,
		})
	}
	writeJSON(w, http.StatusOK, result)
}

// ListUsers returns a paginated list of users. If the "q" query parameter is
// provided, it searches users by display name or email prefix instead.
func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	q := queryParam(r, "q", "")
	if q != "" {
		users, err := h.userSvc.Search(r.Context(), q, 20)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "search_error", err.Error())
			return
		}
		if users == nil {
			users = []*model.User{}
		}
		// Return limited fields.
		result := make([]JSON, 0, len(users))
		for _, u := range users {
			result = append(result, JSON{
				"id":          u.ID,
				"displayName": u.DisplayName,
				"email":       u.Email,
				"avatarURL":   u.AvatarURL,
			})
		}
		writeJSON(w, http.StatusOK, result)
		return
	}

	limit := queryInt(r, "limit", 50)
	cursor := queryParam(r, "cursor", "")

	users, _, err := h.userSvc.List(r.Context(), limit, cursor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if users == nil {
		users = []*model.User{}
	}

	writeJSON(w, http.StatusOK, users)
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
		writeError(w, http.StatusInternalServerError, "update_error", err.Error())
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
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.ContentType != "image/jpeg" && body.ContentType != "image/png" && body.ContentType != "image/webp" {
		writeError(w, http.StatusBadRequest, "invalid_type", "only JPEG, PNG, or WebP images allowed")
		return
	}

	key := "avatars/" + userID + "/" + store.NewID()
	url, err := h.s3.PresignedPutURL(r.Context(), key, body.ContentType, 10*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "presign_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, JSON{
		"uploadURL": url,
		"key":       key,
	})
}
