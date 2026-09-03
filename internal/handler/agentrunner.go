package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// maxClaimWait caps the claim long-poll well below the global 30s request
// timeout (plan-v2 §5 — do not go near it).
const maxClaimWait = 20 * time.Second

// AgentRunnerHandler serves the desktop runner's API. Every route sits
// behind AuthScope(runner): claims.UserID is the runner's OWNER.
type AgentRunnerHandler struct {
	agents *service.AgentService
	orch   *service.Orchestrator
}

// NewAgentRunnerHandler wires the handler.
func NewAgentRunnerHandler(agents *service.AgentService, orch *service.Orchestrator) *AgentRunnerHandler {
	return &AgentRunnerHandler{agents: agents, orch: orch}
}

type runnerRegisterBody struct {
	RunnerID  string                `json:"runnerID"`
	Host      string                `json:"host"`
	OS        string                `json:"os"`
	Harnesses []model.RunnerHarness `json:"harnesses"`
}

func (b *runnerRegisterBody) registration(ownerID string) *model.RunnerRegistration {
	return &model.RunnerRegistration{
		RunnerID:  b.RunnerID,
		OwnerID:   ownerID,
		Host:      b.Host,
		OS:        b.OS,
		Harnesses: b.Harnesses,
		CreatedAt: time.Now(),
	}
}

// Register announces a runner. The shared agents (gg/qib) exist workspace-
// wide already — registering just makes them AVAILABLE to this user, since
// runs execute on the invoker's own machine.
// POST /api/v1/agent/runner/register
func (h *AgentRunnerHandler) Register(w http.ResponseWriter, r *http.Request) {
	ownerID := middleware.UserIDFromContext(r.Context())
	var body runnerRegisterBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RunnerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "runnerID required")
		return
	}
	if _, err := h.orch.Heartbeat(r.Context(), body.registration(ownerID), nil); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "registration failed")
		return
	}
	agents, err := h.agents.ListAgents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "agent list failed")
		return
	}
	views := make([]JSON, 0, len(agents))
	for _, a := range agents {
		views = append(views, JSON{"id": a.ID, "displayName": a.DisplayName, "slug": a.AgentConfig.TemplateSlug})
	}
	writeJSON(w, http.StatusOK, JSON{"runnerID": body.RunnerID, "agents": views, "leaseSec": 60})
}

type claimBody struct {
	RunnerID  string   `json:"runnerID"`
	Harnesses []string `json:"harnesses"`
	Max       int      `json:"max"`
	WaitSec   int      `json:"waitSec"`
}

// Claim long-polls for work. 200 with assignments, or 204 when the wait
// budget lapses empty.
// POST /api/v1/agent/runner/claim
func (h *AgentRunnerHandler) Claim(w http.ResponseWriter, r *http.Request) {
	ownerID := middleware.UserIDFromContext(r.Context())
	var body claimBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RunnerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "runnerID required")
		return
	}
	wait := time.Duration(body.WaitSec) * time.Second
	if wait <= 0 || wait > maxClaimWait {
		wait = maxClaimWait
	}
	assignments, err := h.orch.Claim(r.Context(), ownerID, body.RunnerID, body.Harnesses, body.Max, wait)
	if err != nil {
		if errors.Is(err, r.Context().Err()) {
			return // client went away mid-poll
		}
		writeError(w, http.StatusInternalServerError, "internal", "claim failed")
		return
	}
	if len(assignments) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"assignments": assignments})
}

type runnerEventsBody struct {
	RunnerID string                  `json:"runnerID"`
	Events   []service.RunEventInput `json:"events"`
}

// Events ingests a runner batch for one run. The response tells the runner
// whether to abort (limit tripped / run closed).
// POST /api/v1/agent/runner/runs/{id}/events
func (h *AgentRunnerHandler) Events(w http.ResponseWriter, r *http.Request) {
	var body runnerEventsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RunnerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "runnerID required")
		return
	}
	abort, reason, err := h.orch.ReportEvents(r.Context(), body.RunnerID, r.PathValue("id"), body.Events)
	if err != nil && !abort {
		h.writeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"abort": abort, "reason": reason})
}

type completeBody struct {
	RunnerID  string         `json:"runnerID"`
	FinalText string         `json:"finalText"`
	Usage     map[string]any `json:"usage"`
}

// Complete finalizes a run.
// POST /api/v1/agent/runner/runs/{id}/complete
func (h *AgentRunnerHandler) Complete(w http.ResponseWriter, r *http.Request) {
	var body completeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RunnerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "runnerID required")
		return
	}
	if err := h.orch.CompleteRun(r.Context(), body.RunnerID, r.PathValue("id"), body.FinalText, body.Usage); err != nil {
		h.writeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

type failBody struct {
	RunnerID string `json:"runnerID"`
	Reason   string `json:"reason"`
}

// Fail records a runner-side failure.
// POST /api/v1/agent/runner/runs/{id}/fail
func (h *AgentRunnerHandler) Fail(w http.ResponseWriter, r *http.Request) {
	var body failBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RunnerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "runnerID required")
		return
	}
	reason := body.Reason
	if reason == "" {
		reason = "runner_error"
	}
	if err := h.orch.FailRun(r.Context(), body.RunnerID, r.PathValue("id"), reason); err != nil {
		h.writeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

type heartbeatBody struct {
	runnerRegisterBody
	ActiveRunIDs []string `json:"activeRunIDs"`
}

// Heartbeat refreshes the runner + run leases; the response lists runs the
// runner must kill (terminal server-side).
// POST /api/v1/agent/runner/heartbeat
func (h *AgentRunnerHandler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	ownerID := middleware.UserIDFromContext(r.Context())
	var body heartbeatBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RunnerID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "runnerID required")
		return
	}
	kill, err := h.orch.Heartbeat(r.Context(), body.registration(ownerID), body.ActiveRunIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "heartbeat failed")
		return
	}
	if kill == nil {
		kill = []string{} // nil marshals as JSON null, which breaks iteration client-side
	}
	writeJSON(w, http.StatusOK, JSON{"kill": kill})
}

func (h *AgentRunnerHandler) writeRunError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "run not found")
	case errors.Is(err, service.ErrRunClosed):
		writeError(w, http.StatusConflict, "run_closed", "run reached a terminal state")
	case errors.Is(err, service.ErrWrongRunner):
		writeError(w, http.StatusConflict, "wrong_runner", "run is leased to another runner")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "run update failed")
	}
}

// ---------------------------------------------------------------------------
// Run-tool API: what the local MCP server calls, authenticated by the
// run-scoped token (claims: UserID = invoker, ActorID = agent, RunID).
// ---------------------------------------------------------------------------

// AgentRunToolHandler serves MCP tool calls for live runs.
type AgentRunToolHandler struct {
	orch     *service.Orchestrator
	messages *service.MessageService
	ctxSvc   *service.ContextService
	agents   *service.AgentService
	// workspace carries the Ex-wide tool dependencies (channels, DMs,
	// search); nil until SetWorkspace — the router only registers the
	// workspace routes when set.
	workspace *AgentWorkspaceDeps

	// baseURL is the workspace's public origin (BASE_URL), used to build
	// clickable message permalinks for the link_message tool. Empty disables
	// link building (the tool returns the raw ref instead).
	baseURL string

	// Post idempotency: (runID, key) → message ID. In-memory is honest for a
	// single-instance server; entries die with the run's natural horizon.
	mu    sync.Mutex
	posts map[string]string
}

// SetBaseURL wires the public origin used to build message permalinks.
func (h *AgentRunToolHandler) SetBaseURL(u string) { h.baseURL = strings.TrimRight(u, "/") }

// NewAgentRunToolHandler wires the handler.
func NewAgentRunToolHandler(orch *service.Orchestrator, messages *service.MessageService, ctxSvc *service.ContextService, agents *service.AgentService) *AgentRunToolHandler {
	return &AgentRunToolHandler{orch: orch, messages: messages, ctxSvc: ctxSvc, agents: agents, posts: make(map[string]string)}
}

type postMessageBody struct {
	Body           string `json:"body"`
	IdempotencyKey string `json:"idempotencyKey"`
}

// PostMessage posts into the run's thread as the agent, capped per run.
// POST /api/v1/agent/run/messages
func (h *AgentRunToolHandler) PostMessage(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body postMessageBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "body required")
		return
	}
	if model.WatchModePostsPrivately(run.ActionMode) {
		writeError(w, http.StatusForbidden, "notify_only",
			"this watcher is "+run.ActionMode+"-only and can't post publicly — use notify_owner to message your creator")
		return
	}
	if !h.replyApprovalOK(w, r.Context(), run) {
		return
	}
	if run.Spend.Posts >= run.Limits.MaxPosts {
		writeError(w, http.StatusTooManyRequests, "post_cap", "per-run post cap reached")
		return
	}
	if body.IdempotencyKey != "" {
		h.mu.Lock()
		if msgID, ok := h.posts[claims.RunID+"#"+body.IdempotencyKey]; ok {
			h.mu.Unlock()
			writeJSON(w, http.StatusOK, JSON{"messageID": msgID, "deduped": true})
			return
		}
		h.mu.Unlock()
	}
	threadRoot := run.ThreadRootID
	if threadRoot == "" {
		threadRoot = run.MessageID
	}
	// Models write plain "@qib"; rewrite to real mention markup so it renders
	// as a chip AND can hand the turn to that agent (chain below).
	text := h.orch.LinkifyMentions(r.Context(), run, body.Body)
	msg, err := h.messages.SendAsAgentRun(r.Context(), claims.ActorID, claims.UserID, run.ParentID, run.ParentType, text, threadRoot, claims.RunID)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "post rejected")
		return
	}
	if body.IdempotencyKey != "" {
		h.mu.Lock()
		h.posts[claims.RunID+"#"+body.IdempotencyKey] = msg.ID
		h.mu.Unlock()
	}
	remaining, err := h.orch.RecordAgentPost(r.Context(), claims.RunID)
	if err != nil {
		remaining = 0
	}
	// Mention-gated agent-to-agent handoff: @mentions of OTHER agents in this
	// post start their turn (bounded by round cap + per-thread dedup).
	h.orch.ChainFromAgentPost(r.Context(), run, msg)
	writeJSON(w, http.StatusOK, JSON{"messageID": msg.ID, "remainingPosts": remaining})
}

// GetThread returns the run's thread window in bundle format — same [m:<id>]
// labels the context bundle uses, read as the invoker.
// GET /api/v1/agent/run/thread
func (h *AgentRunToolHandler) GetThread(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	text := h.orch.ThreadWindow(r.Context(), run, 50)
	writeJSON(w, http.StatusOK, JSON{"text": text})
}

// GetContext re-assembles the full layered bundle fresh — the get_context
// tool for long runs whose claim-time bundle went stale (plan-v2 §8).
// GET /api/v1/agent/run/context
func (h *AgentRunToolHandler) GetContext(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"text": h.orch.BundleForRun(r.Context(), run)})
}

type writeContextBody struct {
	Body   string `json:"body"`
	Pinned bool   `json:"pinned"`
}

// WriteContext appends a shared-context item as the agent, gated by the
// INVOKER's access and audited on the run timeline.
// POST /api/v1/agent/run/context
func (h *AgentRunToolHandler) WriteContext(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body writeContextBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	item, err := h.ctxSvc.Write(r.Context(), claims.ActorID, claims.UserID, claims.UserID, run.ParentID, run.ParentType, body.Body, body.Pinned)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrValidation):
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		case errors.Is(err, service.ErrContextFull):
			writeError(w, http.StatusTooManyRequests, "context_full", "shared context is full for this channel")
		case errors.Is(err, service.ErrForbidden):
			writeError(w, http.StatusForbidden, "forbidden", "no access to this channel")
		default:
			writeError(w, http.StatusInternalServerError, "internal", "context write failed")
		}
		return
	}
	h.orch.RecordContextWrite(r.Context(), run, item.ID, item.Pinned)
	writeJSON(w, http.StatusOK, JSON{"itemID": item.ID})
}

type requestApprovalBody struct {
	Summary string   `json:"summary"`
	Risk    string   `json:"risk"`
	Options []string `json:"options"`
	// ToolKind: the harness tool class for permission-gateway approvals
	// (read | edit | shell | web) — enables "always allow" on the card.
	ToolKind string `json:"toolKind"`
}

// RequestApproval opens a blocking human-in-the-loop gate. The MCP server
// polls GetApproval until it settles (plan-v2 §7 approval timing).
// POST /api/v1/agent/run/approvals
func (h *AgentRunToolHandler) RequestApproval(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body requestApprovalBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	a, err := h.orch.RequestApprovalKind(r.Context(), run, body.Summary, body.Risk, body.Options, body.ToolKind)
	if err != nil {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "approval request failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"approvalID": a.ID, "deadline": a.Deadline})
}

// GetApproval reports an approval's current state (the poll target).
// GET /api/v1/agent/run/approvals/{id}
func (h *AgentRunToolHandler) GetApproval(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	a, err := h.orch.ApprovalStatus(r.Context(), claims.RunID, r.PathValue("id"))
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"state": a.State, "decidedBy": a.DecidedBy, "choice": a.Choice, "note": a.Note, "deadline": a.Deadline})
}

type publishArtifactBody struct {
	Kind    string `json:"kind"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

// PublishArtifact stores a run-produced document, viewable in the drawer.
// POST /api/v1/agent/run/artifacts
func (h *AgentRunToolHandler) PublishArtifact(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body publishArtifactBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	a, err := h.orch.PublishArtifact(r.Context(), run, body.Kind, body.Title, body.Content)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrValidation):
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		case errors.Is(err, service.ErrArtifactCap):
			writeError(w, http.StatusTooManyRequests, "artifact_cap", "per-run artifact cap reached")
		default:
			writeError(w, http.StatusInternalServerError, "internal", "artifact publish failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, JSON{"artifactID": a.ID})
}

// ListSkills returns the workspace skill directory (id/name/description —
// instructions come from InvokeSkill, so listing stays cheap).
// GET /api/v1/agent/run/skills
func (h *AgentRunToolHandler) ListSkills(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, err)
		return
	}
	skills, err := h.agents.ListSkills(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "skill list failed")
		return
	}
	out := make([]JSON, 0, len(skills))
	for _, sk := range skills {
		out = append(out, JSON{"id": sk.ID, "name": sk.Name, "description": sk.Description})
	}
	writeJSON(w, http.StatusOK, JSON{"skills": out})
}

// InvokeSkill returns a skill's instructions and audits the use.
// POST /api/v1/agent/run/skills/{id}
func (h *AgentRunToolHandler) InvokeSkill(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	sk, err := h.agents.GetSkill(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "unknown skill")
		return
	}
	h.orch.RecordSkillInvoked(r.Context(), run, sk)
	writeJSON(w, http.StatusOK, JSON{"name": sk.Name, "instructions": sk.Instructions})
}

type updateMemoryBody struct {
	Content string `json:"content"`
}

// UpdateMemory replaces the agent's core memory for THIS invoker (injected
// into every future bundle for this pairing).
// POST /api/v1/agent/run/memory
func (h *AgentRunToolHandler) UpdateMemory(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body updateMemoryBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if err := h.agents.UpdateMemory(r.Context(), claims.UserID, claims.ActorID, body.Content); err != nil {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "memory update failed")
		return
	}
	h.orch.RecordMemoryUpdate(r.Context(), run, len(body.Content))
	writeJSON(w, http.StatusOK, JSON{"ok": true, "bytes": len(body.Content)})
}

type claimTaskBody struct {
	Label string `json:"label"`
}

// ClaimTask atomically claims one part of a co-invoked task (first write
// wins) so parallel agents can split work without racing.
// POST /api/v1/agent/run/claims
func (h *AgentRunToolHandler) ClaimTask(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body claimTaskBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	mine, lines, err := h.orch.ClaimTask(r.Context(), run, body.Label)
	if err != nil {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "claim failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"mine": mine, "claims": lines})
}

type setStateBody struct {
	State string `json:"state"`
}

// SetState drives the machine state reaction from the MCP set_state tool.
// POST /api/v1/agent/run/state
func (h *AgentRunToolHandler) SetState(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var body setStateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if err := h.orch.SetRunState(r.Context(), claims.RunID, body.State); err != nil {
		h.writeToolError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

func (h *AgentRunToolHandler) writeToolError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "run not found")
	case errors.Is(err, service.ErrRunClosed):
		writeError(w, http.StatusConflict, "run_closed", "run reached a terminal state")
	default:
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	}
}

// ProposeReply drafts an editable reply the invoker can approve, edit, or
// cancel (the reply-mode watcher path). The agent doesn't post — on approval
// the server posts the (possibly edited) text. Fire-and-forget: the run may end.
// POST /api/v1/agent/run/propose-reply
func (h *AgentRunToolHandler) ProposeReply(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body struct {
		Text       string `json:"text"`
		ThreadRoot string `json:"thread_root"`
		ReplyTo    string `json:"reply_to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Text) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "text (the drafted reply) required")
		return
	}
	a, err := h.orch.ProposeReply(r.Context(), run, body.Text, body.ThreadRoot, body.ReplyTo)
	if err != nil {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "propose reply failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"text": "Drafted the reply — your creator can approve, edit, or cancel it. (approvalID=" + a.ID + ")"})
}

// LinkMessage builds a clickable permalink to a message in this workspace, so
// an agent can reference a specific message instead of pasting an opaque
// [m:<id>] marker. The URL uses the workspace origin (BASE_URL) and the same
// grammar the client unfurls into a quoted-message card:
//
//	<base>/channel/<channelID>#msg-<id>   (optional ?thread=<root>)
//	<base>/conversation/<convID>#msg-<id>
//
// Defaults to the run's own parent when no target is given. Access is checked
// with the INVOKER's permissions — an agent can't mint a link into a channel
// its invoker can't see.
// POST /api/v1/agent/run/link-message
func (h *AgentRunToolHandler) LinkMessage(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body struct {
		MessageID      string `json:"message_id"`
		ChannelID      string `json:"channel_id"`
		ConversationID string `json:"conversation_id"`
		ThreadRoot     string `json:"thread_root"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.MessageID) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "message_id required")
		return
	}
	// Accept the [m:<id>] marker form too — agents copy these straight from the
	// context bundle, so strip the wrapper if present.
	msgID := strings.TrimSpace(body.MessageID)
	msgID = strings.TrimSuffix(strings.TrimPrefix(msgID, "[m:"), "]")
	msgID = strings.TrimPrefix(msgID, "m:")

	// Resolve the target parent: explicit channel/conversation, else the run's.
	var parentID, parentType, segment string
	switch {
	case strings.TrimSpace(body.ChannelID) != "":
		parentID, parentType, segment = trimMarker(body.ChannelID, "ch"), service.ParentChannel, "channel"
	case strings.TrimSpace(body.ConversationID) != "":
		parentID, parentType, segment = trimMarker(body.ConversationID, "c"), service.ParentConversation, "conversation"
	default:
		parentID, parentType = run.ParentID, run.ParentType
		if parentType == service.ParentConversation {
			segment = "conversation"
		} else {
			segment = "channel"
		}
	}
	if parentID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "no channel/conversation to link into")
		return
	}
	// The invoker must be able to see the parent — never mint a link into a
	// place the run's owner can't access.
	if err := h.messages.CheckAccess(r.Context(), claims.UserID, parentID, parentType); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "you can't link a message in that channel")
		return
	}
	if h.baseURL == "" {
		writeJSON(w, http.StatusOK, JSON{"text": "[m:" + msgID + "] in [" + segment[:2] + ":" + parentID + "]"})
		return
	}
	link := h.baseURL + "/" + segment + "/" + parentID
	if tr := trimMarker(body.ThreadRoot, "m"); tr != "" {
		link += "?thread=" + tr
	}
	link += "#msg-" + msgID
	writeJSON(w, http.StatusOK, JSON{"url": link, "text": link})
}

// trimMarker strips a bundle marker wrapper (`[<prefix>:<id>]` or `<prefix>:<id>`)
// down to the bare id, tolerating the raw id too.
func trimMarker(s, prefix string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	s = strings.TrimPrefix(s, prefix+":")
	return s
}
