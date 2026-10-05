package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// A tool error is the model's ONLY signal about what went wrong, and a model
// given no reason invents one. A live run that failed to DM someone reported
// "workspace/permission restrictions preventing agent-initiated DMs" and "the
// user may be deactivated" — neither of which any of these paths can produce.
// It had been told only "could not open the DM". So these helpers say what
// actually happened and, where there is one, name the next move.

// dmOpenFailure explains a GetOrCreateDM failure. The invoker always exists
// (the run belongs to them), so a not-found is the RECIPIENT's id — which is
// what happens when an agent guesses an id instead of resolving one.
func dmOpenFailure(err error, userID string) string {
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Sprintf("no user with id %q — resolve the person with list_users and pass the id it returns", userID)
	}
	return "could not open the DM: " + err.Error()
}

// toolRejection keeps the underlying reason instead of discarding it. `hint`
// names the usual cause when there is one; pass "" when there isn't.
func toolRejection(what string, err error, hint string) string {
	msg := what + ": " + err.Error()
	if hint != "" {
		msg += " — " + hint
	}
	return msg
}

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
	Reminders     *service.ReminderService  // may be nil → reminder tools 404
	Connectors    *service.ConnectorService // may be nil → connector tools 404
}

// SetWorkspace wires the workspace tool dependencies.
func (h *AgentRunToolHandler) SetWorkspace(deps AgentWorkspaceDeps) { h.workspace = &deps }

// threadRef normalizes a thread reference from a tool call: models hold
// message ids as bare ULIDs, as [m:<id>] bundle markers, or inside a
// permalink's #msg-<id> fragment — accept all three.
func threadRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if i := strings.LastIndex(ref, "#msg-"); i >= 0 {
		ref = ref[i+len("#msg-"):]
	}
	return trimMarker(ref, "m")
}

// userRef normalizes a user reference from a tool call. list_users answers in
// the bundle's marker form (`[u:<id>] Name`), and models copy an id straight
// out of what they were shown — so the bare id and the marker must both work.
// Exactly the mistake threadRef already absorbs for message ids: a run that
// looked up a real person still failed with "could not open the DM", because
// GetUser was handed "[u:<id>]" and the user genuinely did not exist under
// that key.
func userRef(ref string) string {
	return trimMarker(ref, "u")
}

// ListChannels lists the channels the INVOKER is in (the ones the agent can
// read/post via their access).
// GET /api/v1/agent/run/channels
func (h *AgentRunToolHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, r, err)
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
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	var body createChannelBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || strings.TrimSpace(body.Name) == "" {
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
	run, claims := h.liveRun(w, r)
	if run == nil {
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
// GET /api/v1/agent/run/channels/{id}/messages?limit=&thread=
// Without thread: the channel's recent TOP-LEVEL messages. With thread (any
// message id inside a thread — a permalink's target included): that thread's
// messages, the reply bodies a channel window deliberately omits.
func (h *AgentRunToolHandler) ReadChannel(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, r, err)
		return
	}
	h.windowText(w, r, claims.UserID, r.PathValue("id"), service.ParentChannel, "the invoker cannot read this channel")
}

// windowText renders a parent's window for a run tool: optional ?thread=
// narrowing (any message id in the thread — resolved to its root), clamped
// ?limit=, access enforced as the invoker. Shared by ReadChannel and ReadDM.
func (h *AgentRunToolHandler) windowText(w http.ResponseWriter, r *http.Request, userID, parentID, parentType, denied string) {
	// clampInt, not a bare upper bound: a NEGATIVE limit slipped past the
	// one-sided check and reached the store as-is.
	limit := clampInt(queryInt(r, "limit", 30), 1, 50)
	thread := threadRef(r.URL.Query().Get("thread"))
	if thread != "" {
		root, err := h.messages.ResolveThreadRoot(r.Context(), userID, parentID, parentType, thread)
		if err != nil {
			writeError(w, http.StatusForbidden, "forbidden", denied)
			return
		}
		thread = root
	}
	text, err := h.orch.Window(r.Context(), userID, parentID, parentType, thread, limit)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", denied)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"text": text})
}

// ReadPins lists a channel's pinned messages — the durable stuff members
// chose to keep visible (decisions, links, standing docs).
// GET /api/v1/agent/run/channels/{id}/pins
func (h *AgentRunToolHandler) ReadPins(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, r, err)
		return
	}
	msgs, err := h.messages.ListPinned(r.Context(), claims.UserID, r.PathValue("id"), service.ParentChannel)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "the invoker cannot read this channel")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"text": h.orch.RenderMessages(r.Context(), msgs)})
}

// ReadDM reads the INVOKER's own direct conversation with one user — their
// message history with that person, which the invoker can already see in the
// app. Supports the same thread narrowing as ReadChannel.
// GET /api/v1/agent/run/dm/{userID}/messages?limit=&thread=
func (h *AgentRunToolHandler) ReadDM(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if _, err := h.orch.GetLiveRun(r.Context(), claims.RunID); err != nil {
		h.writeToolError(w, r, err)
		return
	}
	target := userRef(r.PathValue("userID"))
	conv, err := h.workspace.Conversations.GetOrCreateDM(r.Context(), claims.UserID, target)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", dmOpenFailure(err, target))
		return
	}
	h.windowText(w, r, claims.UserID, conv.ID, service.ParentConversation, "the invoker cannot read this conversation")
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
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	var body postChannelBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || strings.TrimSpace(body.Body) == "" {
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
		h.writeToolError(w, r, err)
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
	limit := clampInt(queryInt(r, "limit", 10), 1, 20)
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
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	var body reactBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || body.MessageID == "" || body.Emoji == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "messageID and emoji required")
		return
	}
	// Accept the [m:<id>] / [ch:<id>] marker forms models copy from the bundle.
	msgID := threadRef(body.MessageID)
	parentID, parentType := run.ParentID, run.ParentType
	if body.ParentID != "" {
		parentID = trimMarker(body.ParentID, "ch")
		if body.ParentType != "" {
			parentType = body.ParentType
		} else {
			parentType = service.ParentChannel
		}
	}
	if _, err := h.messages.ToggleReactionAsAgent(r.Context(), claims.ActorID, claims.UserID, parentID, parentType, msgID, body.Emoji); err != nil {
		if errors.Is(err, service.ErrReservedEmoji) {
			writeError(w, http.StatusBadRequest, "reserved_emoji", "that emoji is reserved for run states")
			return
		}
		writeError(w, http.StatusForbidden, "forbidden",
			toolRejection("reaction rejected", err, "check the message id and that the invoker can see that channel"))
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
		h.writeToolError(w, r, err)
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
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	var body sendDMBody
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || body.UserID == "" || strings.TrimSpace(body.Body) == "" {
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
	target := userRef(body.UserID)
	conv, err := h.workspace.Conversations.GetOrCreateDM(r.Context(), claims.UserID, target)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", dmOpenFailure(err, target))
		return
	}
	text := h.orch.LinkifyMentions(r.Context(), run, body.Body)
	msg, err := h.messages.SendAsAgentRun(r.Context(), claims.ActorID, claims.UserID, conv.ID, service.ParentConversation, text, "", claims.RunID)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", toolRejection("DM rejected", err, ""))
		return
	}
	remaining, err := h.orch.RecordAgentPost(r.Context(), claims.RunID)
	if err != nil {
		remaining = 0
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "dm_sent", map[string]any{
		"toUserID": target, "conversationID": conv.ID, "messageID": msg.ID,
	})
	writeJSON(w, http.StatusOK, JSON{"messageID": msg.ID, "remainingPosts": remaining})
}

// ---------------------------------------------------------------- reminders

// SetReminder schedules a reminder for the INVOKER (it fires into their
// activity + notifications), anchored to a message in the run's thread. Give
// either remind_at (RFC3339) or in_minutes.
// POST /api/v1/agent/run/reminders
// ReconnectConnector asks the INVOKER to reconnect a connector whose
// credential died. An agent cannot reconnect anything itself — the credential
// is the person's, and renewing it means them signing in — so this tool does
// the one useful thing available: raise the prompt where they will see it,
// and say plainly that it did.
// POST /api/v1/agent/run/connectors/reconnect
func (h *AgentRunToolHandler) ReconnectConnector(w http.ResponseWriter, r *http.Request) {
	run, _ := h.liveRun(w, r)
	if run == nil {
		return
	}
	if h.workspace == nil || h.workspace.Connectors == nil {
		writeError(w, http.StatusNotFound, "unavailable", "connectors not available")
		return
	}
	var body struct {
		Connector string `json:"connector"`
	}
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	slug := strings.TrimSpace(body.Connector)
	if slug == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "connector is required")
		return
	}
	title, outcome, err := h.workspace.Connectors.AskReconnect(r.Context(), run.InvokerID, slug)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", toolRejection("reconnect", err,
			"use a connector slug the invoker has installed"))
		return
	}
	var text string
	switch outcome {
	case service.ReconnectLive:
		text = title + " is working — nothing to reconnect. Say so instead of sending them to re-do a sign-in."
	case service.ReconnectUnknown:
		text = title + " could not be reached just now, so its credential is neither confirmed dead nor working. Say that rather than guessing."
	default:
		// Be exact about what just happened. "I sent you a sign-in prompt"
		// invites the person to wait for a window that never opens: the
		// notification is a POINTER, and the sign-in happens in Connectors.
		text = title + ": flagged as expired and your invoker notified. Tell them to open Connectors " +
			"and press Reconnect on " + title + " — the sign-in happens there, nothing opens by itself."
	}
	writeJSON(w, http.StatusOK, JSON{"text": text})
}

// DisconnectConnector removes the invoker's install. Reversible by
// reconnecting, and only ever the invoker's own connector.
// POST /api/v1/agent/run/connectors/disconnect
func (h *AgentRunToolHandler) DisconnectConnector(w http.ResponseWriter, r *http.Request) {
	run, _ := h.liveRun(w, r)
	if run == nil {
		return
	}
	if h.workspace == nil || h.workspace.Connectors == nil {
		writeError(w, http.StatusNotFound, "unavailable", "connectors not available")
		return
	}
	var body struct {
		Connector string `json:"connector"`
	}
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	slug := strings.TrimSpace(body.Connector)
	if slug == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "connector is required")
		return
	}
	if !h.workspace.Connectors.IsInstalled(r.Context(), run.InvokerID, slug) {
		writeError(w, http.StatusBadRequest, "bad_request",
			"no connector "+slug+" is connected for this person — list what they have before disconnecting")
		return
	}
	if err := h.workspace.Connectors.Uninstall(r.Context(), run.InvokerID, slug); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", toolRejection("disconnect", err,
			"use a connector slug the invoker has installed"))
		return
	}
	writeJSON(w, http.StatusOK, JSON{"text": "disconnected /" + slug})
}

func (h *AgentRunToolHandler) SetReminder(w http.ResponseWriter, r *http.Request) {
	run, claims := h.liveRun(w, r)
	if run == nil {
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
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
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
	msgID := threadRef(body.MessageID)
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
		h.writeToolError(w, r, err)
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
	run, claims := h.liveRun(w, r)
	if run == nil {
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
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	var body struct {
		MessageID string `json:"message_id"`
		Pinned    *bool  `json:"pinned"` // default true
	}
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || body.MessageID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "message_id required")
		return
	}
	// Models copy ids straight from the bundle as [m:<id>] markers — accept
	// that form here like link_message does (live-tested: the raw marker used
	// to come back as "pin rejected").
	msgID := threadRef(body.MessageID)
	pinned := true
	if body.Pinned != nil {
		pinned = *body.Pinned
	}
	if _, err := h.messages.SetPinned(r.Context(), claims.UserID, run.ParentID, run.ParentType, msgID, pinned); err != nil {
		writeError(w, http.StatusForbidden, "forbidden",
			toolRejection("pin rejected", err, "the message must be in this run's own channel or DM"))
		return
	}
	action := "message_pinned"
	if !pinned {
		action = "message_unpinned"
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, action, map[string]any{"messageID": msgID})
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
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	if h.workspace == nil || h.workspace.Conversations == nil {
		writeError(w, http.StatusNotFound, "unavailable", "notify not available")
		return
	}
	var body struct {
		Body string `json:"body"`
	}
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "body required")
		return
	}
	// The DM between the creator (invoker) and this agent.
	conv, err := h.workspace.Conversations.GetOrCreateDM(r.Context(), claims.UserID, claims.ActorID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not open the owner DM: "+err.Error())
		return
	}
	text := h.orch.LinkifyMentions(r.Context(), run, body.Body)
	msg, err := h.messages.SendAsAgentRun(r.Context(), claims.ActorID, claims.UserID, conv.ID, service.ParentConversation, text, "", claims.RunID)
	if err != nil {
		writeError(w, http.StatusForbidden, "forbidden", toolRejection("notify rejected", err, ""))
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
	// A DELIBERATE approval only. This used to accept any approved approval on
	// the run, so a permission-gateway click ("allow reading main.go") licensed
	// a public post in a channel — exactly the thing reply mode exists to gate.
	approved, err := h.orch.HasDeliberateApproval(ctx, run.ID)
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
