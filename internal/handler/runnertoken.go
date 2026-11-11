package handler

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
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
	svc  *agents.RunnerTokenService
	live liveRunnerLister
}

// liveRunnerLister is the AgentService slice that says which runner
// processes hold a live lease.
type liveRunnerLister interface {
	LiveRunners(ctx context.Context, userID string) ([]*model.RunnerRegistration, error)
}

// SetLiveRunners lets the list say which installs are online right now.
// Optional: without it every install lists as offline.
func (h *RunnerTokenHandler) SetLiveRunners(l liveRunnerLister) { h.live = l }

// NewRunnerTokenHandler wires the handler.
func NewRunnerTokenHandler(svc *agents.RunnerTokenService) *RunnerTokenHandler {
	return &RunnerTokenHandler{svc: svc}
}

// Checker exposes the service as the runner middleware's per-request check.
func (h *RunnerTokenHandler) Checker() middleware.RunnerTokenChecker {
	if h == nil || h.svc == nil {
		return nil
	}
	return runnerChecker{svc: h.svc}
}

// runnerChecker adapts the service to the middleware: the service's refusals
// become the statuses and codes the error table gives them everywhere else
// (runner_disconnected, runner_clock_skew, runner_upgrade_required); anything
// unmapped is a failed check (503).
type runnerChecker struct{ svc *agents.RunnerTokenService }

func (c runnerChecker) CheckRunner(ctx context.Context, claims *model.TokenClaims, req middleware.RunnerRequest) error {
	err := c.svc.AuthorizeRunner(ctx, claims, agents.RunnerRequest(req))
	if err == nil {
		return nil
	}
	if m, ok := lookupError(err); ok {
		return &middleware.RunnerRefusal{Status: m.status, Code: m.code, Message: m.text(err)}
	}
	return err
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
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"code": code, "expiresAt": expiresAt})
}

type runnerExchangeBody struct {
	Code     string `json:"code"`
	Verifier string `json:"verifier"`
	// DeviceKey is the public half of the key the runner made at sign-in;
	// absent from runners that predate device keys.
	DeviceKey *agents.RunnerDeviceKey `json:"deviceKey"`
}

// Exchange POST /api/v1/runner-tokens/exchange
func (h *RunnerTokenHandler) Exchange(w http.ResponseWriter, r *http.Request) {
	var body runnerExchangeBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	issued, err := h.svc.Exchange(r.Context(), body.Code, body.Verifier, body.DeviceKey)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, issued)
}

// runnerTokenView is the Runners page shape — never the token or its key.
// The live fields come from the newest runner process signed in with this
// install; they are empty while it is offline.
type runnerTokenView struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	LastIP     string     `json:"lastIP,omitempty"`
	// DeviceKey says what the install is locked to: "hardware" (the
	// computer's secure chip), "software" (a key file), "" (nothing yet — an
	// ex-runner that predates device keys).
	DeviceKey string                `json:"deviceKey"`
	Online    bool                  `json:"online"`
	OS        string                `json:"os,omitempty"`
	Version   string                `json:"version,omitempty"`
	Harnesses []model.RunnerHarness `json:"harnesses,omitempty"`
}

func viewRunnerToken(t *model.RunnerToken, live *model.RunnerRegistration) runnerTokenView {
	v := runnerTokenView{ID: t.ID, Label: t.Label, CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt, LastIP: t.LastIP}
	if !t.LastUsedAt.IsZero() {
		at := t.LastUsedAt
		v.LastUsedAt = &at
	}
	switch {
	case t.DeviceKey == "":
	case t.DeviceKeyHardware:
		v.DeviceKey = "hardware"
	default:
		v.DeviceKey = "software"
	}
	if live != nil {
		v.Online, v.OS, v.Version, v.Harnesses = true, live.OS, live.Version, live.Harnesses
	}
	return v
}

// liveByToken maps each install to its newest live runner process. A
// failed lookup lists everything as offline rather than failing the page —
// disconnecting a computer must keep working.
func (h *RunnerTokenHandler) liveByToken(r *http.Request, userID string) map[string]*model.RunnerRegistration {
	out := map[string]*model.RunnerRegistration{}
	if h.live == nil {
		return out
	}
	regs, err := h.live.LiveRunners(r.Context(), userID)
	if err != nil {
		slog.WarnContext(r.Context(), "runners: live lookup failed; listing as offline", "error", err)
		return out
	}
	for _, reg := range regs {
		if reg.TokenID == "" {
			continue
		}
		if cur := out[reg.TokenID]; cur == nil || reg.LeaseExpiresAt.After(cur.LeaseExpiresAt) {
			out[reg.TokenID] = reg
		}
	}
	return out
}

// List GET /api/v1/runner-tokens
func (h *RunnerTokenHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	toks, err := h.svc.List(r.Context(), userID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	live := h.liveByToken(r, userID)
	views := make([]runnerTokenView, 0, len(toks))
	for _, t := range toks {
		views = append(views, viewRunnerToken(t, live[t.ID]))
	}
	writeJSON(w, http.StatusOK, JSON{"runners": views})
}

// Revoke DELETE /api/v1/runner-tokens/{id}
func (h *RunnerTokenHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Revoke(r.Context(), middleware.UserIDFromContext(r.Context()), r.PathValue("id")); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Renew POST /api/v1/agent/runner/renew
func (h *RunnerTokenHandler) Renew(w http.ResponseWriter, r *http.Request) {
	issued, err := h.svc.Renew(r.Context(), middleware.ClaimsFromContext(r.Context()))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"token": issued.Token, "expiresAt": issued.ExpiresAt})
}

// RevokeSelf POST /api/v1/agent/runner/revoke
func (h *RunnerTokenHandler) RevokeSelf(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.RevokeSelf(r.Context(), middleware.ClaimsFromContext(r.Context())); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
