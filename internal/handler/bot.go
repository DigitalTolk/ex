package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// BotHandler is the admin API for bot accounts and their access tokens
// (/api/v1/admin/bots). The service refuses anyone but an admin.
type BotHandler struct {
	svc *service.BotService
}

// NewBotHandler returns the bot admin handler.
func NewBotHandler(svc *service.BotService) *BotHandler {
	return &BotHandler{svc: svc}
}

// botActor is the caller, with the stored role the auth middleware put in the
// claims.
func botActor(r *http.Request) service.BotActor {
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil {
		return service.BotActor{}
	}
	return service.BotActor{ID: claims.UserID, Role: claims.SystemRole}
}

func botAccount(u *model.User) model.BotAccount {
	return model.BotAccount{
		ID:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		Description: u.BotDescription,
		OwnerID:     u.BotOwnerID,
		Status:      u.Status,
		CreatedAt:   u.CreatedAt,
		UpdatedAt:   u.UpdatedAt,
	}
}

// List answers GET /api/v1/admin/bots.
func (h *BotHandler) List(w http.ResponseWriter, r *http.Request) {
	bots, err := h.svc.List(r.Context(), botActor(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	out := make([]model.BotAccount, 0, len(bots))
	for _, b := range bots {
		out = append(out, botAccount(b))
	}
	writeJSON(w, http.StatusOK, out)
}

// Create answers POST /api/v1/admin/bots.
func (h *BotHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body service.BotInput
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	bot, err := h.svc.Create(r.Context(), botActor(r), body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, botAccount(bot))
}

// Update answers PATCH /api/v1/admin/bots/{id}.
func (h *BotHandler) Update(w http.ResponseWriter, r *http.Request) {
	var body service.BotInput
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	bot, err := h.svc.Update(r.Context(), botActor(r), pathParam(r, "id"), body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, botAccount(bot))
}

// Enable answers POST /api/v1/admin/bots/{id}/enable.
func (h *BotHandler) Enable(w http.ResponseWriter, r *http.Request) { h.setEnabled(w, r, true) }

// Disable answers POST /api/v1/admin/bots/{id}/disable.
func (h *BotHandler) Disable(w http.ResponseWriter, r *http.Request) { h.setEnabled(w, r, false) }

func (h *BotHandler) setEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	bot, err := h.svc.SetEnabled(r.Context(), botActor(r), pathParam(r, "id"), enabled)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, botAccount(bot))
}

// ListTokens answers GET /api/v1/admin/bots/{id}/tokens.
func (h *BotHandler) ListTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := h.svc.ListTokens(r.Context(), botActor(r), pathParam(r, "id"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

// CreateToken answers POST /api/v1/admin/bots/{id}/tokens with the token and
// its secret, which is never shown again.
func (h *BotHandler) CreateToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Description string `json:"description"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	issued, err := h.svc.CreateToken(r.Context(), botActor(r), pathParam(r, "id"), body.Description)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, issued)
}

// RevokeToken answers DELETE /api/v1/admin/bots/{id}/tokens/{tokenID}.
func (h *BotHandler) RevokeToken(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.RevokeToken(r.Context(), botActor(r), pathParam(r, "id"), pathParam(r, "tokenID")); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
