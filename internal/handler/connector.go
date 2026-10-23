package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

// liveRunGetter is the orchestrator slice used to read a run's connector
// picks, attach agent-requested connectors, and verify approvals.
type liveRunGetter interface {
	GetLiveRun(ctx context.Context, runID string) (*model.Run, error)
	AttachConnector(ctx context.Context, runID, slug, reason string) error
	RequestApproval(ctx context.Context, run *model.Run, req agents.ApprovalRequest) (*model.Approval, error)
	ApprovalGranted(ctx context.Context, runID, approvalID, purpose string) (*model.Approval, bool)
}

// ConnectorHandler serves the connector registry: listing (any user),
// ingest (admin), install/uninstall (per-user credential), and the
// runner-facing payload that ships docs + tokens to the invoker's machine.
type ConnectorHandler struct {
	connectors *agents.ConnectorService
	runs       liveRunGetter
}

func NewConnectorHandler(c *agents.ConnectorService, runs liveRunGetter) *ConnectorHandler {
	return &ConnectorHandler{connectors: c, runs: runs}
}

// List returns every connector with the caller's install status.
func (h *ConnectorHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	rows, err := h.connectors.ListForUser(r.Context(), claims.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"connectors": rows})
}

// Ingest registers or replaces a connector (route is admin-gated).
func (h *ConnectorHandler) Ingest(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var in agents.IngestInput
	if err := readAgentJSON(r, &in, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	c, err := h.connectors.Ingest(r.Context(), claims.UserID, in)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"connector": c})
}

// Sync pulls the connector catalog from the connector-provider and ingests it
// into the registry (admin-gated at the route). Replaces the old sync script.
func (h *ConnectorHandler) Sync(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	// force: an admin pressing sync means "pull it all now" — including
	// registration-only changes, which carry no revision bump.
	res, err := h.connectors.SyncFromProvider(r.Context(), claims.UserID, true)
	if err != nil {
		writeServiceError(w, r, err)
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
	var in agents.InstallInput
	if err := readAgentJSON(r, &in, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	inst, err := h.connectors.Install(r.Context(), claims.UserID, slug, in)
	if err != nil {
		// Includes the 2FA challenge: it carries an access code the client
		// must echo back (writeServiceError keeps its shape).
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"install": inst})
}

// Uninstall disconnects the caller from a connector.
func (h *ConnectorHandler) Uninstall(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if err := h.connectors.Uninstall(r.Context(), claims.UserID, r.PathValue("slug")); err != nil {
		writeServiceError(w, r, err)
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
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if err := h.connectors.SetAgentUse(r.Context(), claims.UserID, r.PathValue("slug"), body.AgentUse); err != nil {
		writeServiceError(w, r, err)
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
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"install": inst})
}

// UseConnector is the agent-initiated attach (the use_connector tool).
// Run-token scoped. Policy comes from the INVOKER's install:
//
//	never  → refused outright
//	always → attached immediately
//	ask    → first call raises the approval card HERE and returns
//	         {status:"ask", approvalID}; the runner waits for the decision and
//	         calls again with that id, which is verified by PURPOSE before
//	         attaching. The server owning both ends is what makes the check
//	         sound: the model neither writes the card's text nor picks which
//	         approval counts.
func (h *ConnectorHandler) UseConnector(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var body struct {
		Connector  string `json:"connector"`
		Reason     string `json:"reason"`
		ApprovalID string `json:"approvalID"`
	}
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || body.Connector == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "connector required")
		return
	}
	run, err := h.runs.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	policy, title, err := h.connectors.AgentUsePolicy(r.Context(), run.InvokerID, body.Connector)
	if errors.Is(err, apperr.ErrNotFound) {
		writeJSON(w, http.StatusOK, JSON{"status": "denied",
			"message": "the invoker has not installed this connector — tell them to install it on the Connectors page"})
		return
	}
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	attach := func() {
		if err := h.runs.AttachConnector(r.Context(), claims.RunID, body.Connector, body.Reason); err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, JSON{"status": "attached", "title": title})
	}
	// Already attached (a retried call after the approval was spent): say so
	// rather than asking for — or refusing — the same connector twice.
	for _, s := range run.ConnectorSlugs {
		if s == body.Connector {
			writeJSON(w, http.StatusOK, JSON{"status": "attached", "title": title})
			return
		}
	}
	// A run acting on someone else's words never attaches a credential on
	// its own: even an "always" connector goes through the invoker's card.
	if policy == model.ConnectorAgentUseAlways && run.UntrustedTrigger {
		policy = model.ConnectorAgentUseAsk
	}
	switch policy {
	case model.ConnectorAgentUseNever:
		writeJSON(w, http.StatusOK, JSON{"status": "denied",
			"message": "the invoker only allows this connector via an explicit /pick — do not work around this"})
	case model.ConnectorAgentUseAlways:
		attach()
	default: // ask
		purpose := model.ApprovalPurposeConnector(body.Connector)
		ask := func() {
			summary := "Use the " + title + " connector (" + body.Connector + ") for this task"
			if reason := strings.TrimSpace(body.Reason); reason != "" {
				summary += ": " + reason
			}
			a, err := h.runs.RequestApproval(r.Context(), run, agents.ApprovalRequest{
				Summary: summary, Purpose: purpose,
			})
			if err != nil {
				// The run is too near its deadline to wait for a human, or the
				// gate could not be stored — either way it is not authorized.
				writeJSON(w, http.StatusOK, JSON{"status": "ask", "title": title})
				return
			}
			writeJSON(w, http.StatusOK, JSON{"status": "ask", "title": title,
				"approvalID": a.ID, "summary": a.Summary, "deadline": a.Deadline})
		}
		if body.ApprovalID == "" {
			ask()
			return
		}
		if a, ok := h.runs.ApprovalGranted(r.Context(), claims.RunID, body.ApprovalID, purpose); !ok {
			// A card the agent raised itself proves nothing about THIS
			// connector: ask again with the server's own card.
			if agents.LegacyApproval(a) {
				ask()
				return
			}
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
	// The run's explicit picks decide the set, and they are resolved FIRST so
	// only those bundles are ever read. No picks → no connectors: the user
	// decides which services a run may touch, not the agent.
	var picks []string
	if h.runs != nil {
		if run, err := h.runs.GetLiveRun(r.Context(), claims.RunID); err == nil {
			picks = run.ConnectorSlugs
		}
	}
	rows, err := h.connectors.ForRunner(r.Context(), claims.UserID, picks)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if rows == nil {
		rows = []agents.RunnerConnector{}
	}
	writeJSON(w, http.StatusOK, JSON{"connectors": rows})
}
