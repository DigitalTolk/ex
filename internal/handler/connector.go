package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// liveRunGetter is the orchestrator slice used to read a run's connector
// picks, attach agent-requested connectors, and verify approvals.
type liveRunGetter interface {
	GetLiveRun(ctx context.Context, runID string) (*model.Run, error)
	AttachConnector(ctx context.Context, runID, slug, reason string) error
	ApprovalStatus(ctx context.Context, runID, approvalID string) (*model.Approval, error)
}

// ConnectorHandler serves the connector registry: listing (any user),
// ingest (admin), install/uninstall (per-user credential), and the
// runner-facing payload that ships docs + tokens to the invoker's machine.
type ConnectorHandler struct {
	connectors *service.ConnectorService
	runs       liveRunGetter
}

func NewConnectorHandler(c *service.ConnectorService, runs liveRunGetter) *ConnectorHandler {
	return &ConnectorHandler{connectors: c, runs: runs}
}

// List returns every connector with the caller's install status.
func (h *ConnectorHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	rows, err := h.connectors.ListForUser(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to list connectors")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"connectors": rows})
}

// Ingest registers or replaces a connector (route is admin-gated).
func (h *ConnectorHandler) Ingest(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var in service.IngestInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	c, err := h.connectors.Ingest(r.Context(), claims.UserID, in)
	if err != nil {
		if errors.Is(err, service.ErrConnectorInvalid) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "failed to ingest connector")
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"connector": c})
}

// Sync pulls the connector catalog from the connector-provider and ingests it
// into the registry (admin-gated at the route). Replaces the old sync script.
func (h *ConnectorHandler) Sync(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	res, err := h.connectors.SyncFromProvider(r.Context(), claims.UserID)
	if err != nil {
		if errors.Is(err, service.ErrConnectorInvalid) {
			writeError(w, http.StatusServiceUnavailable, "no_provider", "no connector provider configured")
			return
		}
		writeError(w, http.StatusBadGateway, "provider_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, JSON{"synced": res.Synced, "skipped": res.Skipped})
}

// Install connects the caller: paste-a-token, or email/password for
// password-kind connectors (with a two-factor round trip when the auth
// service demands one).
func (h *ConnectorHandler) Install(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	slug := r.PathValue("slug")
	var in service.InstallInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	inst, err := h.connectors.Install(r.Context(), claims.UserID, slug, in)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "not_found", "connector not found")
		case errors.Is(err, service.ErrTwoFactorRequired):
			// 409 + accessCode: the client re-submits with the 2FA code.
			writeJSON(w, http.StatusConflict, JSON{
				"error":      "two_factor_required",
				"accessCode": service.TwoFactorAccessCode(err),
			})
		case errors.Is(err, service.ErrTokenRejected):
			writeError(w, http.StatusUnauthorized, "token_rejected", "the service rejected that token")
		case errors.Is(err, service.ErrLoginFailed):
			writeError(w, http.StatusUnauthorized, "login_failed", err.Error())
		case errors.Is(err, service.ErrConnectorInvalid):
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "internal", "failed to install connector")
		}
		return
	}
	writeJSON(w, http.StatusOK, JSON{"install": inst})
}

// Uninstall disconnects the caller from a connector.
func (h *ConnectorHandler) Uninstall(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if err := h.connectors.Uninstall(r.Context(), claims.UserID, r.PathValue("slug")); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to uninstall")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UpdateInstall changes install settings — today just agentUse (may agents
// attach this connector themselves: ask | always | never).
func (h *ConnectorHandler) UpdateInstall(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var body struct {
		AgentUse string `json:"agentUse"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if err := h.connectors.SetAgentUse(r.Context(), claims.UserID, r.PathValue("slug"), body.AgentUse); err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "not_found", "connector not installed")
		case errors.Is(err, service.ErrConnectorInvalid):
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "internal", "failed to update install")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// VerifyInstall re-checks an install's credential against the service (for
// "unverified" installs saved while the service was unreachable).
func (h *ConnectorHandler) VerifyInstall(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	inst, err := h.connectors.VerifyInstall(r.Context(), claims.UserID, r.PathValue("slug"))
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "not_found", "connector not installed")
		case errors.Is(err, service.ErrTokenRejected):
			writeError(w, http.StatusUnauthorized, "token_rejected", "the service rejected the stored token — reconnect with a fresh one")
		case errors.Is(err, service.ErrLoginFailed):
			writeError(w, http.StatusBadGateway, "unreachable", "the service is unreachable right now — still unverified")
		default:
			writeError(w, http.StatusInternalServerError, "internal", "verify failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, JSON{"install": inst})
}

// UseConnector is the agent-initiated attach (the use_connector tool).
// Run-token scoped. Policy comes from the INVOKER's install:
//   never  → refused outright
//   always → attached immediately
//   ask    → first call returns {status:"ask"}; the runner raises a normal
//            approval card, then calls again with the approvalID, which is
//            verified server-side before attaching.
func (h *ConnectorHandler) UseConnector(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var body struct {
		Connector  string `json:"connector"`
		Reason     string `json:"reason"`
		ApprovalID string `json:"approvalID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Connector == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "connector required")
		return
	}
	run, err := h.runs.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		writeError(w, http.StatusConflict, "run_closed", "this run is no longer live")
		return
	}
	policy, title, err := h.connectors.AgentUsePolicy(r.Context(), run.InvokerID, body.Connector)
	if err != nil {
		writeJSON(w, http.StatusOK, JSON{"status": "denied",
			"message": "the invoker has not installed this connector — tell them to install it on the Connectors page"})
		return
	}
	attach := func() {
		if err := h.runs.AttachConnector(r.Context(), claims.RunID, body.Connector, body.Reason); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "failed to attach connector")
			return
		}
		writeJSON(w, http.StatusOK, JSON{"status": "attached", "title": title})
	}
	switch policy {
	case model.ConnectorAgentUseNever:
		writeJSON(w, http.StatusOK, JSON{"status": "denied",
			"message": "the invoker only allows this connector via an explicit /pick — do not work around this"})
	case model.ConnectorAgentUseAlways:
		attach()
	default: // ask
		if body.ApprovalID == "" {
			writeJSON(w, http.StatusOK, JSON{"status": "ask", "title": title})
			return
		}
		a, err := h.runs.ApprovalStatus(r.Context(), claims.RunID, body.ApprovalID)
		if err != nil || a.State != model.ApprovalApproved || !strings.Contains(a.Summary, body.Connector) {
			writeJSON(w, http.StatusOK, JSON{"status": "denied",
				"message": "the invoker did not approve using this connector"})
			return
		}
		attach()
	}
}

// RunnerConnectors ships the run's connectors (docs + tokens) to the runner.
// Run-token scoped: claims.UserID is the run's INVOKER, so a run only ever
// sees the connectors of the person it acts for — and only the ones the
// invoking message explicitly picked with /connector tokens.
func (h *ConnectorHandler) RunnerConnectors(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	rows, err := h.connectors.ForRunner(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load connectors")
		return
	}
	// Filter to the run's explicit picks. No picks → no connectors: the user
	// decides which services a run may touch, not the agent.
	picked := map[string]bool{}
	if h.runs != nil {
		if run, err := h.runs.GetLiveRun(r.Context(), claims.RunID); err == nil {
			for _, slug := range run.ConnectorSlugs {
				picked[slug] = true
			}
		}
	}
	out := rows[:0]
	for _, row := range rows {
		if picked[row.Slug] {
			out = append(out, row)
		}
	}
	writeJSON(w, http.StatusOK, JSON{"connectors": out})
}
