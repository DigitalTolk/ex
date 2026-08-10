package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// OwnsThread reports whether a non-@mention message (a thread reply) is directed
// at Cliffy — true when Cliffy has already spoken in that thread.
// Satisfies service.BotHandler.
func (h *CliffyHandler) OwnsThread(ctx context.Context, rootMessageID string) bool {
	return h.inchat != nil && h.inchat.IsCliffyThread(ctx, rootMessageID)
}

// Handle satisfies service.BotHandler. Cliffy is a text-only bot: it never sets
// the attachment, identity-override, or ephemeral fields of a BotReply, so this
// adapts its reply text to the platform's richer reply shape.
func (h *CliffyHandler) Handle(ctx context.Context, req service.BotEvent) (service.BotReply, error) {
	text, err := h.handleTurn(ctx, req)
	if err != nil {
		return service.BotReply{}, err
	}
	return service.BotReply{Text: text}, nil
}

// handleTurn runs one in-chat Cliffy turn as the asking user and returns the reply
// text to post. It resolves a pending write-confirmation first ("yes"/"no"),
// otherwise runs the agent: a look-up/summary answers directly, a requested
// change is proposed and parked for confirmation (confirm-in-chat).
func (h *CliffyHandler) handleTurn(ctx context.Context, req service.BotEvent) (string, error) {
	if h.agentURL == "" {
		return "", fmt.Errorf("cliffy: agent not configured")
	}

	// The identity bridge mints a CliffHub token by email; resolve the asker's.
	email := ""
	if h.users != nil {
		if um, err := h.users.GetUsers(ctx, []string{req.AskerID}); err == nil {
			if u := um[req.AskerID]; u != nil {
				email = u.Email
			}
		}
	}
	if email == "" {
		return "", fmt.Errorf("cliffy: no email for asker %s", req.AskerID)
	}

	// A write proposed on a previous turn is waiting for this user's yes/no.
	if h.inchat != nil {
		if p, _ := h.inchat.GetPending(ctx, req.ParentID, req.AskerID); p != nil {
			switch classifyConfirm(req.Prompt) {
			case confirmYes:
				// Claim the pending write ATOMICALLY (GETDEL). If a duplicate
				// "yes" already claimed it, we get nil and must not re-execute.
				claimed, _ := h.inchat.TakePending(ctx, req.ParentID, req.AskerID)
				if claimed == nil {
					return "", nil
				}
				return h.executePending(ctx, req, email, claimed), nil
			case confirmNo:
				h.inchat.ClearPending(ctx, req.ParentID, req.AskerID)
				return "Okay — I won't do that. Let me know if there's anything else.", nil
			default:
				// An unrelated message abandons the parked proposal, so a later
				// "yes" can't fire a stale write; then run a fresh turn.
				h.inchat.ClearPending(ctx, req.ParentID, req.AskerID)
			}
		}
	}

	// Same per-user budgets the panel enforces (the agent loop has no cost cap);
	// over budget → drop silently.
	if !h.withinBudget(ctx, req.AskerID) {
		return "", nil
	}
	slog.Info("cliffy audit: inchat", "userID", req.AskerID, "parentType", req.ParentType, "parentID", req.ParentID)

	token, _, err := h.bridge.TokenFor(ctx, req.AskerID, email)
	if err != nil {
		return "Sorry — I can't act for you here. Your account isn't linked to CliffHub.", nil
	}

	// The chat's recent messages give Cliffy the context to resolve "this". Writes
	// are available (NOT readOnly) — the agent proposes them and we confirm below.
	transcript := h.buildTranscript(ctx, req.AskerID, req.ParentType, req.ParentID)

	// Prior turns of this Cliffy thread carry continuity (the task it proposed,
	// what "groom it" refers to, …); the current prompt is the final user turn.
	reqBody := h.agentRequestBody(req, transcript, req.Prompt)

	text, proposal, err := h.runAgentTurn(ctx, token, reqBody)
	if err != nil {
		return "", err
	}

	// This thread is now a Cliffy thread — replies here reach it without @cliffy.
	if h.inchat != nil {
		h.inchat.MarkThread(ctx, req.RootMessageID)
	}

	// The agent wants to make a change → park it and ask for confirmation.
	if proposal != nil && h.inchat != nil {
		if err := h.inchat.SetPending(ctx, req.ParentID, req.AskerID, proposal); err == nil {
			summary := strings.TrimSpace(proposal.Summary)
			if summary == "" {
				summary = proposal.Method + " " + proposal.Path
			}
			lead := ""
			if t := strings.TrimSpace(text); t != "" {
				lead = t + "\n\n"
			}
			return lead + "I'll **" + summary + "**.\n\nReply **yes** to go ahead, or **no** to cancel.", nil
		}
	}

	if strings.TrimSpace(text) == "" {
		return "I looked into that but didn't find anything to share.", nil
	}
	return text, nil
}

// executePending performs a confirmed write on the asker's behalf and returns a
// short confirmation (with a link when we can build one). On a validation
// failure it lets the agent correct the proposal once and retries — so a missing
// required field (e.g. a task's type_id dropped on a refinement turn) self-heals.
// Never returns an error that aborts the reply; failures come back as a note.
func (h *CliffyHandler) executePending(ctx context.Context, req service.BotEvent, email string, p *store.CliffyPendingWrite) string {
	status, body, err := h.executeWrite(ctx, req.AskerID, email, p)
	if err == nil && status >= 200 && status < 300 {
		return h.describeWriteResult(p, body)
	}
	if err != nil {
		slog.Warn("cliffy in-chat write failed", "path", p.Path, "error", err)
		return "Sorry — I couldn't complete that just now. Please try again."
	}

	// 4xx → ask the agent to fix the proposal once, then retry. The repair may
	// only correct FIELDS of the action the user already approved: if it comes
	// back pointing at a different method/path, we refuse to execute it (a repair
	// must never silently redirect an approved write to another resource).
	failBody := body
	if status >= 400 && status < 500 {
		if fixed := h.repairProposal(ctx, req, email, p, body); sameWriteTarget(fixed, p) {
			st2, body2, err2 := h.executeWrite(ctx, req.AskerID, email, fixed)
			if err2 == nil && st2 >= 200 && st2 < 300 {
				return h.describeWriteResult(fixed, body2)
			}
			failBody = body2 // report the retry's rejection, not the original
		}
	}
	if m := extractAPIMessage(failBody); m != "" {
		return "That didn't go through: " + m
	}
	return "That didn't go through — the system rejected it. You may need to adjust the details and try again."
}

// repairProposal re-runs the agent once, telling it the write failed and to
// re-issue the SAME action with the error corrected, and returns the corrected
// proposal (caller checks it still targets the approved method+path before
// executing). The directive is app-agnostic — ex does not know which fields any
// given app requires; the agent resolves that from the error, keeping CliffHub's
// (or any app's) write semantics out of ex core.
func (h *CliffyHandler) repairProposal(ctx context.Context, req service.BotEvent, email string, failed *store.CliffyPendingWrite, errBody []byte) *store.CliffyPendingWrite {
	token, _, err := h.bridge.TokenFor(ctx, req.AskerID, email)
	if err != nil {
		return nil
	}
	directive := fmt.Sprintf(
		"The user already approved this action, but the %s %s call was rejected with: %q. The attempted body was: %s. Re-issue the SAME action (same method and path) via writeApi with the error corrected — include every field the error indicates is required, resolving any needed reference values first. Do not change the target resource and do not ask the user anything; just call writeApi.",
		failed.Method, failed.Path, extractAPIMessage(errBody), string(failed.Body),
	)
	transcript := h.buildTranscript(ctx, req.AskerID, req.ParentType, req.ParentID)
	_, proposal, err := h.runAgentTurn(ctx, token, h.agentRequestBody(req, transcript, directive))
	if err != nil {
		return nil
	}
	return proposal
}

// sameWriteTarget reports whether a repaired proposal targets the exact same
// action (method + path) the user approved. A repair may correct the body, never
// redirect to a different verb or resource — so an agent turn can't turn an
// approved "create task" into an unapproved "delete project".
func sameWriteTarget(repaired, approved *store.CliffyPendingWrite) bool {
	return repaired != nil && approved != nil &&
		strings.EqualFold(strings.TrimSpace(repaired.Method), strings.TrimSpace(approved.Method)) &&
		strings.TrimLeft(repaired.Path, "/") == strings.TrimLeft(approved.Path, "/")
}

// agentRequestBody builds the agent request: the thread history as prior turns,
// then finalPrompt as the current user turn, plus the chat transcript as context.
func (h *CliffyHandler) agentRequestBody(req service.BotEvent, transcript []map[string]string, finalPrompt string) []byte {
	uiMsgs := make([]map[string]any, 0, len(req.History)+1)
	for _, m := range req.History {
		// m.Role is already exactly "user"/"assistant" (set by botThreadHistory).
		uiMsgs = append(uiMsgs, map[string]any{"role": m.Role, "parts": []map[string]any{{"type": "text", "text": m.Text}}})
	}
	uiMsgs = append(uiMsgs, map[string]any{"role": "user", "parts": []map[string]any{{"type": "text", "text": finalPrompt}}})
	b, _ := json.Marshal(map[string]any{
		"messages": uiMsgs,
		"context": map[string]any{
			"scope":    map[string]any{"type": req.ParentType, "id": req.ParentID},
			"messages": transcript,
		},
	})
	return b
}

// executeWrite runs one CliffHub write as the user via the shared passthrough
// (method allow-list, SSRF guard, bridged token, audit) and returns the status +
// response body.
func (h *CliffyHandler) executeWrite(ctx context.Context, userID, email string, p *store.CliffyPendingWrite) (int, []byte, error) {
	res, err := h.doCliffhubWrite(ctx, userID, email, "inchat write", cliffhubWriteInput{
		Method: p.Method, Path: p.Path, Query: p.Query, Body: p.Body,
	})
	if err != nil {
		return 0, nil, err
	}
	return res.Status, res.Body, nil
}

// cliffhubRecordRoutes maps a CliffHub write path prefix to the web route its
// created record lives at, so the confirmation can link to it.
//
// An explicit table rather than a substring test on the path: `strings.Contains(
// p.Path, "task")` looked like it covered tickets and did not ("tickets" has no
// "task" in it), so support tickets silently got no link while also being sent to
// a /tasks/<id> URL that would not have resolved. Longest prefix wins, so a more
// specific path can override a general one.
var cliffhubRecordRoutes = []struct{ pathPrefix, webRoute string }{
	{"api/support/tickets", "/support-tickets/"},
	{"api/work/tasks", "/tasks/"},
}

// describeWriteResult builds a short confirmation from the created record — with
// a CliffHub link when the record's web route is known, otherwise a plain "done".
func (h *CliffyHandler) describeWriteResult(p *store.CliffyPendingWrite, body []byte) string {
	// Field names differ per CliffHub resource: tasks expose ticket_key/title,
	// support tickets expose display_id/summary (SupportTicketResource). Accept
	// both, or the confirmation degrades to echoing the user's own request back.
	type record struct {
		ID        string `json:"id"`
		TicketKey string `json:"ticket_key"`
		DisplayID string `json:"display_id"`
		Title     string `json:"title"`
		Name      string `json:"name"`
		Summary   string `json:"summary"`
	}
	// Accept both {"data":{...}} (Laravel resource) and a flat object.
	var flat record
	var env struct {
		Data *record `json:"data"`
	}
	_ = json.Unmarshal(body, &flat)
	_ = json.Unmarshal(body, &env)
	r := flat
	if env.Data != nil {
		r = *env.Data
	}
	id, key, label := r.ID, r.TicketKey, r.Title
	if key == "" {
		key = r.DisplayID
	}
	if label == "" {
		label = r.Name
	}
	if label == "" {
		label = r.Summary
	}

	link := ""
	if h.webBase != "" && id != "" {
		if route := cliffhubWebRoute(p.Path); route != "" {
			link = h.webBase + route + id
		}
	}

	head := "✅ Done"
	switch {
	case key != "" && label != "":
		head = "✅ Created **" + key + "** — " + label
	case label != "":
		head = "✅ Created **" + label + "**"
	case strings.TrimSpace(p.Summary) != "":
		head = "✅ " + strings.TrimSpace(p.Summary)
	}
	if link != "" {
		return head + "\n" + link
	}
	return head + "."
}

// cliffhubWebRoute returns the web route for a write path, or "" when the record
// has no known page. Longest matching prefix wins so a specific path beats a
// general one regardless of table order.
func cliffhubWebRoute(path string) string {
	p := "/" + strings.TrimLeft(strings.TrimSpace(path), "/")
	route, longest := "", 0
	for _, r := range cliffhubRecordRoutes {
		prefix := "/" + strings.TrimLeft(r.pathPrefix, "/")
		if strings.HasPrefix(p, prefix) && len(prefix) > longest {
			route, longest = r.webRoute, len(prefix)
		}
	}
	return route
}

// runAgentTurn POSTs one turn to the agent and returns its text plus the first
// proposed write (if any).
func (h *CliffyHandler) runAgentTurn(ctx context.Context, token string, reqBody []byte) (string, *store.CliffyPendingWrite, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, h.agentURL, bytes.NewReader(reqBody))
	if err != nil {
		return "", nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")

	res, err := h.client.Do(httpReq)
	if err != nil {
		return "", nil, err
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", nil, fmt.Errorf("cliffy agent returned status %d", res.StatusCode)
	}
	return collectAgentTurn(res.Body)
}

// collectAgentTurn reads the agent's SSE stream: it concatenates text deltas and
// captures the first proposed writeApi tool call (the change to confirm). Because
// writeApi has no server-side execute, the agent emits the proposal and the turn
// ends — exactly what we park for confirmation.
func collectAgentTurn(r io.Reader) (string, *store.CliffyPendingWrite, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	var sb strings.Builder
	var errText string
	var proposal *store.CliffyPendingWrite
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[len("data:"):])
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var evt struct {
			Type      string          `json:"type"`
			Delta     string          `json:"delta"`
			ErrorText string          `json:"errorText"`
			ToolName  string          `json:"toolName"`
			Input     json.RawMessage `json:"input"`
		}
		if json.Unmarshal([]byte(payload), &evt) != nil {
			continue
		}
		switch evt.Type {
		case "text-delta":
			sb.WriteString(evt.Delta)
		case "tool-input-available":
			if evt.ToolName == "writeApi" && proposal == nil {
				var in struct {
					Method  string            `json:"method"`
					Path    string            `json:"path"`
					Query   map[string]string `json:"query"`
					Body    json.RawMessage   `json:"body"`
					Summary string            `json:"summary"`
				}
				if json.Unmarshal(evt.Input, &in) == nil && strings.TrimSpace(in.Path) != "" {
					proposal = &store.CliffyPendingWrite{Method: in.Method, Path: in.Path, Query: in.Query, Body: in.Body, Summary: in.Summary}
				}
			}
		case "error":
			errText = evt.ErrorText
		}
	}
	if err := sc.Err(); err != nil {
		return "", nil, err
	}
	text := strings.TrimSpace(sb.String())
	if text == "" && proposal == nil && errText != "" {
		return "", nil, fmt.Errorf("agent error: %s", errText)
	}
	return text, proposal, nil
}

const (
	confirmNone = iota
	confirmYes
	confirmNo
)

// classifyConfirm reads a reply as yes / no / neither, for resolving a parked
// write-confirmation. It matches ONLY bare affirmations/negations (exact, after
// trimming surrounding punctuation): a reply that carries extra instruction
// ("yes, but change the title", "no, make it urgent instead") is deliberately
// confirmNone so it falls through to a fresh turn and the correction is honored
// — rather than executing the un-amended write. Gating a cross-app write on a
// loose prefix match ("now do it" → no) is exactly what we don't want.
func classifyConfirm(s string) int {
	t := strings.ToLower(strings.Trim(strings.TrimSpace(s), " .!,"))
	switch t {
	case "y", "yes", "yep", "yeah", "yup", "ok", "okay", "sure", "please do",
		"go ahead", "do it", "create it", "confirm", "confirmed":
		return confirmYes
	case "n", "no", "nope", "nah", "no thanks", "stop", "cancel",
		"don't", "dont", "nevermind", "never mind":
		return confirmNo
	}
	return confirmNone
}

func extractAPIMessage(body []byte) string {
	var r struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &r) == nil {
		return strings.TrimSpace(r.Message)
	}
	return ""
}

// withinBudget applies the same per-user minute + day Cliffy budgets the panel
// uses, so in-chat @cliffy can't be used to sidestep them. Panel + in-chat share
// the keys. Fails OPEN when the limiter is unset or errors.
func (h *CliffyHandler) withinBudget(ctx context.Context, userID string) bool {
	if h.limiter == nil {
		return true
	}
	for _, b := range []struct {
		key    string
		limit  int
		window time.Duration
	}{
		{"cliffy:chat:" + userID, cliffyChatLimit, cliffyChatWindow},
		{"cliffy:chat:day:" + userID, cliffyChatDailyLimit, cliffyChatDailyWindow},
	} {
		if allowed, err := h.limiter.AllowRequest(ctx, b.key, b.limit, b.window); err == nil && !allowed {
			return false
		}
	}
	return true
}
