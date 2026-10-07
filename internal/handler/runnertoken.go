package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// RunnerTokenHandler serves ex-runner pairing and the Runners page:
//
//	POST   /api/v1/runner-tokens/grants    session   browser approves a pairing → one-time code
//	POST   /api/v1/runner-tokens/exchange  public    CLI redeems code + PKCE verifier → runner token
//	GET    /api/v1/runner-tokens           session   the caller's connected runners
//	DELETE /api/v1/runner-tokens/{id}      session   disconnect one of them
//	POST   /api/v1/agent/runner/renew      runner    fresh expiry, same install
//	POST   /api/v1/agent/runner/revoke     runner    `ex-runner logout`
type RunnerTokenHandler struct {
	svc *service.RunnerTokenService
}

// NewRunnerTokenHandler wires the handler.
func NewRunnerTokenHandler(svc *service.RunnerTokenService) *RunnerTokenHandler {
	return &RunnerTokenHandler{svc: svc}
}

// Checker exposes the service as the runner middleware's revocation check.
func (h *RunnerTokenHandler) Checker() middleware.RunnerTokenChecker {
	if h == nil || h.svc == nil {
		return nil
	}
	return h.svc
}

type runnerGrantBody struct {
	Challenge string `json:"challenge"`
	Label     string `json:"label"`
}

// CreateGrant POST /api/v1/runner-tokens/grants
func (h *RunnerTokenHandler) CreateGrant(w http.ResponseWriter, r *http.Request) {
	var body runnerGrantBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	code, expiresAt, err := h.svc.CreateGrant(r.Context(), middleware.UserIDFromContext(r.Context()), body.Challenge, body.Label)
	if err != nil {
		writeRunnerTokenError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"code": code, "expiresAt": expiresAt})
}

type runnerExchangeBody struct {
	Code     string `json:"code"`
	Verifier string `json:"verifier"`
}

// Exchange POST /api/v1/runner-tokens/exchange
func (h *RunnerTokenHandler) Exchange(w http.ResponseWriter, r *http.Request) {
	var body runnerExchangeBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	issued, err := h.svc.Exchange(r.Context(), body.Code, body.Verifier)
	if err != nil {
		writeRunnerTokenError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, issued)
}

// runnerTokenView is the Runners page shape — never the token itself.
type runnerTokenView struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func viewRunnerToken(t *model.RunnerToken) runnerTokenView {
	return runnerTokenView{ID: t.ID, Label: t.Label, CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt}
}

// List GET /api/v1/runner-tokens
func (h *RunnerTokenHandler) List(w http.ResponseWriter, r *http.Request) {
	toks, err := h.svc.List(r.Context(), middleware.UserIDFromContext(r.Context()))
	if err != nil {
		writeInternalError(w, r, "list_error", err)
		return
	}
	views := make([]runnerTokenView, 0, len(toks))
	for _, t := range toks {
		views = append(views, viewRunnerToken(t))
	}
	writeJSON(w, http.StatusOK, JSON{"runners": views})
}

// Revoke DELETE /api/v1/runner-tokens/{id}
func (h *RunnerTokenHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Revoke(r.Context(), middleware.UserIDFromContext(r.Context()), r.PathValue("id")); err != nil {
		writeRunnerTokenError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Renew POST /api/v1/agent/runner/renew
func (h *RunnerTokenHandler) Renew(w http.ResponseWriter, r *http.Request) {
	issued, err := h.svc.Renew(r.Context(), middleware.ClaimsFromContext(r.Context()))
	if err != nil {
		writeRunnerTokenError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"token": issued.Token, "expiresAt": issued.ExpiresAt})
}

// RevokeSelf POST /api/v1/agent/runner/revoke
func (h *RunnerTokenHandler) RevokeSelf(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.RevokeSelf(r.Context(), middleware.ClaimsFromContext(r.Context())); err != nil {
		writeInternalError(w, r, "revoke_error", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeRunnerTokenError maps the pairing sentinels, then the shared table.
func writeRunnerTokenError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrRunnerGrantInvalid):
		writeError(w, http.StatusBadRequest, "invalid_grant", err.Error())
	case errors.Is(err, service.ErrRunnerTokenRevoked):
		writeError(w, http.StatusUnauthorized, "runner_disconnected", err.Error())
	default:
		if status, code, message, ok := serviceStatus(err); ok {
			writeError(w, status, code, message)
			return
		}
		writeInternalError(w, r, "runner_token_error", err)
	}
}
