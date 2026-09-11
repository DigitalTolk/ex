package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/bedrock"
)

// bridgeReq is a snapshot of the last request the fake run API saw.
type bridgeReq struct {
	method, path, query, auth string
	body                      map[string]any
}

// bridgeHarness serves the bridged tools a scriptable fake run API and
// records the last request so payload shapes can be asserted.
type bridgeHarness struct {
	tools []bedrock.Tool
	srv   *httptest.Server

	mu     sync.Mutex
	status int
	resp   string
	req    bridgeReq
}

func newBridgeHarness(t *testing.T) *bridgeHarness {
	t.Helper()
	h := &bridgeHarness{status: http.StatusOK, resp: `{}`}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		h.mu.Lock()
		h.req = bridgeReq{method: r.Method, path: r.URL.EscapedPath(), query: r.URL.RawQuery, auth: r.Header.Get("Authorization"), body: body}
		status, resp := h.status, h.resp
		h.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(resp))
	}))
	t.Cleanup(h.srv.Close)
	h.tools = bridgeTools(&runAPI{base: h.srv.URL, token: "run-tok", http: h.srv.Client()})
	return h
}

func (h *bridgeHarness) respond(status int, resp string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.status, h.resp = status, resp
}

func (h *bridgeHarness) last() bridgeReq {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.req
}

func (h *bridgeHarness) call(t *testing.T, tool, input string) (string, bool) {
	t.Helper()
	return toolByName(t, h.tools, tool).Call(context.Background(), json.RawMessage(input))
}

func TestDescribeRunFailure(t *testing.T) {
	for _, tc := range []struct {
		status int
		data   map[string]any
		want   string
	}{
		{409, map[string]any{"error": "run_closed", "message": "done"}, "run is closed; stop all further work (done) [retryable=false]"},
		{409, map[string]any{"message": "out of order"}, "blocked: out of order — this step is out of order; do a different step, don't just retry [retryable=false]"},
		{403, map[string]any{"message": "nope"}, "not permitted: nope [retryable=false]"},
		{429, map[string]any{"message": "cap"}, "rate limited or post cap reached: cap [retryable=false]"},
		{502, map[string]any{"message": "boom"}, "failed: boom [retryable=true]"},
		{404, map[string]any{}, "failed: HTTP 404 [retryable=false]"},
	} {
		if got := describeRunFailure(tc.status, tc.data); got != tc.want {
			t.Fatalf("describeRunFailure(%d) = %q, want %q", tc.status, got, tc.want)
		}
	}
}

func TestRunAPI_CallArms(t *testing.T) {
	h := newBridgeHarness(t)
	api := &runAPI{base: h.srv.URL, token: "tok", http: h.srv.Client()}
	ctx := context.Background()

	// Error envelope flattening: {error:{code,message}} → top-level strings.
	h.respond(409, `{"error":{"code":"run_closed","message":"closed"}}`)
	status, data := api.call(ctx, "POST", "/x", map[string]any{"a": 1})
	if status != 409 || data["error"] != "run_closed" || data["message"] != "closed" {
		t.Fatalf("envelope not flattened: %d %+v", status, data)
	}
	if h.last().auth != "Bearer tok" {
		t.Fatalf("auth header: %q", h.last().auth)
	}
	// Envelope with neither field: nothing to flatten, no panic.
	h.respond(400, `{"error":{}}`)
	if _, data := api.call(ctx, "GET", "/x", nil); data["message"] != nil {
		t.Fatalf("empty envelope: %+v", data)
	}
	// A non-JSON body decodes to nothing; describeRunFailure falls back to HTTP n.
	h.respond(500, `plain text`)
	status, data = api.call(ctx, "GET", "/x", nil)
	if got := describeRunFailure(status, data); got != "failed: HTTP 500 [retryable=true]" {
		t.Fatalf("plain body: %q", got)
	}

	// Encode failure (marshalJSON seam).
	oldMarshal := marshalJSON
	marshalJSON = func(any) ([]byte, error) { return nil, errors.New("encode down") }
	if _, data := api.call(ctx, "POST", "/x", map[string]any{}); !strings.Contains(data["message"].(string), "request encode failed") {
		t.Fatalf("encode seam: %+v", data)
	}
	marshalJSON = oldMarshal

	// Request build failure (newRequest seam).
	oldNew := newRequest
	newRequest = func(context.Context, string, string, io.Reader) (*http.Request, error) {
		return nil, errors.New("build down")
	}
	if _, data := api.call(ctx, "GET", "/x", nil); !strings.Contains(data["message"].(string), "request build failed") {
		t.Fatalf("build seam: %+v", data)
	}
	newRequest = oldNew

	// Unreachable base.
	dead := &runAPI{base: "http://127.0.0.1:1", token: "tok", http: &http.Client{}}
	if _, data := dead.call(ctx, "GET", "/x", nil); !strings.Contains(data["message"].(string), "run API unreachable") {
		t.Fatalf("unreachable: %+v", data)
	}
}

func TestBridgeTools_BadInput(t *testing.T) {
	h := newBridgeHarness(t)
	h.respond(http.StatusTeapot, `{}`) // any HTTP call would show as a wrong error string
	for _, tc := range []struct{ tool, input, want string }{
		{"create_channel", `{}`, "requires a name"},
		{"join_channel", `{}`, "requires channelID"},
		{"read_channel", `{}`, "requires channelID"},
		{"post_to_channel", `{"channelID":"c"}`, "requires channelID and body"},
		{"search_messages", `{}`, "requires a query"},
		{"add_reaction", `{"messageID":"m"}`, "requires messageID and emoji"},
		{"send_dm", `{"userID":"u"}`, "requires userID and body"},
		{"propose_reply", `{}`, "requires text"},
		{"link_message", `{}`, "requires message_id"},
		{"set_reminder", `{}`, "requires in_minutes or remind_at"},
		{"cancel_reminder", `{}`, "requires reminder_id"},
		{"pin_message", `{}`, "requires message_id"},
		{"publish_artifact", `{"title":"t"}`, "requires title and content"},
		{"invoke_skill", `{}`, "requires skillID"},
		{"claim_task", `{}`, "requires a label"},
		{"update_memory", `{}`, "requires content"},
		{"create_coding_task", `{"project":"p"}`, "requires project, title and goal"},
	} {
		out, isErr := h.call(t, tc.tool, tc.input)
		if !isErr || !strings.Contains(out, tc.want) {
			t.Fatalf("%s bad input: err=%v %q", tc.tool, isErr, out)
		}
	}
}

// bridgeMinimalInputs is one valid input per bridged tool — the error-arm
// matrix below walks the whole table with it, which also pins the tool count.
var bridgeMinimalInputs = map[string]string{
	"list_channels":      `{}`,
	"create_channel":     `{"name":"x"}`,
	"join_channel":       `{"channelID":"c"}`,
	"read_channel":       `{"channelID":"c"}`,
	"post_to_channel":    `{"channelID":"c","body":"b"}`,
	"search_messages":    `{"query":"q"}`,
	"add_reaction":       `{"messageID":"m","emoji":"x"}`,
	"list_users":         `{}`,
	"send_dm":            `{"userID":"u","body":"b"}`,
	"propose_reply":      `{"text":"t"}`,
	"link_message":       `{"message_id":"m"}`,
	"set_reminder":       `{"in_minutes":5}`,
	"list_reminders":     `{}`,
	"cancel_reminder":    `{"reminder_id":"r"}`,
	"pin_message":        `{"message_id":"m"}`,
	"publish_artifact":   `{"title":"t","content":"c"}`,
	"list_skills":        `{}`,
	"invoke_skill":       `{"skillID":"s"}`,
	"claim_task":         `{"label":"l"}`,
	"update_memory":      `{"content":"c"}`,
	"create_coding_task": `{"project":"p","title":"t","goal":"g"}`,
	"set_state":          `{"state":"x"}`,
}

func TestBridgeTools_ErrorPropagation(t *testing.T) {
	h := newBridgeHarness(t)
	h.respond(500, `{"error":{"code":"x","message":"boom"}}`)
	if len(h.tools) != len(bridgeMinimalInputs) {
		t.Fatalf("input table out of sync: %d tools, %d inputs", len(h.tools), len(bridgeMinimalInputs))
	}
	for tool, input := range bridgeMinimalInputs {
		out, isErr := h.call(t, tool, input)
		if !isErr || out != "failed: boom [retryable=true]" {
			t.Fatalf("%s error arm: err=%v %q", tool, isErr, out)
		}
	}
}

func TestBridgeTools_Success(t *testing.T) {
	h := newBridgeHarness(t)

	// list_channels
	h.respond(200, `{"text":"~general"}`)
	if out, isErr := h.call(t, "list_channels", `{}`); isErr || out != "~general" {
		t.Fatalf("list_channels: %v %q", isErr, out)
	}
	if r := h.last(); r.method != "GET" || r.path != "/api/v1/agent/run/channels" {
		t.Fatalf("list_channels request: %+v", r)
	}

	// create_channel with all optionals
	h.respond(200, `{"channelID":"c9"}`)
	if out, isErr := h.call(t, "create_channel", `{"name":"plans","description":"d","private":true}`); isErr || out != "created ~plans (channelID=c9)" {
		t.Fatalf("create_channel: %v %q", isErr, out)
	}
	if r := h.last(); r.body["private"] != true || r.body["description"] != "d" {
		t.Fatalf("create_channel payload: %+v", r.body)
	}

	// join_channel — path-escaped id
	h.respond(200, `{}`)
	if out, isErr := h.call(t, "join_channel", `{"channelID":"c 1"}`); isErr || out != "joined" || !strings.Contains(h.last().path, "/channels/c%201/join") {
		t.Fatalf("join_channel: %v %q %s", isErr, out, h.last().path)
	}

	// read_channel — limit clamps to 50; empty falls back
	h.respond(200, `{"text":"msgs"}`)
	if out, _ := h.call(t, "read_channel", `{"channelID":"c","limit":80}`); out != "msgs" || h.last().query != "limit=50" {
		t.Fatalf("read_channel clamp: %q %s", out, h.last().query)
	}
	h.respond(200, `{}`)
	if out, _ := h.call(t, "read_channel", `{"channelID":"c"}`); out != "(channel is empty)" || h.last().query != "limit=30" {
		t.Fatalf("read_channel default: %q %s", out, h.last().query)
	}

	// post_to_channel with thread_root
	h.respond(200, `{"messageID":"m1"}`)
	if out, isErr := h.call(t, "post_to_channel", `{"channelID":"c","body":"hi","thread_root":"m0"}`); isErr || out != "posted (messageID=m1)" || h.last().body["thread_root"] != "m0" {
		t.Fatalf("post_to_channel: %v %q %+v", isErr, out, h.last().body)
	}

	// search_messages — limit clamps to 20; empty falls back
	h.respond(200, `{}`)
	if out, _ := h.call(t, "search_messages", `{"query":"a b","limit":99}`); out != "(no results)" || h.last().query != "q=a+b&limit=20" {
		t.Fatalf("search clamp: %q %s", out, h.last().query)
	}

	// add_reaction with channelID → parent fields
	h.respond(200, `{}`)
	if out, isErr := h.call(t, "add_reaction", `{"messageID":"m","emoji":"+1","channelID":"c"}`); isErr || out != "reaction toggled" {
		t.Fatalf("add_reaction: %v %q", isErr, out)
	}
	if r := h.last(); r.body["parentID"] != "c" || r.body["parentType"] != "channel" {
		t.Fatalf("add_reaction payload: %+v", r.body)
	}

	// list_users
	h.respond(200, `{}`)
	if out, _ := h.call(t, "list_users", `{"query":"al"}`); out != "(no matching users)" || h.last().query != "q=al" {
		t.Fatalf("list_users: %q %s", out, h.last().query)
	}

	// send_dm
	h.respond(200, `{"messageID":"m2"}`)
	if out, isErr := h.call(t, "send_dm", `{"userID":"u","body":"hi"}`); isErr || out != "sent (messageID=m2)" {
		t.Fatalf("send_dm: %v %q", isErr, out)
	}

	// propose_reply with optionals; then the text fallback
	h.respond(200, `{"text":"drafted — card sent"}`)
	if out, isErr := h.call(t, "propose_reply", `{"text":"draft","thread_root":"t0","reply_to":"m3"}`); isErr || out != "drafted — card sent" {
		t.Fatalf("propose_reply: %v %q", isErr, out)
	}
	if r := h.last(); r.body["thread_root"] != "t0" || r.body["reply_to"] != "m3" {
		t.Fatalf("propose_reply payload: %+v", r.body)
	}
	h.respond(200, `{}`)
	if out, _ := h.call(t, "propose_reply", `{"text":"draft"}`); out != "reply drafted for approval" {
		t.Fatalf("propose_reply fallback: %q", out)
	}

	// link_message: url, then text, then hard fallback
	h.respond(200, `{"url":"https://ex/m"}`)
	if out, isErr := h.call(t, "link_message", `{"message_id":"m","channel_id":"c","conversation_id":"dm","thread_root":"t"}`); isErr || out != "https://ex/m" {
		t.Fatalf("link_message url: %v %q", isErr, out)
	}
	if r := h.last(); r.body["channel_id"] != "c" || r.body["conversation_id"] != "dm" || r.body["thread_root"] != "t" {
		t.Fatalf("link_message payload: %+v", r.body)
	}
	h.respond(200, `{"text":"[msg](x)"}`)
	if out, _ := h.call(t, "link_message", `{"message_id":"m"}`); out != "[msg](x)" {
		t.Fatalf("link_message text: %q", out)
	}
	h.respond(200, `{}`)
	if out, _ := h.call(t, "link_message", `{"message_id":"m"}`); out != "link built" {
		t.Fatalf("link_message fallback: %q", out)
	}

	// set_reminder: in_minutes with anchor, then remind_at
	h.respond(200, `{}`)
	if out, isErr := h.call(t, "set_reminder", `{"in_minutes":5,"message_id":"m"}`); isErr || out != "reminder set" {
		t.Fatalf("set_reminder minutes: %v %q", isErr, out)
	}
	if r := h.last(); r.body["in_minutes"] != float64(5) || r.body["message_id"] != "m" {
		t.Fatalf("set_reminder payload: %+v", r.body)
	}
	h.respond(200, `{"text":"reminder at 10:00"}`)
	if out, _ := h.call(t, "set_reminder", `{"remind_at":"2026-09-11T10:00:00Z"}`); out != "reminder at 10:00" || h.last().body["remind_at"] != "2026-09-11T10:00:00Z" {
		t.Fatalf("set_reminder at: %q %+v", out, h.last().body)
	}

	// list_reminders fallback
	h.respond(200, `{}`)
	if out, _ := h.call(t, "list_reminders", `{}`); out != "(no pending reminders)" {
		t.Fatalf("list_reminders: %q", out)
	}

	// cancel_reminder — DELETE with escaped id
	h.respond(200, `{}`)
	if out, isErr := h.call(t, "cancel_reminder", `{"reminder_id":"r1"}`); isErr || out != "reminder canceled" {
		t.Fatalf("cancel_reminder: %v %q", isErr, out)
	}
	if r := h.last(); r.method != "DELETE" || !strings.HasSuffix(r.path, "/reminders/r1") {
		t.Fatalf("cancel_reminder request: %+v", r)
	}

	// pin_message with pinned=false
	h.respond(200, `{}`)
	if out, isErr := h.call(t, "pin_message", `{"message_id":"m","pinned":false}`); isErr || out != "pinned" || h.last().body["pinned"] != false {
		t.Fatalf("pin_message: %v %q %+v", isErr, out, h.last().body)
	}

	// publish_artifact — kind defaults to text
	h.respond(200, `{"artifactID":"a1"}`)
	if out, isErr := h.call(t, "publish_artifact", `{"title":"T","content":"C"}`); isErr || !strings.Contains(out, "published (artifactID=a1)") || h.last().body["kind"] != "text" {
		t.Fatalf("publish_artifact: %v %q %+v", isErr, out, h.last().body)
	}

	// list_skills: empty, then a listing
	h.respond(200, `{"skills":[]}`)
	if out, _ := h.call(t, "list_skills", `{}`); out != "(no skills defined in this workspace)" {
		t.Fatalf("list_skills empty: %q", out)
	}
	h.respond(200, `{"skills":[{"id":"s1","name":"Weekly","description":"summary"}]}`)
	if out, _ := h.call(t, "list_skills", `{}`); out != "[s:s1] Weekly — summary" {
		t.Fatalf("list_skills: %q", out)
	}

	// invoke_skill
	h.respond(200, `{"name":"Weekly","instructions":"do it"}`)
	if out, isErr := h.call(t, "invoke_skill", `{"skillID":"s1"}`); isErr || out != "# Skill: Weekly\n\ndo it" {
		t.Fatalf("invoke_skill: %v %q", isErr, out)
	}

	// claim_task: mine, then taken (with listing)
	h.respond(200, `{"mine":true,"claims":["hindi — by gg"]}`)
	if out, isErr := h.call(t, "claim_task", `{"label":"hindi"}`); isErr || !strings.Contains(out, "claimed — this part is yours.") || !strings.Contains(out, "- hindi — by gg") {
		t.Fatalf("claim_task mine: %v %q", isErr, out)
	}
	h.respond(200, `{"mine":false}`)
	if out, _ := h.call(t, "claim_task", `{"label":"hindi"}`); !strings.Contains(out, "already taken — pick a DIFFERENT part.") {
		t.Fatalf("claim_task taken: %q", out)
	}

	// update_memory
	h.respond(200, `{"text":"memory replaced"}`)
	if out, isErr := h.call(t, "update_memory", `{"content":"likes brevity"}`); isErr || out != "memory replaced" {
		t.Fatalf("update_memory: %v %q", isErr, out)
	}

	// create_coding_task with every optional; then the project_unknown coach
	h.respond(200, `{"taskID":"t1"}`)
	out, isErr := h.call(t, "create_coding_task", `{"project":"CliffHub","title":"Fix","goal":"green","kind":"fix","base_branch":"main","repos":[{"path":"g/x","role":"code"}]}`)
	if isErr || !strings.Contains(out, "coding task created (taskID=t1)") {
		t.Fatalf("create_coding_task: %v %q", isErr, out)
	}
	if r := h.last(); r.body["kind"] != "fix" || r.body["base_branch"] != "main" {
		t.Fatalf("create_coding_task payload: %+v", r.body)
	}
	if repos, ok := h.last().body["repos"].([]any); !ok || len(repos) != 1 {
		t.Fatalf("create_coding_task repos: %+v", h.last().body)
	}
	h.respond(409, `{"error":{"code":"project_unknown","message":"unknown product 'X'"}}`)
	out, isErr = h.call(t, "create_coding_task", `{"project":"X","title":"t","goal":"g"}`)
	if !isErr || !strings.Contains(out, "unknown product 'X'") || !strings.Contains(out, "ask_user") {
		t.Fatalf("create_coding_task unknown project: %v %q", isErr, out)
	}

	// set_state
	h.respond(200, `{}`)
	if out, isErr := h.call(t, "set_state", `{"state":"x"}`); isErr || out != "state updated" {
		t.Fatalf("set_state: %v %q", isErr, out)
	}
}
