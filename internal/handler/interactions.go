package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// InteractionHandler serves app interactivity: its setup in the webhooks
// panel, and the response_url apps answer clicks through.
type InteractionHandler struct {
	svc *service.InteractionService
}

// NewInteractionHandler creates an InteractionHandler.
func NewInteractionHandler(svc *service.InteractionService) *InteractionHandler {
	return &InteractionHandler{svc: svc}
}

// Status answers with a webhook's interactivity: settings, pause, history.
func (h *InteractionHandler) Status(w http.ResponseWriter, r *http.Request) {
	status, err := h.svc.Status(r.Context(), webhookActor(r), pathParam(r, "id"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// SetRequestURL sets (or, empty, clears) where the app receives clicks.
// Body: {"requestURL": "https://…"}.
func (h *InteractionHandler) SetRequestURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestURL string `json:"requestURL"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	wh, err := h.svc.SetRequestURL(r.Context(), webhookActor(r), pathParam(r, "id"), body.RequestURL)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wh)
}

// RotateBotToken issues a bot token; the answer is the only time it is shown.
// Body: {"revokeNow": bool}.
func (h *InteractionHandler) RotateBotToken(w http.ResponseWriter, r *http.Request) {
	h.rotate(w, r, h.svc.RotateBotToken, "token")
}

// RotateSigningSecret issues a signing secret, shown once. Body as above.
func (h *InteractionHandler) RotateSigningSecret(w http.ResponseWriter, r *http.Request) {
	h.rotate(w, r, h.svc.RotateSigningSecret, "secret")
}

func (h *InteractionHandler) rotate(w http.ResponseWriter, r *http.Request, rotate func(ctx context.Context, actor service.WebhookActor, id string, revokeNow bool) (string, *model.IncomingWebhook, error), field string) {
	var body struct {
		RevokeNow bool `json:"revokeNow"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	value, wh, err := rotate(r.Context(), webhookActor(r), pathParam(r, "id"), body.RevokeNow)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{field: value, "webhook": wh})
}

// SetEmailSharing turns sharing clickers' emails with the app on or off.
// Body: {"enabled": bool}. Workspace admins only.
func (h *InteractionHandler) SetEmailSharing(w http.ResponseWriter, r *http.Request) {
	h.toggle(w, r, h.svc.SetEmailSharing)
}

// SetPaused stops or resumes the app's buttons. Body: {"enabled": bool}.
// Workspace admins only.
func (h *InteractionHandler) SetPaused(w http.ResponseWriter, r *http.Request) {
	h.toggle(w, r, h.svc.SetAdminPaused)
}

func (h *InteractionHandler) toggle(w http.ResponseWriter, r *http.Request, set func(ctx context.Context, actor service.WebhookActor, id string, on bool) (*model.IncomingWebhook, error)) {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	wh, err := set(r.Context(), webhookActor(r), pathParam(r, "id"), body.Enabled)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wh)
}

// SendTest sends the app a signed sample click and answers with how it went.
func (h *InteractionHandler) SendTest(w http.ResponseWriter, r *http.Request) {
	result, err := h.svc.SendTest(r.Context(), webhookActor(r), pathParam(r, "id"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// Respond takes an app's answer to a click, posted to its response_url. No
// session: the URL's token is the credential. The answer follows Slack's
// shape: {"ok": true}, or {"ok": false, "error": "<code>"}.
func (h *InteractionHandler) Respond(w http.ResponseWriter, r *http.Request) {
	var resp service.AppResponse
	r.Body = http.MaxBytesReader(nil, r.Body, maxWebhookBodyBytes)
	if err := readJSON(r, &resp); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return
	}
	err := h.svc.Respond(r.Context(), pathParam(r, "token"), resp)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	status, code := respondError(err)
	if status == http.StatusInternalServerError {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, status, map[string]any{"ok": false, "error": code})
}

func respondError(err error) (int, string) {
	switch {
	case errors.Is(err, service.ErrResponseURLExpired):
		return http.StatusGone, "expired_url"
	case errors.Is(err, service.ErrResponseURLUsedUp):
		return http.StatusGone, "used_up"
	case errors.Is(err, service.ErrInvalidBlocks), errors.Is(err, apperr.ErrValidation):
		return http.StatusBadRequest, "invalid_blocks"
	case errors.Is(err, service.ErrAppVersionConflict):
		return http.StatusConflict, "version_conflict"
	case errors.Is(err, apperr.ErrNotFound):
		return http.StatusNotFound, "message_not_found"
	}
	return http.StatusInternalServerError, ""
}
