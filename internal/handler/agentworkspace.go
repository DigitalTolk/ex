package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
)

// Workspace tool surface (Phase 3+): agents can act across Ex — list/create/
// join channels, read and post outside their thread, search, react, DM —
// always AS the agent but WITH the invoker's access. Every permission check
// runs against the invoker (plan-v2 §3: an agent can never see or touch what
// the invoking human couldn't), and every mutating call lands on the run's
// timeline as a workspace.* audit event.

// AgentWorkspaceDeps carries the extra services the workspace tools need.
// Optional as a unit — when unset the workspace endpoints 404 (router skips).
type AgentWorkspaceDeps struct {
	Channels      *service.ChannelService
	Conversations *service.ConversationService
	Searcher      search.Searcher // may be nil → search returns empty
	SearchAccess  SearchAccess
	Reminders     *service.ReminderService // may be nil → reminder tools 404
}

// SetWorkspace wires the workspace tool dependencies.
func (h *AgentRunToolHandler) SetWorkspace(deps AgentWorkspaceDeps) { h.workspace = &deps }

// ListChannels lists the channels the INVOKER is in (the ones the agent can
// read/post via their access).
// GET /api/v1/agent/run/channels
func (h *AgentRunToolHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, err)
		return
	}
	channels, err := h.workspace.Channels.ListUserChannels(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "channel list failed")
		return
	}
	var b strings.Builder
	for _, ch := range channels {
		fmt.Fprintf(&b, "[ch:%s] ~%s (%s)\n", ch.ChannelID, ch.ChannelName, ch.ChannelType)
	}
	if b.Len() == 0 {
		b.WriteString("(the invoker is in no channels)")
	}
	writeJSON(w, http.StatusOK, JSON{"text": b.String()})
}

type createChannelBody struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Private     bool   `json:"private"`
}

// CreateChannel creates a channel AS THE INVOKER — their access level gates
// it (guests can't create channels; the service enforces that).
// POST /api/v1/agent/run/channels
func (h *AgentRunToolHandler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body createChannelBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	chanType := model.ChannelTypePublic
	if body.Private {
		chanType = model.ChannelTypePrivate
	}
	ch, err := h.workspace.Channels.Create(r.Context(), claims.UserID, body.Name, chanType, body.Description)
	if err != nil {
		if errors.Is(err, service.ErrAlreadyExists) {
			writeError(w, http.StatusConflict, "exists", "a channel with this name already exists")
			return
		}
		writeError(w, http.StatusForbidden, "forbidden", err.Error())
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "channel_created", map[string]any{
		"channelID": ch.ID, "name": ch.Name, "type": string(ch.Type),
	})
	writeJSON(w, http.StatusOK, JSON{"channelID": ch.ID, "slug": ch.Slug})
}

// JoinChannel joins the INVOKER to a public channel.
// POST /api/v1/agent/run/channels/{id}/join
func (h *AgentRunToolHandler) JoinChannel(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	channelID := r.PathValue("id")
	if err := h.workspace.Channels.Join(r.Context(), claims.UserID, channelID); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", err.Error())
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "channel_joined", map[string]any{"channelID": channelID})
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

// ReadChannel renders another channel's recent messages in bundle format,
// read as the invoker.
// GET /api/v1/agent/run/channels/{id}/messages
func (h *AgentRunToolHandler) ReadChannel(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, err)
		return
	}
	limit := queryInt(r, "limit", 30)
	if limit > 50 {
		limit = 50
	}
	text, err := h.orch.Window(r.Context(), claims.UserID, r.PathValue("id"), service.ParentChannel, "", limit)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "the invoker cannot read this channel")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"text": text})
}

type postChannelBody struct {
	Body string `json:"body"`
	// ThreadRoot replies inside a specific thread (a message ID) instead of at
	// the top level — e.g. answering a question that was asked in a thread.
	ThreadRoot string `json:"thread_root"`
}

// PostToChannel posts as the agent into ANOTHER channel the invoker is in.
// Shares the per-run post cap with post_message.
// POST /api/v1/agent/run/channels/{id}/messages
func (h *AgentRunToolHandler) PostToChannel(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body postChannelBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "body required")
		return
	}
	if model.WatchModePostsPrivately(run.ActionMode) {
		writeError(w, http.StatusForbidden, "notify_only", "this watcher can't post publicly — use notify_owner")
		return
	}
	if !h.replyApprovalOK(w, r.Context(), run) {
		return
	}
	if run.Spend.Posts >= run.Limits.MaxPosts {
		writeError(w, http.StatusTooManyRequests, "post_cap", "per-run post cap reached")
		return
	}
	channelID := r.PathValue("id")
	text := h.orch.LinkifyMentions(r.Context(), run, body.Body)
	msg, err := h.messages.SendAsAgentRun(r.Context(), claims.ActorID, claims.UserID, channelID, service.ParentChannel, text, body.ThreadRoot, claims.RunID)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "post rejected — is the invoker a member of that channel?")
		return
	}
	remaining, err := h.orch.RecordAgentPost(r.Context(), claims.RunID)
	if err != nil {
		remaining = 0
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "channel_posted", map[string]any{
		"channelID": channelID, "messageID": msg.ID,
	})
	writeJSON(w, http.StatusOK, JSON{"messageID": msg.ID, "remainingPosts": remaining})
}

// SearchWorkspace searches message history the INVOKER can see.
// GET /api/v1/agent/run/search?q=&limit=
func (h *AgentRunToolHandler) SearchWorkspace(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, err)
		return
	}
	q := strings.TrimSpace(queryParam(r, "q", ""))
	if q == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "q required")
		return
	}
	if h.workspace.Searcher == nil || h.workspace.SearchAccess == nil {
		writeJSON(w, http.StatusOK, JSON{"text": "(search is not available in this workspace)"})
		return
	}
	allowed, err := h.workspace.SearchAccess.AllowedParentIDs(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "access resolution failed")
		return
	}
	limit := queryInt(r, "limit", 10)
	if limit > 20 {
		limit = 20
	}
	res, err := h.workspace.Searcher.Messages(r.Context(), search.MessageQuery{
		Q: q, AllowedParentIDs: allowed, Limit: limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "search failed")
		return
	}
	var b strings.Builder
	for _, hit := range res.Hits {
		body, _ := hit.Source["body"].(string)
		parent, _ := hit.Source["parentId"].(string)
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		fmt.Fprintf(&b, "[m:%s] (in %s) %s\n", hit.ID, parent, strings.ReplaceAll(body, "\n", " "))
	}
	if b.Len() == 0 {
		b.WriteString("(no results)")
	}
	writeJSON(w, http.StatusOK, JSON{"text": b.String()})
}

type reactBody struct {
	MessageID  string `json:"messageID"`
	Emoji      string `json:"emoji"`
	ParentID   string `json:"parentID"`   // optional: defaults to the run's parent
	ParentType string `json:"parentType"` // optional, with ParentID
}

// React toggles a normal reaction as the agent, authorized by the invoker.
// POST /api/v1/agent/run/reactions
func (h *AgentRunToolHandler) React(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body reactBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.MessageID == "" || body.Emoji == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "messageID and emoji required")
		return
	}
	parentID, parentType := run.ParentID, run.ParentType
	if body.ParentID != "" {
		parentID = body.ParentID
		if body.ParentType != "" {
			parentType = body.ParentType
		} else {
			parentType = service.ParentChannel
		}
	}
	if _, err := h.messages.ToggleReactionAsAgent(r.Context(), claims.ActorID, claims.UserID, parentID, parentType, body.MessageID, body.Emoji); err != nil {
		if errors.Is(err, service.ErrReservedEmoji) {
			writeError(w, http.StatusBadRequest, "reserved_emoji", "that emoji is reserved for run states")
			return
		}
		writeError(w, http.StatusForbidden, "forbidden", "reaction rejected")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

// ListUsers searches the workspace directory (names the agent can @mention
// or DM on the invoker's behalf).
// GET /api/v1/agent/run/users?q=
func (h *AgentRunToolHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, err)
		return
	}
	if h.workspace.Searcher == nil {
		writeJSON(w, http.StatusOK, JSON{"text": "(directory search is not available)"})
		return
	}
	q := queryParam(r, "q", "")
	res, err := h.workspace.Searcher.Users(r.Context(), q, 20)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "user search failed")
		return
	}
	var b strings.Builder
	for _, hit := range res.Hits {
		name, _ := hit.Source["displayName"].(string)
		fmt.Fprintf(&b, "[u:%s] %s\n", hit.ID, name)
	}
	if b.Len() == 0 {
		b.WriteString("(no matching users)")
	}
	writeJSON(w, http.StatusOK, JSON{"text": b.String()})
}

type sendDMBody struct {
	UserID string `json:"userID"`
	Body   string `json:"body"`
}

// SendDM opens (or reuses) the DM between the INVOKER and the target, and
// posts into it as the agent. Shares the per-run post cap.
// POST /api/v1/agent/run/dm
func (h *AgentRunToolHandler) SendDM(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body sendDMBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.UserID == "" || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "userID and body required")
		return
	}
	if model.WatchModePostsPrivately(run.ActionMode) {
		writeError(w, http.StatusForbidden, "notify_only", "this watcher may only message its creator — use notify_owner")
		return
	}
	if run.Spend.Posts >= run.Limits.MaxPosts {
		writeError(w, http.StatusTooManyRequests, "post_cap", "per-run post cap reached")
		return
	}
	conv, err := h.workspace.Conversations.GetOrCreateDM(r.Context(), claims.UserID, body.UserID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "could not open the DM")
		return
	}
	text := h.orch.LinkifyMentions(r.Context(), run, body.Body)
	msg, err := h.messages.SendAsAgentRun(r.Context(), claims.ActorID, claims.UserID, conv.ID, service.ParentConversation, text, "", claims.RunID)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "DM rejected")
		return
	}
	remaining, err := h.orch.RecordAgentPost(r.Context(), claims.RunID)
	if err != nil {
		remaining = 0
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "dm_sent", map[string]any{
		"toUserID": body.UserID, "conversationID": conv.ID, "messageID": msg.ID,
	})
	writeJSON(w, http.StatusOK, JSON{"messageID": msg.ID, "remainingPosts": remaining})
}

// ---------------------------------------------------------------- reminders

// SetReminder schedules a reminder for the INVOKER (it fires into their
// activity + notifications), anchored to a message in the run's thread. Give
// either remind_at (RFC3339) or in_minutes.
// POST /api/v1/agent/run/reminders
func (h *AgentRunToolHandler) SetReminder(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	if h.workspace == nil || h.workspace.Reminders == nil {
		writeError(w, http.StatusNotFound, "unavailable", "reminders not available")
		return
	}
	var body struct {
		MessageID string  `json:"message_id"`
		RemindAt  string  `json:"remind_at"`  // RFC3339
		InMinutes float64 `json:"in_minutes"` // convenience: minutes from now
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	var remindAt time.Time
	switch {
	case body.RemindAt != "":
		t, perr := time.Parse(time.RFC3339, body.RemindAt)
		if perr != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "remind_at must be RFC3339 (e.g. 2026-08-13T15:04:05Z)")
			return
		}
		remindAt = t
	case body.InMinutes > 0:
		remindAt = time.Now().Add(time.Duration(body.InMinutes*60) * time.Second)
	default:
		writeError(w, http.StatusBadRequest, "bad_request", "provide remind_at (RFC3339) or in_minutes")
		return
	}
	// Anchor to the caller-named message, else the message that invoked the run.
	msgID := body.MessageID
	if msgID == "" {
		msgID = run.MessageID
	}
	rem, err := h.workspace.Reminders.Schedule(r.Context(), claims.UserID, service.ReminderInput{
		MessageID:  msgID,
		ParentID:   run.ParentID,
		ParentType: run.ParentType,
		RemindAt:   remindAt,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "reminder_error", err.Error())
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "reminder_set", map[string]any{
		"reminderID": rem.ID, "messageID": msgID, "remindAt": remindAt.UTC().Format(time.RFC3339),
	})
	writeJSON(w, http.StatusOK, JSON{"text": fmt.Sprintf("Reminder set for %s (id %s).", remindAt.UTC().Format(time.RFC3339), rem.ID)})
}

// ListReminders lists the invoker's pending reminders.
// GET /api/v1/agent/run/reminders
func (h *AgentRunToolHandler) ListReminders(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, err)
		return
	}
	if h.workspace == nil || h.workspace.Reminders == nil {
		writeError(w, http.StatusNotFound, "unavailable", "reminders not available")
		return
	}
	rems, err := h.workspace.Reminders.ListPending(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "reminder list failed")
		return
	}
	var b strings.Builder
	for _, rem := range rems {
		fmt.Fprintf(&b, "[rem:%s] %s — %s\n", rem.ID, rem.RemindAt.UTC().Format(time.RFC3339), rem.MessagePreview)
	}
	if b.Len() == 0 {
		b.WriteString("(no pending reminders)")
	}
	writeJSON(w, http.StatusOK, JSON{"text": b.String()})
}

// CancelReminder cancels one of the invoker's pending reminders.
// DELETE /api/v1/agent/run/reminders/{id}
func (h *AgentRunToolHandler) CancelReminder(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	if h.workspace == nil || h.workspace.Reminders == nil {
		writeError(w, http.StatusNotFound, "unavailable", "reminders not available")
		return
	}
	id := r.PathValue("id")
	if err := h.workspace.Reminders.Cancel(r.Context(), claims.UserID, id); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "no such pending reminder")
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "reminder_canceled", map[string]any{"reminderID": id})
	writeJSON(w, http.StatusOK, JSON{"text": "Reminder canceled."})
}

// PinMessage pins or unpins a message in the run's thread (as the invoker).
// POST /api/v1/agent/run/pins
func (h *AgentRunToolHandler) PinMessage(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	var body struct {
		MessageID string `json:"message_id"`
		Pinned    *bool  `json:"pinned"` // default true
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.MessageID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "message_id required")
		return
	}
	pinned := true
	if body.Pinned != nil {
		pinned = *body.Pinned
	}
	if _, err := h.messages.SetPinned(r.Context(), claims.UserID, run.ParentID, run.ParentType, body.MessageID, pinned); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "pin rejected")
		return
	}
	action := "message_pinned"
	if !pinned {
		action = "message_unpinned"
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, action, map[string]any{"messageID": body.MessageID})
	verb := "Pinned"
	if !pinned {
		verb = "Unpinned"
	}
	writeJSON(w, http.StatusOK, JSON{"text": verb + " the message."})
}

// NotifyOwner sends a PRIVATE message from the agent to the run's creator —
// the "DM me" primitive watchers use in notify/draft mode. Lands in the DM
// between the creator and this agent (created on first use), so it never
// appears in the watched channel. Not gated by the notify-only post block.
// POST /api/v1/agent/run/notify
func (h *AgentRunToolHandler) NotifyOwner(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	run, err := h.orch.GetLiveRun(r.Context(), claims.RunID)
	if err != nil {
		h.writeToolError(w, err)
		return
	}
	if h.workspace == nil || h.workspace.Conversations == nil {
		writeError(w, http.StatusNotFound, "unavailable", "notify not available")
		return
	}
	var body struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "body required")
		return
	}
	// The DM between the creator (invoker) and this agent.
	conv, err := h.workspace.Conversations.GetOrCreateDM(r.Context(), claims.UserID, claims.ActorID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not open the owner DM")
		return
	}
	text := h.orch.LinkifyMentions(r.Context(), run, body.Body)
	msg, err := h.messages.SendAsAgentRun(r.Context(), claims.ActorID, claims.UserID, conv.ID, service.ParentConversation, text, "", claims.RunID)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "notify rejected")
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "owner_notified", map[string]any{
		"conversationID": conv.ID, "messageID": msg.ID,
	})
	writeJSON(w, http.StatusOK, JSON{"text": "Notified your creator via DM."})
}

// replyApprovalOK enforces the reply-watcher approval gate SERVER-SIDE: a
// reply-mode run may post publicly only after an approval for it was granted.
// Returns false (and writes the error) when it hasn't been. Other modes pass.
func (h *AgentRunToolHandler) replyApprovalOK(w http.ResponseWriter, ctx context.Context, run *model.Run) bool {
	if run.ActionMode != model.WatchActionReply {
		return true
	}
	approved, err := h.orch.HasApprovedApproval(ctx, run.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "approval check failed")
		return false
	}
	if !approved {
		writeError(w, http.StatusForbidden, "approval_required",
			"reply-mode watcher must request_approval and be approved before posting publicly")
		return false
	}
	return true
}
