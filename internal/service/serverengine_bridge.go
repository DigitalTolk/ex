package service

// The server engine's workspace-parity layer: every portable runner tool,
// driven through the SAME run-tool HTTP API the desktop runner speaks —
// loopback, authed with the run's own token — so post caps, watch-mode
// gating, audit events and error contracts are inherited from the real
// handlers instead of re-implemented. The tool table below transcribes the
// runner's MCP dispatch (ex-electron src/runner/mcp-server.ts), minus what is
// local-only there (shell/files/web, spill files, the CLI permission gateway)
// and what the engine already runs in-process (thread/context/post/notify,
// connectors, approvals).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/DigitalTolk/ex/internal/bedrock"
)

// runAPI is the engine's loopback client for the run-tool HTTP surface.
type runAPI struct {
	base  string
	token string
	http  *http.Client
}

// call performs one authed run-API request, returning the status and the
// decoded body with any {error:{code,message}} envelope flattened to top-level
// "error"/"message" — the same shape the runner's callBackend hands its tools.
func (r *runAPI) call(ctx context.Context, method, path string, body any) (int, map[string]any) {
	var reader *bytes.Reader
	if body != nil {
		b, err := marshalJSON(body)
		if err != nil {
			return 0, map[string]any{"message": "request encode failed: " + err.Error()}
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := newRequest(ctx, method, r.base+path, reader)
	if err != nil {
		return 0, map[string]any{"message": "request build failed: " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := r.http.Do(req)
	if err != nil {
		return 0, map[string]any{"message": "run API unreachable: " + err.Error()}
	}
	defer func() { _ = res.Body.Close() }()
	data := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&data)
	if env, ok := data["error"].(map[string]any); ok {
		if code, ok := env["code"].(string); ok {
			data["error"] = code
		}
		if msg, ok := env["message"].(string); ok {
			data["message"] = msg
		}
	}
	return res.StatusCode, data
}

// describeRunFailure is the runner's describeFailure, ported verbatim: a
// structured, actionable rejection so the model knows retry vs stop.
func describeRunFailure(status int, data map[string]any) string {
	msg, _ := data["message"].(string)
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d", status)
	}
	switch {
	case status == 409:
		if code, _ := data["error"].(string); code == "run_closed" {
			return "run is closed; stop all further work (" + msg + ") [retryable=false]"
		}
		return "blocked: " + msg + " — this step is out of order; do a different step, don't just retry [retryable=false]"
	case status == 403:
		return "not permitted: " + msg + " [retryable=false]"
	case status == 429:
		return "rate limited or post cap reached: " + msg + " [retryable=false]"
	case status >= 500:
		return "failed: " + msg + " [retryable=true]"
	default:
		return "failed: " + msg + " [retryable=false]"
	}
}

func dataStr(data map[string]any, key, fallback string) string {
	if s, ok := data[key].(string); ok && s != "" {
		return s
	}
	return fallback
}

// obj / str / num are schema shorthands for the tool table.
func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}
func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func num(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }

// bridgeTools is the transcription of the runner's portable workspace tools.
func bridgeTools(api *runAPI) []bedrock.Tool {
	type in = map[string]any
	parse := func(raw json.RawMessage) in {
		v := in{}
		_ = json.Unmarshal(raw, &v)
		return v
	}
	s := func(v in, key string) string {
		out, _ := v[key].(string)
		return strings.TrimSpace(out)
	}
	// simple is the no-argument GET shape (list_channels, list_reminders):
	// call, propagate failure, hand back one text field.
	simple := func(method, path, okKey, okFallback string) func(context.Context, json.RawMessage) (string, bool) {
		return func(ctx context.Context, _ json.RawMessage) (string, bool) {
			status, data := api.call(ctx, method, path, nil)
			if status < 200 || status >= 300 {
				return describeRunFailure(status, data), true
			}
			return dataStr(data, okKey, okFallback), false
		}
	}

	return []bedrock.Tool{
		{
			Name:        "list_channels",
			Description: "List the channels your invoker can see (id, name, topic).",
			Schema:      obj(in{}),
			Call:        simple("GET", "/api/v1/agent/run/channels", "text", "(no channels)"),
		},
		{
			Name:        "create_channel",
			Description: "Create a channel as your invoker. Actions beyond what was asked need request_approval first.",
			Schema: obj(in{"name": str("Channel name."), "description": str("Optional topic."), "private": map[string]any{"type": "boolean", "description": "Private channel."}},
				"name"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				name := s(v, "name")
				if name == "" {
					return "create_channel requires a name", true
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/channels", in{"name": name, "description": s(v, "description"), "private": v["private"] == true})
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "created ~" + name + " (channelID=" + dataStr(data, "channelID", "?") + ")", false
			},
		},
		{
			Name:        "join_channel",
			Description: "Join a public channel as your invoker (needed before reading or posting there).",
			Schema:      obj(in{"channelID": str("Channel id ([ch:<id>]).")}, "channelID"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				id := s(parse(raw), "channelID")
				if id == "" {
					return "join_channel requires channelID", true
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/channels/"+url.PathEscape(id)+"/join", nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "joined", false
			},
		},
		{
			Name: "read_channel",
			Description: "Read a channel with your invoker's access. Without thread: recent TOP-LEVEL messages only " +
				"(replies are hidden; [thread: N replies] marks where they live). With thread (any message id from " +
				"that thread — a permalink's #msg-<id> works): that thread's actual messages. When a task points at " +
				"a message or thread, read it here directly — do not reconstruct it from search.",
			Schema: obj(in{
				"channelID": str("Channel id."),
				"thread":    str("Any message id inside the thread to read (bare id or [m:<id>]); omit for the channel's top level."),
				"limit":     num("Messages to read (max 50, default 30)."),
			}, "channelID"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				id := s(v, "channelID")
				if id == "" {
					return "read_channel requires channelID", true
				}
				limit := 30
				if n, ok := v["limit"].(float64); ok && n > 0 {
					limit = int(n)
					if limit > 50 {
						limit = 50
					}
				}
				path := "/api/v1/agent/run/channels/" + url.PathEscape(id) + "/messages?limit=" + fmt.Sprint(limit)
				if thread := s(v, "thread"); thread != "" {
					path += "&thread=" + url.QueryEscape(thread)
				}
				status, data := api.call(ctx, "GET", path, nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "(no messages)"), false
			},
		},
		{
			Name: "read_pins",
			Description: "List a channel's pinned messages — the durable decisions, links and reference posts " +
				"members chose to keep visible. Check pins before asking a human for standing facts about a channel.",
			Schema: obj(in{"channelID": str("Channel id.")}, "channelID"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				id := s(parse(raw), "channelID")
				if id == "" {
					return "read_pins requires channelID", true
				}
				status, data := api.call(ctx, "GET", "/api/v1/agent/run/channels/"+url.PathEscape(id)+"/pins", nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "(no pinned messages)"), false
			},
		},
		{
			Name: "read_dm",
			Description: "Read your INVOKER's own direct-message history with one user (they already see it in the " +
				"app). Use it when the task references something said in a DM; accepts the same thread narrowing " +
				"as read_channel.",
			Schema: obj(in{
				"userID": str("The other participant's user id (from list_users or an @-mention)."),
				"thread": str("Optional: any message id inside a DM thread to read just that thread."),
				"limit":  num("Messages to read (max 50, default 30)."),
			}, "userID"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				uid := s(v, "userID")
				if uid == "" {
					return "read_dm requires userID", true
				}
				limit := 30
				if n, ok := v["limit"].(float64); ok && n > 0 {
					limit = int(n)
					if limit > 50 {
						limit = 50
					}
				}
				path := "/api/v1/agent/run/dm/" + url.PathEscape(uid) + "/messages?limit=" + fmt.Sprint(limit)
				if thread := s(v, "thread"); thread != "" {
					path += "&thread=" + url.QueryEscape(thread)
				}
				status, data := api.call(ctx, "GET", path, nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "(no messages with that user)"), false
			},
		},
		{
			Name:        "post_to_channel",
			Description: "Post a message to another channel (counts against your post cap; watch modes that bar public posts bar this too).",
			Schema:      obj(in{"channelID": str("Channel id."), "body": str("Message body (markdown)."), "thread_root": str("Optional [m:<id>] to reply into a thread.")}, "channelID", "body"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				id, body := s(v, "channelID"), s(v, "body")
				if id == "" || body == "" {
					return "post_to_channel requires channelID and body", true
				}
				payload := in{"body": body}
				if tr := s(v, "thread_root"); tr != "" {
					payload["thread_root"] = tr
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/channels/"+url.PathEscape(id)+"/messages", payload)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "posted (messageID=" + dataStr(data, "messageID", "?") + ")", false
			},
		},
		{
			Name: "search_messages",
			Description: "Full-text search across the workspace with your invoker's access — for DISCOVERY, when " +
				"you have no handle on where something lives. When you already hold a message id, permalink, " +
				"channel or user, read the source directly (read_channel / read_dm / read_pins) instead: search " +
				"returns scattered single messages, never a whole conversation.",
			Schema:      obj(in{"query": str("Search terms."), "limit": num("Max results (default 10, max 20).")}, "query"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				q := s(v, "query")
				if q == "" {
					return "search_messages requires a query", true
				}
				limit := 10
				if n, ok := v["limit"].(float64); ok && n > 0 {
					limit = int(n)
					if limit > 20 {
						limit = 20
					}
				}
				status, data := api.call(ctx, "GET", "/api/v1/agent/run/search?q="+url.QueryEscape(q)+"&limit="+fmt.Sprint(limit), nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "(no results)"), false
			},
		},
		{
			Name:        "add_reaction",
			Description: "Toggle an emoji reaction on a message (e.g. acknowledge without a post).",
			Schema:      obj(in{"messageID": str("Target message id ([m:<id>])."), "emoji": str("Emoji shortcode or literal."), "channelID": str("Channel id when the message is outside this run's parent.")}, "messageID", "emoji"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				msgID, emoji := s(v, "messageID"), s(v, "emoji")
				if msgID == "" || emoji == "" {
					return "add_reaction requires messageID and emoji", true
				}
				payload := in{"messageID": msgID, "emoji": emoji}
				if ch := s(v, "channelID"); ch != "" {
					payload["parentID"] = ch
					payload["parentType"] = "channel"
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/reactions", payload)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "reaction toggled", false
			},
		},
		{
			Name:        "list_users",
			Description: "Find workspace members by name/email fragment — ids for DMs and mentions.",
			Schema:      obj(in{"query": str("Name or email fragment (empty = everyone).")}),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				status, data := api.call(ctx, "GET", "/api/v1/agent/run/users?q="+url.QueryEscape(s(parse(raw), "query")), nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "(no matching users)"), false
			},
		},
		{
			Name:        "send_dm",
			Description: "Send a direct message as the agent, on your invoker's behalf (counts against the post cap). DMing people beyond what was asked: request_approval first.",
			Schema:      obj(in{"userID": str("Recipient user id."), "body": str("Message body.")}, "userID", "body"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				uid, body := s(v, "userID"), s(v, "body")
				if uid == "" || body == "" {
					return "send_dm requires userID and body", true
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/dm", in{"userID": uid, "body": body})
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "sent (messageID=" + dataStr(data, "messageID", "?") + ")", false
			},
		},
		{
			Name:        "propose_reply",
			Description: "Draft a reply for the invoker to approve — it posts only when they accept (the reply channel for reply-mode watchers).",
			Schema:      obj(in{"text": str("The drafted reply."), "thread_root": str("Optional thread root [m:<id>]."), "reply_to": str("Optional message being answered.")}, "text"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				text := s(v, "text")
				if text == "" {
					return "propose_reply requires text (your drafted reply)", true
				}
				payload := in{"text": text}
				if tr := s(v, "thread_root"); tr != "" {
					payload["thread_root"] = tr
				}
				if rt := s(v, "reply_to"); rt != "" {
					payload["reply_to"] = rt
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/propose-reply", payload)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "reply drafted for approval"), false
			},
		},
		{
			Name:        "link_message",
			Description: "Turn a message reference into a clickable permalink for your reply — always prefer this over pasting a raw [m:<id>] marker.",
			Schema:      obj(in{"message_id": str("The message (bare id or [m:<id>])."), "channel_id": str("Optional channel if not the current one."), "conversation_id": str("Optional DM id."), "thread_root": str("Optional thread root.")}, "message_id"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				msgID := s(v, "message_id")
				if msgID == "" {
					return "link_message requires message_id", true
				}
				payload := in{"message_id": msgID}
				for _, k := range []string{"channel_id", "conversation_id", "thread_root"} {
					if val := s(v, k); val != "" {
						payload[k] = val
					}
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/link-message", payload)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "url", dataStr(data, "text", "link built")), false
			},
		},
		{
			Name:        "set_reminder",
			Description: "Set a reminder for YOUR INVOKER — fires into their notifications, anchored to a message in this thread. Give in_minutes or remind_at (RFC3339 UTC).",
			Schema:      obj(in{"in_minutes": num("Minutes from now."), "remind_at": str("Absolute time, RFC3339 UTC."), "message_id": str("Optional anchor message.")}),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				payload := in{}
				if n, ok := v["in_minutes"].(float64); ok {
					payload["in_minutes"] = n
				}
				if at := s(v, "remind_at"); at != "" {
					payload["remind_at"] = at
				}
				if len(payload) == 0 {
					return "set_reminder requires in_minutes or remind_at", true
				}
				if m := s(v, "message_id"); m != "" {
					payload["message_id"] = m
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/reminders", payload)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "reminder set"), false
			},
		},
		{
			Name:        "list_reminders",
			Description: "List your invoker's pending reminders set through agents.",
			Schema:      obj(in{}),
			Call:        simple("GET", "/api/v1/agent/run/reminders", "text", "(no pending reminders)"),
		},
		{
			Name:        "cancel_reminder",
			Description: "Cancel one of the invoker's pending reminders by id.",
			Schema:      obj(in{"reminder_id": str("Reminder id from list_reminders.")}, "reminder_id"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				id := s(parse(raw), "reminder_id")
				if id == "" {
					return "cancel_reminder requires reminder_id", true
				}
				status, data := api.call(ctx, "DELETE", "/api/v1/agent/run/reminders/"+url.PathEscape(id), nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "reminder canceled"), false
			},
		},
		{
			Name:        "pin_message",
			Description: "Pin (or unpin) a message in this conversation as your invoker.",
			Schema:      obj(in{"message_id": str("The message to pin ([m:<id>])."), "pinned": map[string]any{"type": "boolean", "description": "false to unpin (default true)."}}, "message_id"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				msgID := s(v, "message_id")
				if msgID == "" {
					return "pin_message requires message_id", true
				}
				payload := in{"message_id": msgID}
				if b, ok := v["pinned"].(bool); ok {
					payload["pinned"] = b
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/pins", payload)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "pinned"), false
			},
		},
		{
			Name:        "publish_artifact",
			Description: "Attach a titled document (report, table, long output) to this run's activity drawer instead of flooding the chat; reference it by title in your reply.",
			Schema:      obj(in{"title": str("Artifact title."), "content": str("Full content."), "kind": str("Optional kind (text default).")}, "title", "content"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				title, content := s(v, "title"), s(v, "content")
				if title == "" || content == "" {
					return "publish_artifact requires title and content", true
				}
				kind := s(v, "kind")
				if kind == "" {
					kind = "text"
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/artifacts", in{"kind": kind, "title": title, "content": content})
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "published (artifactID=" + dataStr(data, "artifactID", "?") + ") — visible in this run's activity drawer; reference it by title in your reply", false
			},
		},
		{
			Name:        "list_skills",
			Description: "List the workspace's skills (reusable instruction packs) with their ids.",
			Schema:      obj(in{}),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				status, data := api.call(ctx, "GET", "/api/v1/agent/run/skills", nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				skills, _ := data["skills"].([]any)
				if len(skills) == 0 {
					return "(no skills defined in this workspace)", false
				}
				var lines []string
				for _, sk := range skills {
					m, _ := sk.(map[string]any)
					lines = append(lines, "[s:"+dataStr(m, "id", "?")+"] "+dataStr(m, "name", "?")+" — "+dataStr(m, "description", ""))
				}
				return strings.Join(lines, "\n"), false
			},
		},
		{
			Name:        "invoke_skill",
			Description: "Load one skill's full instructions by id and follow them for the current task.",
			Schema:      obj(in{"skillID": str("Skill id from list_skills.")}, "skillID"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				id := s(parse(raw), "skillID")
				if id == "" {
					return "invoke_skill requires skillID", true
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/skills/"+url.PathEscape(id), nil)
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "# Skill: " + dataStr(data, "name", id) + "\n\n" + dataStr(data, "instructions", ""), false
			},
		},
		{
			Name:        "claim_task",
			Description: "Claim one named part of a shared task so parallel agents don't collide — a taken label means pick a DIFFERENT part.",
			Schema:      obj(in{"label": str("Short label of the part you're taking.")}, "label"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				label := s(parse(raw), "label")
				if label == "" {
					return "claim_task requires a label", true
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/claims", in{"label": label})
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				var listing string
				if claims, _ := data["claims"].([]any); len(claims) > 0 {
					var lines []string
					for _, c := range claims {
						lines = append(lines, fmt.Sprintf("- %v", c))
					}
					listing = "\ncurrent claims:\n" + strings.Join(lines, "\n")
				}
				if data["mine"] == true {
					return "claimed — this part is yours." + listing, false
				}
				return "already taken — pick a DIFFERENT part." + listing, false
			},
		},
		{
			Name: "update_memory",
			Description: "Replace your standing memory for THIS INVOKER — durable preferences and context that should shape future runs. " +
				"Send the complete new text; it overwrites the old.",
			Schema: obj(in{"content": str("The full replacement memory text.")}, "content"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				content := s(parse(raw), "content")
				if content == "" {
					return "update_memory requires content", true
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/memory", in{"content": content})
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "memory updated"), false
			},
		},
		{
			Name: "create_coding_task",
			Description: "Hand CODING WORK (bug fix, feature, dev ticket) to the dev agent — never attempt it here. project = the PRODUCT name; " +
				"repos = its GitLab repositories with roles. For an unknown product, ask the invoker which repos make it up first.",
			Schema: obj(in{
				"project":     str("Product name, e.g. 'CliffHub'."),
				"title":       str("Short task title."),
				"goal":        str("What done looks like."),
				"repos":       map[string]any{"type": "array", "description": "Repos with roles when the project is new.", "items": map[string]any{"type": "object"}},
				"kind":        str("Optional kind (fix/feature/chore)."),
				"base_branch": str("Optional base branch."),
			}, "project", "title", "goal"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				v := parse(raw)
				project, title, goal := s(v, "project"), s(v, "title"), s(v, "goal")
				if project == "" || title == "" || goal == "" {
					return "create_coding_task requires project, title and goal", true
				}
				payload := in{"project": project, "title": title, "goal": goal}
				for _, k := range []string{"kind", "base_branch"} {
					if val := s(v, k); val != "" {
						payload[k] = val
					}
				}
				if repos, ok := v["repos"].([]any); ok && len(repos) > 0 {
					payload["repos"] = repos
				}
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/coding-task", payload)
				if status < 200 || status >= 300 {
					if status == 409 && dataStr(data, "error", "") == "project_unknown" {
						return dataStr(data, "message", "unknown project") + " — ask the invoker (ask_user) which GitLab repositories make up this product and their roles, then call create_coding_task again with repos [retryable=true]", true
					}
					return describeRunFailure(status, data), true
				}
				return dataStr(data, "text", "coding task created (taskID="+dataStr(data, "taskID", "?")+") — the dev agent takes it from here; end your turn after telling the invoker"), false
			},
		},
		{
			Name:        "set_state",
			Description: "Set your status emoji on the invoking message (e.g. \"🔎\" while researching).",
			Schema:      obj(in{"state": str("A single emoji.")}, "state"),
			Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
				status, data := api.call(ctx, "POST", "/api/v1/agent/run/state", in{"state": s(parse(raw), "state")})
				if status < 200 || status >= 300 {
					return describeRunFailure(status, data), true
				}
				return "state updated", false
			},
		},
	}
}
