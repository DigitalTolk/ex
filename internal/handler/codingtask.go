package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// CodingTaskHandler serves the coding-task layer (plan-coding-agent.md):
// run-scoped tools the dev agent (and its runner) call, plus the human
// surface behind the task card — read, sign off, steering.
type CodingTaskHandler struct {
	tasks *service.CodingTaskService
	orch  *service.Orchestrator
}

// NewCodingTaskHandler wires the handler.
func NewCodingTaskHandler(tasks *service.CodingTaskService, orch *service.Orchestrator) *CodingTaskHandler {
	return &CodingTaskHandler{tasks: tasks, orch: orch}
}

// writeTaskError maps task-layer errors onto HTTP. Tool callers (the MCP
// server) key off the code: 409s are "stop / different step", 400s are
// "fix your input", 403s are "not yours to do".
func writeTaskError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "task not found")
	case errors.Is(err, service.ErrRunClosed):
		writeError(w, http.StatusConflict, "run_closed", "run reached a terminal state")
	case errors.Is(err, service.ErrTaskActive):
		writeError(w, http.StatusConflict, "task_active", err.Error())
	case errors.Is(err, service.ErrProjectUnknown):
		writeError(w, http.StatusConflict, "project_unknown", err.Error())
	case errors.Is(err, service.ErrTaskTransition), errors.Is(err, store.ErrStaleTask):
		writeError(w, http.StatusConflict, "bad_transition", err.Error())
	case errors.Is(err, service.ErrTaskNotReady):
		writeError(w, http.StatusConflict, "not_ready", err.Error())
	case errors.Is(err, service.ErrNotRequester):
		writeError(w, http.StatusForbidden, "forbidden", "only the requester can do that")
	case errors.Is(err, service.ErrTaskAgent):
		writeError(w, http.StatusServiceUnavailable, "no_dev_agent", "the dev coding agent is not available in this workspace")
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "no access to this task")
	case errors.Is(err, service.ErrNotTaskRun):
		writeError(w, http.StatusBadRequest, "not_task_run", "this run is not bound to a coding task")
	case errors.Is(err, service.ErrValidation):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		// The client gets a generic 500; the REAL error must not vanish —
		// this branch once ate a create failure with nothing in the logs.
		slog.Error("coding task operation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "task operation failed")
	}
}

type repoBody struct {
	Path       string `json:"path"`
	Role       string `json:"role"`
	BaseBranch string `json:"base_branch"`
}

type createTaskBody struct {
	Project    string     `json:"project"`
	Repos      []repoBody `json:"repos"`
	Title      string     `json:"title"`
	Goal       string     `json:"goal"`
	Kind       string     `json:"kind"`
	BaseBranch string     `json:"base_branch"`
	Ticket     *struct {
		Connector string `json:"connector"`
		ID        string `json:"id"`
		URL       string `json:"url"`
	} `json:"ticket"`
}

// Create opens a coding task for the run's invoker (the create_coding_task
// tool). Deterministic side effects: project (product + repos) resolved or
// recorded, project channel, pinned task card, pointer back in the origin
// thread, kickoff run in the task thread.
// POST /api/v1/agent/run/coding-task
func (h *CodingTaskHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	var body createTaskBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	in := service.CreateTaskInput{
		Project:    body.Project,
		Title:      body.Title,
		Goal:       body.Goal,
		Kind:       body.Kind,
		BaseBranch: body.BaseBranch,
	}
	for _, rb := range body.Repos {
		in.Repos = append(in.Repos, service.RepoInput{Path: rb.Path, Role: rb.Role, BaseBranch: rb.BaseBranch})
	}
	if body.Ticket != nil && strings.TrimSpace(body.Ticket.ID) != "" {
		in.Ticket = &model.TaskTicket{
			Connector: strings.TrimSpace(body.Ticket.Connector),
			ID:        strings.TrimSpace(body.Ticket.ID),
			URL:       strings.TrimSpace(body.Ticket.URL),
		}
	}
	res, err := h.tasks.Create(r.Context(), run, in)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	t := res.Task
	repos := make([]string, 0, len(t.Repos))
	for _, rp := range t.Repos {
		repos = append(repos, rp.Path+" ("+rp.Role+")")
	}
	text := "Task created: " + model.TaskKindFlair(t.Kind) + " " + t.Title + " for " + t.ProjectName +
		" in ~" + res.Channel.Slug + " — repos: " + strings.Join(repos, ", ")
	if res.URL != "" {
		text += " → " + res.URL
	}
	if res.KickoffErr != nil {
		text += ". The task thread exists but the first run could not start (" + res.KickoffErr.Error() +
			") — tell the requester to reply in the task thread once their desktop app is online."
	} else {
		text += ". Your task run has started in that thread — END this turn now WITHOUT posting; the pointer is already posted here."
	}
	writeJSON(w, http.StatusOK, JSON{
		"taskID":         t.ID,
		"project":        t.ProjectName,
		"projectKey":     t.ProjectKey,
		"channelID":      t.ChannelID,
		"channelSlug":    res.Channel.Slug,
		"threadRootID":   t.ThreadRootID,
		"repos":          t.Repos,
		"url":            res.URL,
		"projectCreated": res.ProjectCreated,
		"kickoffStarted": res.KickoffErr == nil,
		"text":           text,
	})
}

type repoUpdateBody struct {
	Path         string `json:"path"`
	Branch       string `json:"branch"`
	BaseBranch   string `json:"base_branch"`
	WorkspaceDir string `json:"workspace_dir"`
	MRURL        string `json:"mr_url"`
	Changed      *bool  `json:"changed"`
}

type reportTaskBody struct {
	State string           `json:"state"`
	Note  string           `json:"note"`
	Repos []repoUpdateBody `json:"repos"`
}

// Report applies a lifecycle update from a task run (runner workspace
// beats, the agent's task_state tool, the MR step).
// POST /api/v1/agent/run/coding-task/report
func (h *CodingTaskHandler) Report(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	var body reportTaskBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	up := service.TaskUpdate{State: model.TaskState(strings.TrimSpace(body.State)), Note: body.Note}
	for _, rb := range body.Repos {
		up.Repos = append(up.Repos, service.RepoUpdate{
			Path: rb.Path, Branch: rb.Branch, BaseBranch: rb.BaseBranch, WorkspaceDir: rb.WorkspaceDir, MRURL: rb.MRURL, Changed: rb.Changed,
		})
	}
	t, err := h.tasks.Report(r.Context(), run, up)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"state": t.State, "text": "task is now " + string(t.State)})
}

type testPlanBody struct {
	URL          string   `json:"url"`
	Steps        []string `json:"steps"`
	CounterSteps []string `json:"counter_steps"`
	Accounts     string   `json:"accounts"`
	Notes        string   `json:"notes"`
}

// TestPlan publishes the requester-facing test plan (publish_test_plan
// tool): state → awaiting_user_test, deterministic "ready to test" note.
// POST /api/v1/agent/run/coding-task/test-plan
func (h *CodingTaskHandler) TestPlan(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	var body testPlanBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	t, err := h.tasks.PublishTestPlan(r.Context(), run, model.TestPlan{
		URL: body.URL, Steps: body.Steps, CounterSteps: body.CounterSteps, Accounts: body.Accounts, Notes: body.Notes,
	})
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{
		"state": t.State,
		"text": "published — the requester has the test plan. END your turn now; they will reply in this " +
			"thread (or sign off) and you will be resumed.",
	})
}

// RequestMR is the hard gate before push + MR (request_mr tool). Approved
// only with the requester's sign-off on record — the card button, or the
// approval this tool raises and passes back as approvalID.
// POST /api/v1/agent/run/coding-task/request-mr
func (h *CodingTaskHandler) RequestMR(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	var body struct {
		ApprovalID string `json:"approvalID"`
	}
	// An empty body is fine (the first call carries no approval); malformed
	// JSON is not.
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	status, t, err := h.tasks.RequestMR(r.Context(), run, strings.TrimSpace(body.ApprovalID))
	if err != nil {
		writeTaskError(w, err)
		return
	}
	out := JSON{"status": status, "taskID": t.ID, "project": t.ProjectName, "repos": t.Repos}
	switch status {
	case service.MRStatusApproved:
		out["mrTitle"] = t.Title
		out["mrDescription"] = mrDescription(t, h.tasks.TaskURL(t))
		out["mrBodyFallback"] = mrBodyFallback(t)
		out["mrFooter"] = mrFooter(t, h.tasks.TaskURL(t))
		out["labels"] = []string{"ex:dev"}
		out["message"] = "approved — push each changed repo's branch and open its merge request, then report mr_created with the MR URLs"
	case service.MRStatusAsk:
		out["summary"] = service.MRApprovalSummary(t)
		out["message"] = "the requester has not signed off yet — raise the approval with the given summary and call again with its approvalID"
	case service.MRStatusNotReady:
		out["message"] = "not ready: publish a test plan and let the requester verify before asking for an MR"
	default:
		out["message"] = "the requester declined the merge request — do NOT push; ask what should change"
	}
	writeJSON(w, http.StatusOK, out)
}

// mrDescription is the server's stand-in MR body (old runners read only this
// field): the short fallback plus the footer. New runners compose the body
// from the agent's reviewer-facing notes and append mrFooter themselves.
func mrDescription(t *model.CodingTask, url string) string {
	return mrBodyFallback(t) + "\n\n---\n" + mrFooter(t, url)
}

// mrBodyFallback stands in when the agent supplies no MR summary: the goal's
// FIRST paragraph only. Test-plan steps, seeded accounts and localhost URLs
// are the requester's local loop — they never belong in a forge MR.
func mrBodyFallback(t *model.CodingTask) string {
	body := strings.TrimSpace(t.Goal)
	if i := strings.Index(body, "\n\n"); i > 0 {
		body = body[:i]
	}
	if r := []rune(body); len(r) > 600 {
		body = string(r[:600]) + "…"
	}
	return body
}

// mrFooter is the Ex signature line every MR carries (decision: MR authored
// by the requester, visibly written with Ex). One italic markdown line: the
// ticket as a real link, and the task thread only when its URL would resolve
// for a reviewer — a localhost link is noise to everyone but the requester.
func mrFooter(t *model.CodingTask, url string) string {
	sig := "🛠️ Written with the Ex coding agent (dev)"
	if url != "" && !strings.Contains(url, "localhost") && !strings.Contains(url, "127.0.0.1") {
		sig += " — [task thread](" + url + ")"
	}
	if t.Ticket != nil && t.Ticket.ID != "" {
		if t.Ticket.URL != "" {
			sig += " · Ticket [" + t.Ticket.ID + "](" + t.Ticket.URL + ")"
		} else {
			sig += " · Ticket " + t.Ticket.ID
		}
	}
	return "_" + sig + "_"
}

// Get returns a task the caller can see (member of its project channel) —
// the task card's live data.
// GET /api/v1/coding-tasks/{id}
func (h *CodingTaskHandler) Get(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	t, err := h.tasks.GetVisible(r.Context(), callerID, r.PathValue("id"))
	if err != nil {
		writeTaskError(w, err)
		return
	}
	// Rows from before repos existed carry a nil slice — serialize [] so
	// clients never see null.
	if t.Repos == nil {
		t.Repos = []model.TaskRepo{}
	}
	writeJSON(w, http.StatusOK, JSON{"task": t, "url": h.tasks.TaskURL(t)})
}

// ListByChannel lists a project channel's tasks.
// GET /api/v1/channels/{id}/coding-tasks
func (h *CodingTaskHandler) ListByChannel(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	tasks, err := h.tasks.ListByChannel(r.Context(), callerID, r.PathValue("id"))
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if tasks == nil {
		tasks = []*model.CodingTask{}
	}
	writeJSON(w, http.StatusOK, JSON{"tasks": tasks})
}

// ListProjects lists the known coding projects (products → repos).
// GET /api/v1/coding-projects
func (h *CodingTaskHandler) ListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := h.tasks.ListProjects(r.Context())
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if projects == nil {
		projects = []*model.CodingProject{}
	}
	writeJSON(w, http.StatusOK, JSON{"projects": projects})
}

// SignOff is the requester's "ship it" from the task card: records the
// sign-off and starts the push + MR run.
// POST /api/v1/coding-tasks/{id}/signoff
func (h *CodingTaskHandler) SignOff(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	t, err := h.tasks.SignOff(r.Context(), callerID, r.PathValue("id"))
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"task": t})
}

// SetSteering flips the per-task "anyone in channel may steer" toggle.
// PATCH /api/v1/coding-tasks/{id}
func (h *CodingTaskHandler) SetSteering(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body struct {
		Steering string `json:"steering"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Steering == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "steering required (requester | anyone)")
		return
	}
	t, err := h.tasks.SetSteering(r.Context(), callerID, r.PathValue("id"), body.Steering)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"task": t})
}

// Close ends a task by hand from the card: done (merge requests are open,
// Ex is finished) or abandoned (drop the work). Requester-only.
// POST /api/v1/coding-tasks/{id}/close
func (h *CodingTaskHandler) Close(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserIDFromContext(r.Context())
	var body struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.State == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "state required (done | abandoned)")
		return
	}
	t, err := h.tasks.Close(r.Context(), callerID, r.PathValue("id"), body.State)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"task": t})
}
