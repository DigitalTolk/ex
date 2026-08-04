package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// The in-chat @cliffy turn: reading the agent's stream, parking a proposed write
// for confirmation, and executing it once approved. The pieces that need the
// Redis-backed pending store live in cliffy_inchat_pending_test.go.

// --- collectAgentTurn: the agent's SSE stream ------------------------------

func sseLines(events ...any) string {
	var sb strings.Builder
	for _, e := range events {
		switch v := e.(type) {
		case string:
			sb.WriteString(v + "\n\n")
		default:
			b, _ := json.Marshal(v)
			sb.WriteString("data: " + string(b) + "\n\n")
		}
	}
	return sb.String()
}

func TestCollectAgentTurn(t *testing.T) {
	t.Run("concatenates text deltas", func(t *testing.T) {
		body := sseLines(
			map[string]any{"type": "text-delta", "delta": "Hello "},
			map[string]any{"type": "text-delta", "delta": "world"},
			"data: [DONE]",
		)
		text, proposal, err := collectAgentTurn(strings.NewReader(body))
		if err != nil {
			t.Fatalf("collectAgentTurn: %v", err)
		}
		if text != "Hello world" || proposal != nil {
			t.Errorf("got (%q, %+v), want the joined text and no proposal", text, proposal)
		}
	})

	t.Run("captures the first writeApi proposal", func(t *testing.T) {
		// writeApi has no server-side execute: the agent emits the proposal and the
		// turn ends, which is exactly what gets parked for confirmation.
		body := sseLines(
			map[string]any{"type": "text-delta", "delta": "I'll create it. "},
			map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "POST", "path": "api/work/tasks", "summary": "create a task",
				"query": map[string]string{"project": "core"}, "body": map[string]any{"title": "Ship it"},
			}},
			// A second proposal must not replace the first.
			map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "DELETE", "path": "api/work/tasks/9",
			}},
		)
		text, proposal, err := collectAgentTurn(strings.NewReader(body))
		if err != nil {
			t.Fatalf("collectAgentTurn: %v", err)
		}
		if text != "I'll create it." {
			t.Errorf("text = %q", text)
		}
		if proposal == nil || proposal.Method != "POST" || proposal.Path != "api/work/tasks" ||
			proposal.Summary != "create a task" || proposal.Query["project"] != "core" {
			t.Fatalf("proposal = %+v, want the first writeApi call", proposal)
		}
		if !strings.Contains(string(proposal.Body), "Ship it") {
			t.Errorf("body = %s", proposal.Body)
		}
	})

	t.Run("ignores noise, other tools, and unparsable payloads", func(t *testing.T) {
		body := "ignored line\n\n" + sseLines(
			"data:",
			"data: [DONE]",
			"data: {not json",
			map[string]any{"type": "tool-input-available", "toolName": "readApi", "input": map[string]any{"path": "api/x"}},
			// A writeApi call with no path is not actionable.
			map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{"method": "POST", "path": "  "}},
			map[string]any{"type": "text-delta", "delta": "done"},
		)
		text, proposal, err := collectAgentTurn(strings.NewReader(body))
		if err != nil {
			t.Fatalf("collectAgentTurn: %v", err)
		}
		if text != "done" || proposal != nil {
			t.Errorf("got (%q, %+v), want only the text", text, proposal)
		}
	})

	t.Run("an error event with no other output is an error", func(t *testing.T) {
		body := sseLines(map[string]any{"type": "error", "errorText": "model exploded"})
		_, _, err := collectAgentTurn(strings.NewReader(body))
		if err == nil || !strings.Contains(err.Error(), "model exploded") {
			t.Fatalf("err = %v, want the agent's error text", err)
		}
	})

	t.Run("an error alongside usable output is not fatal", func(t *testing.T) {
		// A partial answer is better than none: the text is already useful.
		body := sseLines(
			map[string]any{"type": "text-delta", "delta": "here's what I found"},
			map[string]any{"type": "error", "errorText": "late failure"},
		)
		text, _, err := collectAgentTurn(strings.NewReader(body))
		if err != nil || text != "here's what I found" {
			t.Fatalf("got (%q, %v), want the partial text", text, err)
		}
	})

	t.Run("a read failure is reported", func(t *testing.T) {
		_, _, err := collectAgentTurn(failingReader{})
		if err == nil {
			t.Fatal("want the read error reported")
		}
	})

	t.Run("an empty stream yields nothing", func(t *testing.T) {
		text, proposal, err := collectAgentTurn(strings.NewReader(""))
		if err != nil || text != "" || proposal != nil {
			t.Errorf("got (%q, %+v, %v), want empty", text, proposal, err)
		}
	})
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("stream broke") }

func TestExtractAPIMessage(t *testing.T) {
	if got := extractAPIMessage([]byte(`{"message":"  Title is required  "}`)); got != "Title is required" {
		t.Errorf("got %q", got)
	}
	if got := extractAPIMessage([]byte(`not json`)); got != "" {
		t.Errorf("got %q, want empty", got)
	}
	if got := extractAPIMessage([]byte(`{}`)); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// --- agentRequestBody -----------------------------------------------------

func TestAgentRequestBody(t *testing.T) {
	h := &CliffyHandler{}
	body := h.agentRequestBody(service.BotEvent{
		ParentID: "ch1", ParentType: service.ParentChannel,
		History: []service.BotMessage{
			{Role: "user", Text: "first"},
			{Role: "assistant", Text: "answer"},
		},
	}, []map[string]string{{"author": "u1", "text": "context"}}, "the new question")

	var parsed struct {
		Messages []struct {
			Role  string `json:"role"`
			Parts []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"messages"`
		Context struct {
			Scope struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"scope"`
			Messages []map[string]string `json:"messages"`
		} `json:"context"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Thread history becomes prior turns; the prompt is the final user turn.
	if len(parsed.Messages) != 3 {
		t.Fatalf("messages = %d, want 3", len(parsed.Messages))
	}
	if parsed.Messages[0].Role != "user" || parsed.Messages[1].Role != "assistant" {
		t.Errorf("roles = %q/%q, want the history's own roles", parsed.Messages[0].Role, parsed.Messages[1].Role)
	}
	last := parsed.Messages[2]
	if last.Role != "user" || len(last.Parts) != 1 || last.Parts[0].Text != "the new question" {
		t.Errorf("final turn = %+v, want the prompt as a user turn", last)
	}
	if parsed.Context.Scope.ID != "ch1" || parsed.Context.Scope.Type != service.ParentChannel {
		t.Errorf("scope = %+v, want the chat it was asked in", parsed.Context.Scope)
	}
	if len(parsed.Context.Messages) != 1 {
		t.Errorf("transcript = %+v, want it carried as context", parsed.Context.Messages)
	}
}

// --- describeWriteResult --------------------------------------------------

func TestDescribeWriteResult(t *testing.T) {
	tests := []struct {
		name    string
		webBase string
		write   *store.CliffyPendingWrite
		body    string
		want    string
	}{
		{
			name:  "ticket key and title",
			write: &store.CliffyPendingWrite{Path: "api/work/tasks"},
			body:  `{"id":"7","ticket_key":"CORE-7","title":"Ship it"}`,
			want:  "✅ Created **CORE-7** — Ship it.",
		},
		{
			name:  "title only",
			write: &store.CliffyPendingWrite{Path: "api/work/tasks"},
			body:  `{"id":"7","title":"Ship it"}`,
			want:  "✅ Created **Ship it**.",
		},
		{
			// Laravel resources wrap the record in {"data": …}.
			name:  "envelope shape",
			write: &store.CliffyPendingWrite{Path: "api/work/tasks"},
			body:  `{"data":{"id":"7","title":"Wrapped"}}`,
			want:  "✅ Created **Wrapped**.",
		},
		{
			name:  "name instead of title",
			write: &store.CliffyPendingWrite{Path: "api/projects"},
			body:  `{"name":"Core"}`,
			want:  "✅ Created **Core**.",
		},
		{
			name:  "falls back to the approved summary",
			write: &store.CliffyPendingWrite{Path: "api/x", Summary: "archive the board"},
			body:  `{}`,
			want:  "✅ archive the board.",
		},
		{
			name:  "nothing identifiable",
			write: &store.CliffyPendingWrite{Path: "api/x"},
			body:  `{}`,
			want:  "✅ Done.",
		},
		{
			name:  "an unparsable body still confirms",
			write: &store.CliffyPendingWrite{Path: "api/x"},
			body:  `not json`,
			want:  "✅ Done.",
		},
		{
			// A link is only built for tasks, and only when we have both a web base
			// and an id — otherwise it would be a dead URL.
			name:    "task link when a web base is configured",
			webBase: "https://cliffhub.example",
			write:   &store.CliffyPendingWrite{Path: "api/work/tasks"},
			body:    `{"id":"7","title":"Ship it"}`,
			want:    "✅ Created **Ship it**\nhttps://cliffhub.example/tasks/7",
		},
		{
			name:    "no link for a non-task path",
			webBase: "https://cliffhub.example",
			write:   &store.CliffyPendingWrite{Path: "api/projects"},
			body:    `{"id":"7","name":"Core"}`,
			want:    "✅ Created **Core**.",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := &CliffyHandler{webBase: tc.webBase}
			if got := h.describeWriteResult(tc.write, []byte(tc.body)); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// --- withinBudget ---------------------------------------------------------

func TestWithinBudget(t *testing.T) {
	ctx := context.Background()

	t.Run("no limiter fails open", func(t *testing.T) {
		if !(&CliffyHandler{}).withinBudget(ctx, "u1") {
			t.Error("want the turn allowed with no limiter wired")
		}
	})

	t.Run("a limiter error fails open", func(t *testing.T) {
		// A broken limiter must not silence Cliffy entirely.
		h := &CliffyHandler{limiter: fakeLimiter{allow: false, err: errors.New("redis down")}}
		if !h.withinBudget(ctx, "u1") {
			t.Error("want the turn allowed when the limiter errors")
		}
	})

	t.Run("over budget stops the turn", func(t *testing.T) {
		h := &CliffyHandler{limiter: fakeLimiter{allow: false}}
		if h.withinBudget(ctx, "u1") {
			t.Error("want the turn refused when over budget")
		}
	})

	t.Run("within budget proceeds", func(t *testing.T) {
		h := &CliffyHandler{limiter: fakeLimiter{allow: true}}
		if !h.withinBudget(ctx, "u1") {
			t.Error("want the turn allowed")
		}
	})
}

// --- runAgentTurn ---------------------------------------------------------

func TestRunAgentTurn(t *testing.T) {
	ctx := context.Background()

	t.Run("injects the bridged token and returns the turn", func(t *testing.T) {
		var gotAuth string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			_, _ = io.WriteString(w, sseLines(map[string]any{"type": "text-delta", "delta": "hi"}))
		}))
		defer srv.Close()
		h := &CliffyHandler{agentURL: srv.URL, client: srv.Client()}

		text, _, err := h.runAgentTurn(ctx, "tok-1", []byte(`{}`))
		if err != nil {
			t.Fatalf("runAgentTurn: %v", err)
		}
		if text != "hi" {
			t.Errorf("text = %q", text)
		}
		// The token is injected server-side — it never reaches the browser.
		if gotAuth != "Bearer tok-1" {
			t.Errorf("Authorization = %q", gotAuth)
		}
	})

	t.Run("a non-2xx agent response is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		}))
		defer srv.Close()
		h := &CliffyHandler{agentURL: srv.URL, client: srv.Client()}
		if _, _, err := h.runAgentTurn(ctx, "tok", []byte(`{}`)); err == nil {
			t.Fatal("want an error for a failing agent")
		}
	})

	t.Run("an unreachable agent is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		h := &CliffyHandler{agentURL: srv.URL, client: srv.Client()}
		srv.Close()
		if _, _, err := h.runAgentTurn(ctx, "tok", []byte(`{}`)); err == nil {
			t.Fatal("want a transport error")
		}
	})

	t.Run("an unbuildable agent URL is an error", func(t *testing.T) {
		h := &CliffyHandler{agentURL: "http://exa mple.com/\x7f", client: &http.Client{}}
		if _, _, err := h.runAgentTurn(ctx, "tok", []byte(`{}`)); err == nil {
			t.Fatal("want a request-construction error")
		}
	})
}

// --- OwnsThread / Handle --------------------------------------------------

// Without an in-chat store there are no thread markers, so Cliffy claims nothing.
func TestOwnsThread_NoStore(t *testing.T) {
	if (&CliffyHandler{}).OwnsThread(context.Background(), "root1") {
		t.Error("want false with no in-chat store")
	}
}

// Handle adapts Cliffy's text to the platform's reply shape; it never sets the
// attachment, identity-override, or ephemeral fields.
func TestHandle_AdaptsToBotReply(t *testing.T) {
	h := &CliffyHandler{} // no agent configured → handleTurn errors
	reply, err := h.Handle(context.Background(), service.BotEvent{AskerID: "u1"})
	if err == nil {
		t.Fatal("want the unconfigured-agent error surfaced")
	}
	if !reply.Empty() {
		t.Errorf("reply = %+v, want empty on error", reply)
	}
}

func TestHandleTurn_Preconditions(t *testing.T) {
	ctx := context.Background()

	t.Run("an unconfigured agent is an error", func(t *testing.T) {
		if _, err := (&CliffyHandler{}).handleTurn(ctx, service.BotEvent{AskerID: "u1"}); err == nil {
			t.Fatal("want an error when the agent is not configured")
		}
	})

	t.Run("no resolvable email is an error", func(t *testing.T) {
		// The bridge mints by email; without one there is no CliffHub identity.
		h := &CliffyHandler{agentURL: "https://agent.example/chat"}
		if _, err := h.handleTurn(ctx, service.BotEvent{AskerID: "u1"}); err == nil {
			t.Fatal("want an error with no email resolver")
		}
		h.users = fakeCliffyUsers{}
		if _, err := h.handleTurn(ctx, service.BotEvent{AskerID: "u1"}); err == nil {
			t.Fatal("want an error when the user has no email")
		}
	})

	t.Run("over budget answers nothing", func(t *testing.T) {
		// Silently dropping is deliberate: an over-budget user gets no reply rather
		// than a confusing error in the channel.
		h := &CliffyHandler{
			agentURL: "https://agent.example/chat",
			users:    fakeCliffyUsers{"u1": "u1@example.com"},
			limiter:  fakeLimiter{allow: false},
		}
		text, err := h.handleTurn(ctx, service.BotEvent{AskerID: "u1"})
		if err != nil || text != "" {
			t.Fatalf("got (%q, %v), want a silent drop", text, err)
		}
	})
}

// fakeCliffyUsers resolves ex user ids to emails.
type fakeCliffyUsers map[string]string

func (f fakeCliffyUsers) GetUsers(_ context.Context, ids []string) (map[string]*model.User, error) {
	out := map[string]*model.User{}
	for _, id := range ids {
		if email, ok := f[id]; ok {
			out[id] = &model.User{ID: id, Email: email}
		}
	}
	return out, nil
}

// A user lookup failure is treated as "no email" rather than propagating.
type failingCliffyUsers struct{}

func (failingCliffyUsers) GetUsers(context.Context, []string) (map[string]*model.User, error) {
	return nil, errors.New("dynamo down")
}

func TestHandleTurn_UserLookupFailure(t *testing.T) {
	h := &CliffyHandler{agentURL: "https://agent.example/chat", users: failingCliffyUsers{}}
	if _, err := h.handleTurn(context.Background(), service.BotEvent{AskerID: "u1"}); err == nil {
		t.Fatal("want an error when the email cannot be resolved")
	}
}

// cliffyTurnEnv wires a handler against a stub CliffHub (mint + agent + write).
type cliffyTurnEnv struct {
	handler *CliffyHandler
	agent   *stubAgent
	srv     *httptest.Server
}

// stubAgent is a programmable CliffHub stub: it mints a token, serves the agent
// stream, and answers writes.
type stubAgent struct {
	mintStatus int
	// stream is the SSE body for the next agent turn; repairStream, when set, is
	// served from the second turn on (the repair attempt).
	stream       string
	repairStream string
	turns        int
	// writeStatus / writeBody drive the write endpoint; the second element of each
	// is used from the second write on (the retry after a repair).
	writeStatus []int
	writeBody   []string
	writes      int
	lastWrite   string
}

func (s *stubAgent) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ai/bridge/mint", func(w http.ResponseWriter, _ *http.Request) {
		if s.mintStatus != 0 && s.mintStatus != http.StatusOK {
			w.WriteHeader(s.mintStatus)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "minted-tok", "token_type": "Bearer",
			"expires_at": time.Now().Add(15 * time.Minute),
		})
	})
	mux.HandleFunc("/api/ai/bridge/revoke", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/api/ai/chat", func(w http.ResponseWriter, _ *http.Request) {
		s.turns++
		body := s.stream
		if s.turns > 1 && s.repairStream != "" {
			body = s.repairStream
		}
		_, _ = io.WriteString(w, body)
	})
	mux.HandleFunc("/api/work/tasks", func(w http.ResponseWriter, r *http.Request) {
		s.writes++
		s.lastWrite = r.Method
		status, body := http.StatusCreated, `{"id":"7","title":"Ship it"}`
		if len(s.writeStatus) > 0 {
			idx := min(s.writes-1, len(s.writeStatus)-1)
			status = s.writeStatus[idx]
		}
		if len(s.writeBody) > 0 {
			idx := min(s.writes-1, len(s.writeBody)-1)
			body = s.writeBody[idx]
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func setupCliffyTurn(t *testing.T, agent *stubAgent) *cliffyTurnEnv {
	t.Helper()
	srv := agent.server(t)
	bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
		Secret: testBridgeSecret, MintURL: srv.URL + "/api/ai/bridge/mint", HTTPClient: srv.Client(),
		Cache: newBridgeMemCache(),
	})
	if err != nil || bridge == nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	h := NewCliffyHandler(CliffyHandlerConfig{
		Bridge:    bridge,
		AgentURL:  srv.URL + "/api/ai/chat",
		APIOrigin: srv.URL,
		WebBase:   "https://cliffhub.example",
		Users:     fakeCliffyUsers{"u1": "u1@example.com"},
	})
	h.client = srv.Client()
	return &cliffyTurnEnv{handler: h, agent: agent, srv: srv}
}

func TestHandleTurn_PlainAnswer(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(map[string]any{"type": "text-delta", "delta": "Three tasks are open."}),
	})
	text, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "how many tasks?",
	})
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if text != "Three tasks are open." {
		t.Errorf("text = %q", text)
	}
}

// An agent that answers with nothing still gets a reply — silence in a channel
// reads as the bot being broken.
func TestHandleTurn_EmptyAnswerGetsAStandIn(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{stream: sseLines("data: [DONE]")})
	text, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "hmm",
	})
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if !strings.Contains(text, "didn't find anything") {
		t.Errorf("text = %q, want the stand-in reply", text)
	}
}

// A user with no CliffHub identity gets an explanation, not an error — the bot
// still has to say something in the channel.
func TestHandleTurn_NoCliffHubAccount(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{mintStatus: http.StatusForbidden})
	text, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "hi",
	})
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if !strings.Contains(text, "isn't linked to CliffHub") {
		t.Errorf("text = %q, want the unlinked-account explanation", text)
	}
}

func TestHandleTurn_AgentFailureIsAnError(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(map[string]any{"type": "error", "errorText": "model exploded"}),
	})
	if _, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "hi",
	}); err == nil {
		t.Fatal("want the agent failure surfaced so the dispatcher posts an apology")
	}
}

// Without an in-chat store, a proposed write cannot be parked for confirmation —
// so it must not be executed either. The turn falls back to the agent's text.
func TestHandleTurn_ProposalWithoutAStoreIsNotExecuted(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(
			map[string]any{"type": "text-delta", "delta": "I can do that."},
			map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "POST", "path": "api/work/tasks", "summary": "create a task",
			}},
		),
	})
	text, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "make a task",
	})
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if text != "I can do that." {
		t.Errorf("text = %q, want the agent's text with no confirmation prompt", text)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0 — an unconfirmed write must never execute", env.agent.writes)
	}
}

// --- executeWrite / executePending (no pending store needed) --------------

func TestExecuteWrite(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{})
	status, body, err := env.handler.executeWrite(context.Background(), "u1", "u1@example.com",
		&store.CliffyPendingWrite{Method: "POST", Path: "api/work/tasks", Body: json.RawMessage(`{"title":"Ship it"}`)})
	if err != nil {
		t.Fatalf("executeWrite: %v", err)
	}
	if status != http.StatusCreated || !strings.Contains(string(body), "TASK") && !strings.Contains(string(body), "Ship it") {
		t.Errorf("got (%d, %s)", status, body)
	}
	if env.agent.lastWrite != http.MethodPost {
		t.Errorf("method = %q, want POST", env.agent.lastWrite)
	}
}

func TestExecutePending(t *testing.T) {
	ctx := context.Background()
	approved := &store.CliffyPendingWrite{
		Method: "POST", Path: "api/work/tasks", Summary: "create a task",
		Body: json.RawMessage(`{"title":"Ship it"}`),
	}
	req := service.BotEvent{AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel}

	t.Run("a successful write is confirmed with a link", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		got := env.handler.executePending(ctx, req, "u1@example.com", approved)
		if !strings.Contains(got, "Created") || !strings.Contains(got, "/tasks/7") {
			t.Errorf("got %q, want a confirmation with the task link", got)
		}
	})

	t.Run("a transport failure is reported as a retryable note", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.srv.Close() // closed → the write cannot be made
		got := env.handler.executePending(ctx, req, "u1@example.com", approved)
		if !strings.Contains(got, "couldn't complete that") {
			t.Errorf("got %q, want a retryable note", got)
		}
	})

	t.Run("a 5xx is reported with the API's message", func(t *testing.T) {
		// Not a 4xx, so no repair attempt — just report what the API said.
		env := setupCliffyTurn(t, &stubAgent{
			writeStatus: []int{http.StatusInternalServerError},
			writeBody:   []string{`{"message":"database is down"}`},
		})
		got := env.handler.executePending(ctx, req, "u1@example.com", approved)
		if !strings.Contains(got, "database is down") {
			t.Errorf("got %q, want the API's message", got)
		}
		if env.agent.turns != 0 {
			t.Errorf("agent turns = %d, want 0 — a 5xx is not repairable", env.agent.turns)
		}
	})

	t.Run("a 4xx is repaired once and retried", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{
			writeStatus: []int{http.StatusUnprocessableEntity, http.StatusCreated},
			writeBody:   []string{`{"message":"type_id is required"}`, `{"id":"9","title":"Fixed"}`},
			// The repair turn re-issues the SAME method+path with corrected fields.
			stream: sseLines(map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "POST", "path": "api/work/tasks", "summary": "create a task",
				"body": map[string]any{"title": "Fixed", "type_id": 3},
			}}),
		})
		got := env.handler.executePending(ctx, req, "u1@example.com", approved)
		if !strings.Contains(got, "Fixed") {
			t.Errorf("got %q, want the retry's confirmation", got)
		}
		if env.agent.writes != 2 {
			t.Errorf("writes = %d, want 2 (original + retry)", env.agent.writes)
		}
	})

	t.Run("a repair that retargets the write is refused", func(t *testing.T) {
		// A repair may only correct FIELDS of the approved action — never redirect
		// it to a different verb or resource.
		env := setupCliffyTurn(t, &stubAgent{
			writeStatus: []int{http.StatusUnprocessableEntity},
			writeBody:   []string{`{"message":"nope"}`},
			stream: sseLines(map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "DELETE", "path": "api/work/tasks/9",
			}}),
		})
		got := env.handler.executePending(ctx, req, "u1@example.com", approved)
		if !strings.Contains(got, "nope") {
			t.Errorf("got %q, want the original rejection reported", got)
		}
		if env.agent.writes != 1 {
			t.Errorf("writes = %d, want 1 — a retargeted repair must not execute", env.agent.writes)
		}
	})

	t.Run("a 4xx with no repairable proposal reports a generic note", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{
			writeStatus: []int{http.StatusBadRequest},
			writeBody:   []string{`not json`},
			stream:      sseLines("data: [DONE]"),
		})
		got := env.handler.executePending(ctx, req, "u1@example.com", approved)
		if !strings.Contains(got, "system rejected it") {
			t.Errorf("got %q, want the generic rejection note", got)
		}
	})
}

func TestRepairProposal_BridgeFailure(t *testing.T) {
	// No CliffHub identity → no repair turn, so the caller reports the original
	// rejection instead.
	env := setupCliffyTurn(t, &stubAgent{mintStatus: http.StatusForbidden})
	got := env.handler.repairProposal(context.Background(),
		service.BotEvent{AskerID: "u1"}, "u1@example.com",
		&store.CliffyPendingWrite{Method: "POST", Path: "api/work/tasks"}, []byte(`{}`))
	if got != nil {
		t.Errorf("repairProposal = %+v, want nil", got)
	}
}

func TestRepairProposal_AgentFailure(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(map[string]any{"type": "error", "errorText": "boom"}),
	})
	got := env.handler.repairProposal(context.Background(),
		service.BotEvent{AskerID: "u1"}, "u1@example.com",
		&store.CliffyPendingWrite{Method: "POST", Path: "api/work/tasks"}, []byte(`{}`))
	if got != nil {
		t.Errorf("repairProposal = %+v, want nil", got)
	}
}

// The repair directive must carry the failure so the agent can correct it, and
// must be app-agnostic — ex does not know which fields any app requires.
func TestRepairProposal_SendsTheFailureToTheAgent(t *testing.T) {
	var sentBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/mint"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "tok", "expires_at": time.Now().Add(time.Hour),
			})
		default:
			b, _ := io.ReadAll(r.Body)
			sentBody = string(b)
			_, _ = io.WriteString(w, sseLines(map[string]any{
				"type": "tool-input-available", "toolName": "writeApi",
				"input": map[string]any{"method": "POST", "path": "api/work/tasks"},
			}))
		}
	}))
	defer srv.Close()

	bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
		Secret: testBridgeSecret, MintURL: srv.URL + "/mint", HTTPClient: srv.Client(),
	})
	if err != nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	h := NewCliffyHandler(CliffyHandlerConfig{Bridge: bridge, AgentURL: srv.URL + "/chat"})
	h.client = srv.Client()

	fixed := h.repairProposal(context.Background(),
		service.BotEvent{AskerID: "u1"}, "u1@example.com",
		&store.CliffyPendingWrite{Method: "POST", Path: "api/work/tasks"},
		[]byte(`{"message":"type_id is required"}`))
	if fixed == nil {
		t.Fatal("want a corrected proposal")
	}
	if !strings.Contains(sentBody, "type_id is required") {
		t.Errorf("repair prompt did not carry the failure: %s", sentBody)
	}
}

// A stringly-typed sanity check that the write path refuses read methods, which
// is what keeps the passthrough from becoming a general proxy.
func TestExecuteWrite_RejectsReadMethod(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{})
	_, _, err := env.handler.executeWrite(context.Background(), "u1", "u1@example.com",
		&store.CliffyPendingWrite{Method: http.MethodGet, Path: "api/work/tasks"})
	if err == nil {
		t.Fatal("want a rejection for a read method on the write passthrough")
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0", env.agent.writes)
	}
}

// --- the confirm-first race, and the remaining executePending arm ----------

// stubPendingStore is a programmable cliffyPendingStore. It exists so the
// duplicate-"yes" race is deterministic: GetPending can report a parked write
// while TakePending reports it already claimed, which is exactly what the loser
// of two concurrent confirmations sees.
type stubPendingStore struct {
	pending   *store.CliffyPendingWrite
	takeNil   bool
	setErr    error
	threads   map[string]bool
	cleared   int
	setCalls  int
	takeCalls int
}

func newStubPendingStore() *stubPendingStore {
	return &stubPendingStore{threads: map[string]bool{}}
}

func (s *stubPendingStore) SetPending(_ context.Context, _, _ string, p *store.CliffyPendingWrite) error {
	s.setCalls++
	if s.setErr != nil {
		return s.setErr
	}
	s.pending = p
	return nil
}

func (s *stubPendingStore) GetPending(_ context.Context, _, _ string) (*store.CliffyPendingWrite, error) {
	return s.pending, nil
}

func (s *stubPendingStore) TakePending(_ context.Context, _, _ string) (*store.CliffyPendingWrite, error) {
	s.takeCalls++
	if s.takeNil {
		return nil, nil
	}
	p := s.pending
	s.pending = nil
	return p, nil
}

func (s *stubPendingStore) ClearPending(_ context.Context, _, _ string) {
	s.cleared++
	s.pending = nil
}

func (s *stubPendingStore) MarkThread(_ context.Context, rootID string) { s.threads[rootID] = true }

func (s *stubPendingStore) IsCliffyThread(_ context.Context, rootID string) bool {
	return s.threads[rootID]
}

// The loser of two concurrent "yes" replies sees the write already claimed and
// must stay silent — re-running the turn could propose the same write again.
func TestHandleTurn_DuplicateConfirmationStaysSilent(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{})
	ps := newStubPendingStore()
	ps.pending = &store.CliffyPendingWrite{Method: "POST", Path: "api/work/tasks"}
	ps.takeNil = true // another "yes" already claimed it
	env.handler.inchat = ps

	text, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "yes",
	})
	if err != nil || text != "" {
		t.Fatalf("got (%q, %v), want a silent no-op", text, err)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0 — the write must not run twice", env.agent.writes)
	}
	if env.agent.turns != 0 {
		t.Errorf("agent turns = %d, want 0 — a claimed confirmation must not re-run the agent", env.agent.turns)
	}
}

// When the repaired retry ALSO fails, the reply reports the retry's rejection
// rather than the original one — that is the message describing what is still wrong.
func TestExecutePending_ReportsTheRetrysRejection(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		writeStatus: []int{http.StatusUnprocessableEntity, http.StatusUnprocessableEntity},
		writeBody:   []string{`{"message":"type_id is required"}`, `{"message":"type_id 3 does not exist"}`},
		stream: sseLines(map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
			"method": "POST", "path": "api/work/tasks",
		}}),
	})
	got := env.handler.executePending(context.Background(),
		service.BotEvent{AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel},
		"u1@example.com",
		&store.CliffyPendingWrite{Method: "POST", Path: "api/work/tasks"})
	if !strings.Contains(got, "does not exist") {
		t.Errorf("got %q, want the retry's rejection, not the original", got)
	}
}

// Handle's success path wraps the turn's text into a BotReply.
func TestHandle_WrapsTheReplyText(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(map[string]any{"type": "text-delta", "delta": "Three are open."}),
	})
	reply, err := env.handler.Handle(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "how many?",
	})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if reply.Text != "Three are open." {
		t.Errorf("Text = %q", reply.Text)
	}
	// Cliffy is text-only: it never sets these.
	if len(reply.Attachments) != 0 || reply.Username != "" || reply.IconURL != "" || reply.Ephemeral {
		t.Errorf("reply = %+v, want text only", reply)
	}
}

// A parking failure must not promise a confirmation that could never be honored.
func TestHandleTurn_ParkingFailureFallsBackToText(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(
			map[string]any{"type": "text-delta", "delta": "Here's the plan."},
			map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "POST", "path": "api/work/tasks", "summary": "create a task",
			}},
		),
	})
	ps := newStubPendingStore()
	ps.setErr = errors.New("redis down")
	env.handler.inchat = ps

	text, err := env.handler.handleTurn(context.Background(), service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel, Prompt: "make a task",
	})
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if strings.Contains(text, "Reply **yes**") {
		t.Errorf("text = %q, want no confirmation prompt when parking failed", text)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0", env.agent.writes)
	}
}

// OwnsThread delegates to the store.
func TestOwnsThread_DelegatesToTheStore(t *testing.T) {
	ps := newStubPendingStore()
	h := &CliffyHandler{inchat: ps}
	if h.OwnsThread(context.Background(), "root1") {
		t.Error("want false for an unmarked thread")
	}
	ps.MarkThread(context.Background(), "root1")
	if !h.OwnsThread(context.Background(), "root1") {
		t.Error("want true for a marked thread")
	}
}

// Regression guard for the typed-nil trap: inchat is an interface, so a nil
// *store.CliffyInChatStore must not be stored in it — otherwise every
// `h.inchat != nil` guard passes and then dereferences a nil pointer.
func TestNewCliffyHandler_NilInChatStoreLeavesWritesDisabled(t *testing.T) {
	bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
		Secret: testBridgeSecret, MintURL: "https://cliffhub.example/api/ai/bridge/mint",
	})
	if err != nil || bridge == nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	h := NewCliffyHandler(CliffyHandlerConfig{Bridge: bridge, InChatStore: nil})
	if h.inchat != nil {
		t.Fatal("a nil in-chat store must leave the field nil, not a typed-nil interface")
	}
	// Both guarded call sites must be safe with in-chat writes disabled.
	if h.OwnsThread(context.Background(), "root1") {
		t.Error("OwnsThread should be false with no store")
	}
}

// A disabled bridge means Cliffy is off entirely, so the router skips its routes.
func TestNewCliffyHandler_NilBridgeDisablesCliffy(t *testing.T) {
	if h := NewCliffyHandler(CliffyHandlerConfig{}); h != nil {
		t.Errorf("NewCliffyHandler = %+v, want nil when the bridge is disabled", h)
	}
}

// bridgeMemCache is an in-memory BridgeTokenCache, so a minted token survives the
// stub CliffHub going away. That is what makes the arms *after* a successful mint
// (request construction, transport failure) reachable in tests.
type bridgeMemCache struct{ data map[string][]byte }

func newBridgeMemCache() *bridgeMemCache { return &bridgeMemCache{data: map[string][]byte{}} }

func (c *bridgeMemCache) Get(_ context.Context, key string, dest any) error {
	b, ok := c.data[key]
	if !ok {
		return errors.New("miss")
	}
	return json.Unmarshal(b, dest)
}

func (c *bridgeMemCache) Set(_ context.Context, key string, val any, _ time.Duration) error {
	b, err := json.Marshal(val)
	if err != nil {
		return err
	}
	c.data[key] = b
	return nil
}

func (c *bridgeMemCache) Delete(_ context.Context, key string) error {
	delete(c.data, key)
	return nil
}

// warmBridgeToken mints once so the cache holds a token, letting the caller take
// CliffHub down and still get past the bridge.
func warmBridgeToken(t *testing.T, env *cliffyTurnEnv) {
	t.Helper()
	if _, _, err := env.handler.bridge.TokenFor(context.Background(), "u1", "u1@example.com"); err != nil {
		t.Fatalf("warm token: %v", err)
	}
}
