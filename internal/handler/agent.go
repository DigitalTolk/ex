package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// runnerTokenTTL is the lifetime of a desktop-runner token. Long-lived by
// design (the runner is a background process), revocable by rotating the JWT
// secret at MVP; per-token revocation is a Phase-4 item.
const runnerTokenTTL = 30 * 24 * time.Hour

// timelineAccessChecker gates non-invoker reads of a run timeline by parent
// membership (the message-service check).
type timelineAccessChecker interface {
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// AgentHandler serves the SPA-facing agent surface: the shared agents with
// the caller's own preferences, runner-token minting, and run timelines.
type AgentHandler struct {
	agents *service.AgentService
	orch   *service.Orchestrator
	users  *service.UserService
	jwt    *auth.JWTManager
	access timelineAccessChecker
}

// NewAgentHandler wires the handler.
func NewAgentHandler(agents *service.AgentService, orch *service.Orchestrator, users *service.UserService, jwt *auth.JWTManager) *AgentHandler {
	return &AgentHandler{agents: agents, orch: orch, users: users, jwt: jwt}
}

// SetTimelineAccess widens Timeline reads from invoker-only to any member of
// the run's parent (plan-v2 Phase 2 — the drawer). Optional; nil keeps the
// Phase-1 invoker-only rule.
func (h *AgentHandler) SetTimelineAccess(a timelineAccessChecker) { h.access = a }

// agentView is the SPA shape for one shared agent as seen by the caller:
// the agent itself is workspace-wide; prefs/resolved/status are the
// caller's own.
type agentView struct {
	ID          string                     `json:"id"`
	DisplayName string                     `json:"displayName"`
	Slug        string                     `json:"slug"`
	Status      string                     `json:"status"` // per-caller availability
	Prefs       *model.UserAgentPrefs      `json:"prefs"`
	Resolved    *model.ResolvedAgentConfig `json:"resolved"`
}

func (h *AgentHandler) view(r *http.Request, agent *model.User, callerID string) (agentView, error) {
	slug := agent.AgentConfig.TemplateSlug
	prefs, err := h.agents.GetPrefs(r.Context(), callerID, slug)
	if err != nil {
		return agentView{}, err
	}
	resolved, err := h.agents.Resolve(r.Context(), agent, callerID)
	if err != nil {
		return agentView{}, err
	}
	// Availability is per-caller: runs execute on the CALLER's machine.
	status := model.AgentStatusOffline
	if runners, err := h.agents.LiveRunners(r.Context(), callerID); err == nil && len(runners) > 0 {
		if service.RunnerHasHarness(runners, resolved.Harness) {
			status = model.AgentStatusActive
		} else {
			status = model.AgentStatusNeedsSetup
		}
	}
	return agentView{
		ID:          agent.ID,
		DisplayName: agent.DisplayName,
		Slug:        slug,
		Status:      status,
		Prefs:       prefs,
		Resolved:    resolved,
	}, nil
}

// List returns the shared agents with the caller's prefs and availability.
// GET /api/v1/agents
type createAgentBody struct {
	Slug          string `json:"slug"`
	DisplayName   string `json:"displayName"`
	Harness       string `json:"harness"`
	Model         string `json:"model"`
	ExecutionMode string `json:"executionMode"`
	Persona       string `json:"persona"`
}

// CreateAgent defines a new shared agent (admin-only; the route is gated by
// RequireSystemRole(admin)).
// POST /api/v1/agents
func (h *AgentHandler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	var body createAgentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	tpl, err := h.agents.CreateAgent(r.Context(), service.CreateAgentInput{
		Slug:          body.Slug,
		DisplayName:   body.DisplayName,
		Harness:       body.Harness,
		Model:         body.Model,
		ExecutionMode: body.ExecutionMode,
		Persona:       body.Persona,
	})
	if err != nil {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "failed to create agent")
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"agent": tpl})
}

// RenameAgent changes a shared agent's display name. Admin-only.
// PATCH /api/v1/agents/{slug}
func (h *AgentHandler) RenameAgent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DisplayName string    `json:"displayName"`
		SkillIDs    *[]string `json:"skillIDs"` // nil = unchanged, [] = clear
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if body.DisplayName == "" && body.SkillIDs == nil {
		writeError(w, http.StatusBadRequest, "bad_request", "nothing to update — set displayName and/or skillIDs")
		return
	}
	fail := func(err error, what string) {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "unknown agent")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "failed to "+what)
	}
	var tpl *model.AgentTemplate
	var err error
	if body.DisplayName != "" {
		if tpl, err = h.agents.RenameAgent(r.Context(), r.PathValue("slug"), body.DisplayName); err != nil {
			fail(err, "rename agent")
			return
		}
	}
	if body.SkillIDs != nil {
		if tpl, err = h.agents.SetAgentSkills(r.Context(), r.PathValue("slug"), *body.SkillIDs); err != nil {
			fail(err, "set agent skills")
			return
		}
	}
	writeJSON(w, http.StatusOK, JSON{"agent": tpl})
}

func (h *AgentHandler) List(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	agents, err := h.agents.ListAgents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to list agents")
		return
	}
	out := make([]agentView, 0, len(agents))
	for _, a := range agents {
		v, err := h.view(r, a, callerID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "failed to resolve agent")
			return
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, JSON{"agents": out})
}

// UpdatePrefs applies the caller's edits to THEIR prefs for one agent.
// PATCH /api/v1/agents/{slug}/prefs
func (h *AgentHandler) UpdatePrefs(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	slug := r.PathValue("slug")
	var patch service.AgentPrefsPatch
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if _, err := h.agents.UpdatePrefs(r.Context(), callerID, slug, patch); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "unknown agent")
			return
		}
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	agent, err := h.agents.GetAgentBySlug(r.Context(), slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "agent lookup failed")
		return
	}
	v, err := h.view(r, agent, callerID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to resolve agent")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// MintRunnerToken issues the desktop runner's long-lived token. Minted from
// an authenticated interactive session only (the SPA hands it down over IPC;
// plan-v2 §3 — never via the refresh flow).
// POST /api/v1/agents/runner-token
func (h *AgentHandler) MintRunnerToken(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	user, err := h.users.GetByID(r.Context(), callerID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "user lookup failed")
		return
	}
	if user.IsAgent() {
		writeError(w, http.StatusForbidden, "forbidden", "agents cannot mint runner tokens")
		return
	}
	token, err := h.jwt.GenerateRunnerToken(user, runnerTokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "token mint failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{
		"token":     token,
		"expiresAt": time.Now().Add(runnerTokenTTL),
	})
}

// Timeline returns a run and its full event list for the Activity Drawer.
// GET /api/v1/runs/{id}
func (h *AgentHandler) Timeline(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	run, evts, err := h.orch.Timeline(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load run")
		return
	}
	// Access: the invoker always; otherwise any member of the run's parent —
	// agent work in a shared channel is shared context, and the timeline
	// contains nothing the channel itself doesn't already expose.
	if callerID != run.InvokerID {
		if h.access == nil || h.access.CheckAccess(r.Context(), callerID, run.ParentID, run.ParentType) != nil {
			writeError(w, http.StatusForbidden, "forbidden", "no access to this run")
			return
		}
	}
	// Display names for the drawer header (agent + invoker are the only
	// actors a timeline carries).
	users := JSON{}
	for _, id := range []string{run.AgentID, run.InvokerID} {
		if u, err := h.users.GetByID(r.Context(), id); err == nil {
			users[id] = u.DisplayName
		}
	}
	// Artifacts ride along (small, inline-capped) — the drawer is their viewer.
	artifacts, err := h.orch.Artifacts(r.Context(), run.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load artifacts")
		return
	}
	// Whole-conversation totals: a chained debate is many runs, and a fresh
	// round's own spend reads as zeros without this.
	threadSpend := h.orch.ThreadSpend(r.Context(), run)
	writeJSON(w, http.StatusOK, JSON{
		"run": run, "events": evts, "users": users, "artifacts": artifacts, "threadSpend": threadSpend,
	})
}

// ThreadTimeline is the drawer's whole-thread view: every run under one root
// message, merged. Same shape as Timeline (run = the latest, so state/stop/
// polling keep working) plus `runs`.
// GET /api/v1/runs/thread?parent=<channel|conversation id>&root=<message id>
func (h *AgentHandler) ThreadTimeline(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	parentID, rootID := r.URL.Query().Get("parent"), r.URL.Query().Get("root")
	if parentID == "" || rootID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "parent and root are required")
		return
	}
	runs, evts, err := h.orch.ThreadTimeline(r.Context(), parentID, rootID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load thread activity")
		return
	}
	if len(runs) == 0 {
		writeError(w, http.StatusNotFound, "not_found", "no agent activity in this thread")
		return
	}
	// Access mirrors Timeline: an invoker of any run, else a member of the parent.
	invoker := false
	for _, run := range runs {
		if run.InvokerID == callerID {
			invoker = true
			break
		}
	}
	if !invoker && (h.access == nil || h.access.CheckAccess(r.Context(), callerID, parentID, runs[0].ParentType) != nil) {
		writeError(w, http.StatusForbidden, "forbidden", "no access to this thread")
		return
	}
	users := JSON{}
	var artifacts []*model.Artifact
	for _, run := range runs {
		for _, id := range []string{run.AgentID, run.InvokerID} {
			if _, seen := users[id]; seen {
				continue
			}
			if u, err := h.users.GetByID(r.Context(), id); err == nil {
				users[id] = u.DisplayName
			}
		}
		if arts, err := h.orch.Artifacts(r.Context(), run.ID); err == nil {
			artifacts = append(artifacts, arts...)
		}
	}
	// The thread's own messages ride along so posts and steering replies read
	// inline with the work. Bodies are clipped — the drawer is a timeline, the
	// thread itself is one click away.
	msgs := []JSON{}
	if thread, err := h.orch.ThreadMessages(r.Context(), callerID, parentID, runs[0].ParentType, rootID); err == nil {
		for _, m := range thread {
			if m.Deleted || m.Body == "" {
				continue // tombstoned
			}
			body := m.Body
			if rs := []rune(body); len(rs) > 600 {
				body = string(rs[:600]) + "…"
			}
			if _, seen := users[m.AuthorID]; !seen {
				if u, err := h.users.GetByID(r.Context(), m.AuthorID); err == nil {
					users[m.AuthorID] = u.DisplayName
				}
			}
			msgs = append(msgs, JSON{"id": m.ID, "authorID": m.AuthorID, "body": body, "createdAt": m.CreatedAt})
		}
	}
	latest := runs[len(runs)-1]
	writeJSON(w, http.StatusOK, JSON{
		"run": latest, "runs": runs, "events": evts, "users": users, "artifacts": artifacts, "messages": msgs,
		"threadSpend": h.orch.ThreadSpend(r.Context(), latest),
	})
}

// StopRun cancels every live run in this run's conversation thread — the
// human brake on a runaway agent discussion. Allowed for the invoker or any
// member of the parent (it's their channel being flooded).
// POST /api/v1/runs/{id}/stop
func (h *AgentHandler) StopRun(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	run, err := h.orch.Run(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load run")
		return
	}
	if callerID != run.InvokerID {
		if h.access == nil || h.access.CheckAccess(r.Context(), callerID, run.ParentID, run.ParentType) != nil {
			writeError(w, http.StatusForbidden, "forbidden", "no access to this run")
			return
		}
	}
	stopped, err := h.orch.StopThread(r.Context(), callerID, run.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "stop failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"stopped": stopped})
}

// GetArtifact returns one artifact of a run — the inline chat card fetches
// content through this on expand/download. Same access rule as Timeline:
// the invoker always, otherwise any member of the run's parent.
// GET /api/v1/runs/{id}/artifacts/{artifactID}
func (h *AgentHandler) GetArtifact(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	run, err := h.orch.Run(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load run")
		return
	}
	if callerID != run.InvokerID {
		if h.access == nil || h.access.CheckAccess(r.Context(), callerID, run.ParentID, run.ParentType) != nil {
			writeError(w, http.StatusForbidden, "forbidden", "no access to this run")
			return
		}
	}
	artifacts, err := h.orch.Artifacts(r.Context(), run.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to load artifacts")
		return
	}
	for _, a := range artifacts {
		if a.ID == r.PathValue("artifactID") {
			writeJSON(w, http.StatusOK, JSON{"artifact": a})
			return
		}
	}
	writeError(w, http.StatusNotFound, "not_found", "artifact not found")
}

type decideApprovalBody struct {
	Approve bool   `json:"approve"`
	Choice  string `json:"choice"`
	// Text is the invoker's edit of a drafted reply proposal — when approving a
	// propose_reply card, this (if non-empty) is posted instead of the draft.
	Text string `json:"text"`
}

// DecideApproval records the invoker's verdict on a pending approval.
// POST /api/v1/runs/{id}/approvals/{approvalID}
func (h *AgentHandler) DecideApproval(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body decideApprovalBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	a, err := h.orch.DecideApproval(r.Context(), callerID, r.PathValue("id"), r.PathValue("approvalID"), body.Approve, body.Choice, body.Text)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "not_found", "approval not found")
		case errors.Is(err, service.ErrNotInvoker):
			writeError(w, http.StatusForbidden, "forbidden", "only the invoker can decide")
		case errors.Is(err, service.ErrApprovalSettled):
			writeError(w, http.StatusConflict, "settled", "approval already settled")
		default:
			writeError(w, http.StatusInternalServerError, "internal", "decision failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, JSON{"state": a.State, "choice": a.Choice})
}

// ---------------------------------------------------------- subscriptions

type createSubscriptionBody struct {
	ParentID      string   `json:"parentID"`
	ParentType    string   `json:"parentType"`
	Keywords      []string `json:"keywords"`
	HeartbeatMins int      `json:"heartbeatMins"`
	// Watcher standing order (optional): scope to one thread, what to do, and
	// how much autonomy (notify|draft|reply|autonomous; default notify).
	ThreadRootID string `json:"threadRootID"`
	Instruction  string `json:"instruction"`
	ActionMode   string `json:"actionMode"`
}

// ListSubscriptions returns the caller's watches for one agent.
// GET /api/v1/agents/{slug}/subscriptions
func (h *AgentHandler) ListSubscriptions(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	subs, err := h.agents.ListSubscriptionsFor(r.Context(), callerID, r.PathValue("slug"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "subscription list failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"subscriptions": subs})
}

// ListParentWatchers returns the caller's OWN watchers in one channel/DM,
// across every agent — used by the message list to badge watched threads.
// GET /api/v1/channels/{id}/watchers  ·  GET /api/v1/conversations/{id}/watchers
func (h *AgentHandler) ListParentWatchers(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	subs, err := h.agents.ListWatchersInParent(r.Context(), callerID, r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "watcher list failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"watchers": subs})
}

// CreateSubscription makes the agent watch a channel FOR the caller — the
// caller must be able to read the parent (their machine and quota run the
// watch turns, their access gates what the agent sees).
// POST /api/v1/agents/{slug}/subscriptions
func (h *AgentHandler) CreateSubscription(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body createSubscriptionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ParentID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "parentID required")
		return
	}
	if body.ParentType == "" {
		body.ParentType = "channel"
	}
	if h.access == nil || h.access.CheckAccess(r.Context(), callerID, body.ParentID, body.ParentType) != nil {
		writeError(w, http.StatusForbidden, "forbidden", "no access to that channel")
		return
	}
	sub, err := h.agents.CreateSubscription(r.Context(), callerID, r.PathValue("slug"), body.ParentID, body.ParentType, body.Keywords, body.HeartbeatMins, service.WatchInput{
		ThreadRootID: body.ThreadRootID,
		Instruction:  body.Instruction,
		ActionMode:   body.ActionMode,
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "unknown agent")
			return
		}
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "invalid", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "subscription create failed")
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"subscription": sub})
}

// DeleteSubscription removes one of the caller's watches.
// DELETE /api/v1/agents/{slug}/subscriptions/{parentID}/{id}
func (h *AgentHandler) DeleteSubscription(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	err := h.agents.DeleteSubscription(r.Context(), callerID, r.PathValue("parentID"), r.PathValue("id"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, JSON{"ok": true})
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "not your subscription")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "subscription not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "subscription delete failed")
	}
}

// UpdateSubscription edits a watcher's instruction / action mode (creator-only).
// PATCH /api/v1/agents/{slug}/subscriptions/{parentID}/{id}
func (h *AgentHandler) UpdateSubscription(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body struct {
		Instruction string `json:"instruction"`
		ActionMode  string `json:"actionMode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	sub, err := h.agents.UpdateSubscription(r.Context(), callerID, r.PathValue("parentID"), r.PathValue("id"), body.Instruction, body.ActionMode)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, JSON{"subscription": sub})
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "not your subscription")
	case errors.Is(err, service.ErrValidation):
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "subscription not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "subscription update failed")
	}
}

// DecideCatchUp answers a watcher's catch-up ask: process the offline backlog
// now (one coalesced run) or dismiss it. Creator-only.
// POST /api/v1/watchers/{parentID}/{id}/catchup
func (h *AgentHandler) DecideCatchUp(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body struct {
		Process bool `json:"process"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	err := h.orch.DecideCatchUp(r.Context(), callerID, r.PathValue("parentID"), r.PathValue("id"), body.Process)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, JSON{"ok": true})
	case errors.Is(err, service.ErrNotInvoker):
		writeError(w, http.StatusForbidden, "forbidden", "not your watcher")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "watcher not found")
	case errors.Is(err, service.ErrAgentOffline), errors.Is(err, service.ErrAgentBusy):
		writeError(w, http.StatusConflict, "not_ready", "can't start the catch-up right now — try again shortly")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "catch-up decide failed")
	}
}

// ---------------------------------------------------------------- skills

type skillBody struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
}

// ListSkills returns the workspace skill directory.
// GET /api/v1/skills
func (h *AgentHandler) ListSkills(w http.ResponseWriter, r *http.Request) {
	skills, err := h.agents.ListSkills(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "skill list failed")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"skills": skills})
}

// CreateSkill defines a new workspace skill, authored by the caller.
// POST /api/v1/skills
func (h *AgentHandler) CreateSkill(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body skillBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	sk, err := h.agents.CreateSkill(r.Context(), callerID, body.Name, body.Description, body.Instructions)
	if err != nil {
		if errors.Is(err, service.ErrValidation) {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "skill create failed")
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"skill": sk})
}

// UpdateSkill applies the author's edits.
// PATCH /api/v1/skills/{id}
func (h *AgentHandler) UpdateSkill(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var patch service.SkillPatch
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	sk, err := h.agents.UpdateSkill(r.Context(), callerID, r.PathValue("id"), patch)
	if err != nil {
		h.writeSkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"skill": sk})
}

// DeleteSkill removes a skill (author-only).
// DELETE /api/v1/skills/{id}
func (h *AgentHandler) DeleteSkill(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	if err := h.agents.DeleteSkill(r.Context(), callerID, r.PathValue("id")); err != nil {
		h.writeSkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

func (h *AgentHandler) writeSkillError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "skill not found")
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "not the skill author")
	case errors.Is(err, service.ErrValidation):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal", "skill operation failed")
	}
}
