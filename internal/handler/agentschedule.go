package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/cron"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// Scheduled orders as agent tools: an agent lists, creates and removes its
// INVOKER's standing orders ("every weekday at 09:00, post my sprint TL;DR")
// with their access, exactly as the Schedules page does. Without these an
// agent asked "what have I got scheduled?" answered from its harness's own
// cron/routines, which know nothing about Ex.

// scheduleChangeAllowed: only a run a person started by asking directly may
// create or remove orders. Letting a watcher, heartbeat or scheduled run do
// it would let a standing order spawn (or cancel) others on its own.
func scheduleChangeAllowed(run *model.Run) bool {
	switch run.Mode {
	case model.RunModeDirect, model.RunModeFollowUp, "":
		return true
	}
	return false
}

func scheduleWhere(sub *model.AgentSubscription) string {
	if sub.ParentType == service.ParentChannel {
		return "[ch:" + sub.ParentID + "]"
	}
	return "a DM"
}

// scheduleZoneNote tells the agent which zone an order landed in when the
// invoker had none to default to, so "9am" quietly meaning 09:00 UTC gets
// said out loud.
func scheduleZoneNote(sub *model.AgentSubscription) string {
	if sub.ScheduleTZ != "" {
		return ""
	}
	return " Times are UTC because the invoker has no profile timezone — pass timezone to change that."
}

// ListSchedules lists the invoker's scheduled orders across every agent.
// GET /api/v1/agent/run/schedules
func (h *AgentRunToolHandler) ListSchedules(w http.ResponseWriter, r *http.Request) {
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	entries, err := h.agents.ListSchedules(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "schedule list failed")
		return
	}
	var b strings.Builder
	for _, e := range entries {
		fmt.Fprintf(&b, "[sch:%s] %s — %s → %s — %s\n", e.Sub.ID, e.Slug,
			cron.Describe(e.Sub.Schedule, e.Sub.ScheduleTZ), scheduleWhere(e.Sub), e.Sub.Instruction)
	}
	if b.Len() == 0 {
		b.WriteString("(no scheduled orders)")
	} else {
		// Agents are named bare on purpose: an @name in the reply is a real
		// mention, and it woke every listed agent into the thread.
		b.WriteString("(When you report these, name agents without @ — an @mention wakes that agent.)")
	}
	writeJSON(w, http.StatusOK, JSON{"text": b.String()})
}

type createScheduleBody struct {
	Agent       string   `json:"agent"`       // slug; empty = this agent
	Instruction string   `json:"instruction"` // what to do when it fires
	Schedule    string   `json:"schedule"`    // five-field cron, e.g. "0 9 * * 1-5"
	Timezone    string   `json:"timezone"`    // IANA; empty = the invoker's profile zone
	Destination string   `json:"destination"` // "here" (default), "dm", or a channel id
	Connectors  []string `json:"connectors"`
	Skills      []string `json:"skills"`
}

// CreateSchedule creates a scheduled order AS THE INVOKER.
// POST /api/v1/agent/run/schedules
func (h *AgentRunToolHandler) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	if !scheduleChangeAllowed(run) {
		writeError(w, http.StatusForbidden, "forbidden", "scheduled orders can only be created when someone asks you directly")
		return
	}
	var body createScheduleBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	if strings.TrimSpace(body.Schedule) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", `schedule is required: a five-field cron spec, e.g. "0 9 * * 1-5" for 09:00 on weekdays`)
		return
	}
	self, err := h.agents.SlugForAgent(r.Context(), run.AgentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not resolve this agent")
		return
	}
	slug := strings.TrimPrefix(strings.TrimSpace(body.Agent), "@")
	if slug == "" {
		slug = self
	}

	// Where the result lands. The action mode follows it, as on the
	// Schedules page: a private DM notifies, a shared place is posted to.
	parentID, parentType, mode := "", "", model.WatchActionNotify
	switch dest := strings.TrimSpace(body.Destination); dest {
	case "", "here":
		// Another agent can't post into THIS agent's DM with the invoker —
		// it isn't a participant there.
		if run.ParentType == service.ParentConversation && slug != self {
			writeError(w, http.StatusBadRequest, "bad_request", `for another agent use destination "dm" or a channel id`)
			return
		}
		parentID, parentType, mode = run.ParentID, run.ParentType, model.WatchActionAutonomous
	case "dm":
		// No parent: the service files it in the invoker's DM with the agent.
	default:
		parentID, parentType, mode = trimMarker(dest, "ch"), service.ParentChannel, model.WatchActionAutonomous
		if err := h.messages.CheckAccess(r.Context(), claims.UserID, parentID, parentType); err != nil {
			writeError(w, http.StatusForbidden, "forbidden", "the invoker isn't in that channel — list_channels shows where they are")
			return
		}
	}

	skills := make([]string, 0, len(body.Skills))
	for _, id := range body.Skills {
		skills = append(skills, trimMarker(id, "sk"))
	}
	connectors := make([]string, 0, len(body.Connectors))
	for _, c := range body.Connectors {
		connectors = append(connectors, strings.TrimPrefix(strings.TrimSpace(c), "/"))
	}
	sub, err := h.agents.CreateSubscription(r.Context(), claims.UserID, slug, parentID, parentType, nil, 0, service.WatchInput{
		Instruction:    body.Instruction,
		ActionMode:     mode,
		Schedule:       body.Schedule,
		ScheduleTZ:     body.Timezone,
		ConnectorSlugs: connectors,
		SkillIDs:       skills,
	})
	switch {
	case err == nil:
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "no agent @"+slug)
		return
	case errors.Is(err, service.ErrValidation):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	default:
		writeError(w, http.StatusInternalServerError, "internal", "could not save the scheduled order")
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "schedule_created", map[string]any{
		"subscriptionID": sub.ID, "agent": slug, "schedule": sub.Schedule, "scheduleTZ": sub.ScheduleTZ,
	})
	writeJSON(w, http.StatusOK, JSON{"text": fmt.Sprintf("Scheduled [sch:%s] for %s: %s → %s.%s",
		sub.ID, slug, cron.Describe(sub.Schedule, sub.ScheduleTZ), scheduleWhere(sub), scheduleZoneNote(sub))})
}

// DeleteSchedule removes one of the invoker's scheduled orders.
// DELETE /api/v1/agent/run/schedules/{id}
func (h *AgentRunToolHandler) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	if !scheduleChangeAllowed(run) {
		writeError(w, http.StatusForbidden, "forbidden", "scheduled orders can only be removed when someone asks you directly")
		return
	}
	id := trimMarker(r.PathValue("id"), "sch")
	entries, err := h.agents.ListSchedules(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "schedule list failed")
		return
	}
	for _, e := range entries {
		if e.Sub.ID != id {
			continue
		}
		if err := h.agents.DeleteSubscription(r.Context(), claims.UserID, e.Sub.ParentID, id); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "could not remove the scheduled order")
			return
		}
		h.orch.RecordWorkspaceAction(r.Context(), run, "schedule_deleted", map[string]any{"subscriptionID": id, "agent": e.Slug})
		writeJSON(w, http.StatusOK, JSON{"text": fmt.Sprintf("Removed [sch:%s] (%s, %s).", id, e.Slug, cron.Describe(e.Sub.Schedule, e.Sub.ScheduleTZ))})
		return
	}
	writeError(w, http.StatusNotFound, "not_found", "no scheduled order [sch:"+id+"] of the invoker's — list_schedules shows them")
}
