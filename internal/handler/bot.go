package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// BotHandler exposes admin CRUD for bot accounts and their API tokens.
//
// There is deliberately no endpoint here for adding a bot to a channel or for
// posting as a bot: a bot is a real user, so it joins channels through the
// normal membership endpoint and posts through the normal message endpoints
// with its own token. This handler only covers what's genuinely bot-specific —
// creating the identity and managing its credentials.
type BotHandler struct {
	svc *service.BotService
}

func NewBotHandler(svc *service.BotService) *BotHandler {
	return &BotHandler{svc: svc}
}

// botResponse pairs a bot's metadata with the parts of its user row admins need
// to see (display name and whether it's been retired).
type botResponse struct {
	*model.BotAccount
	DisplayName string `json:"displayName,omitempty"`
	Status      string `json:"status,omitempty"`
}

// tokenIssuedResponse carries the one and only delivery of a token's plaintext.
type tokenIssuedResponse struct {
	*model.BotToken
	Token string `json:"token"`
}

func (h *BotHandler) List(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	bots, err := h.svc.ListBots(r.Context())
	if err != nil {
		writeInternalError(w, r, "list_error", err)
		return
	}
	out := make([]botResponse, 0, len(bots))
	for _, b := range bots {
		out = append(out, botResponse{BotAccount: b})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *BotHandler) Create(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	actorID := middleware.UserIDFromContext(r.Context())
	user, bot, err := h.svc.CreateBot(r.Context(), actorID, body.Name, body.Description)
	if err != nil {
		writeError(w, http.StatusBadRequest, "create_error", err.Error())
		return
	}
	slog.Info("bot audit: created", "actorID", actorID, "botUserID", bot.UserID, "name", bot.Name)
	writeJSON(w, http.StatusCreated, botResponse{
		BotAccount:  bot,
		DisplayName: user.DisplayName,
		Status:      user.Status,
	})
}

func (h *BotHandler) Get(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	bot, user, err := h.svc.GetBot(r.Context(), pathParam(r, "id"))
	if err != nil {
		h.writeLookupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, botResponse{
		BotAccount:  bot,
		DisplayName: user.DisplayName,
		Status:      user.Status,
	})
}

// Delete retires the bot: its tokens are revoked and its account deactivated.
// The user row survives so messages it authored keep rendering.
func (h *BotHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := pathParam(r, "id")
	if err := h.svc.DeleteBot(r.Context(), id); err != nil {
		h.writeLookupError(w, r, err)
		return
	}
	slog.Info("bot audit: deleted", "actorID", middleware.UserIDFromContext(r.Context()), "botUserID", id)
	w.WriteHeader(http.StatusNoContent)
}

// SetWebhook makes a bot an external (outgoing-webhook) bot, or clears it
// (empty callback_url). ex then POSTs each @mention event to the URL and posts
// the response back.
func (h *BotHandler) SetWebhook(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body struct {
		CallbackURL string `json:"callback_url"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	id := pathParam(r, "id")
	secret, err := h.svc.SetWebhook(r.Context(), id, body.CallbackURL)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCallbackURL) {
			writeError(w, http.StatusBadRequest, "invalid_callback_url", err.Error())
			return
		}
		h.writeLookupError(w, r, err)
		return
	}
	slog.Info("bot audit: webhook set", "actorID", middleware.UserIDFromContext(r.Context()), "botUserID", id, "enabled", body.CallbackURL != "")
	// Reveal the signing secret once so the operator can verify X-Ex-Signature on
	// the receiver. Empty when the webhook was cleared.
	writeJSON(w, http.StatusOK, JSON{"ok": true, "signing_secret": secret})
}

// CreateToken issues a token. The plaintext appears in this response and never
// again — the client must capture it here.
func (h *BotHandler) CreateToken(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	// An absent body is fine — the label is optional.
	if r.ContentLength > 0 {
		if err := readJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
			return
		}
	}
	id := pathParam(r, "id")
	plaintext, tok, err := h.svc.IssueToken(r.Context(), id, body.Label)
	if err != nil {
		h.writeLookupError(w, r, err)
		return
	}
	slog.Info("bot audit: token issued",
		"actorID", middleware.UserIDFromContext(r.Context()),
		"botUserID", id, "tokenID", tok.TokenID)
	writeJSON(w, http.StatusCreated, tokenIssuedResponse{BotToken: tok, Token: plaintext})
}

func (h *BotHandler) ListTokens(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	tokens, err := h.svc.ListTokens(r.Context(), pathParam(r, "id"))
	if err != nil {
		h.writeLookupError(w, r, err)
		return
	}
	// model.BotToken keeps TokenHash unserialized, so this exposes only
	// metadata — never anything that could authenticate a request.
	writeJSON(w, http.StatusOK, tokens)
}

func (h *BotHandler) RevokeToken(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	botID, tokenID := pathParam(r, "id"), pathParam(r, "tokenID")
	if err := h.svc.RevokeToken(r.Context(), botID, tokenID); err != nil {
		h.writeLookupError(w, r, err)
		return
	}
	slog.Info("bot audit: token revoked",
		"actorID", middleware.UserIDFromContext(r.Context()),
		"botUserID", botID, "tokenID", tokenID)
	w.WriteHeader(http.StatusNoContent)
}

// writeLookupError maps a service error to a response: a missing bot or token
// is a 404, anything else is a server fault.
func (h *BotHandler) writeLookupError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "bot or token not found")
		return
	}
	writeInternalError(w, r, "bot_error", err)
}
