package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Round-trip proof: connect an MCP client to the ex MCP server over an in-memory
// transport and call a tool. Confirms server + tool registration + client +
// transport + typed in/out all work end to end.
func TestMCPServer_ToolRoundTrip(t *testing.T) {
	ctx := context.Background()
	clientT, serverT := mcp.NewInMemoryTransports()

	server := NewMCPServer(nil)
	serverSession, err := server.Connect(ctx, serverT, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer func() { _ = serverSession.Close() }()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	cs, err := client.Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	// Tools are discoverable.
	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := map[string]bool{}
	for _, tl := range tools.Tools {
		names[tl.Name] = true
	}
	if !names["ping"] || !names["whoami"] {
		t.Fatalf("expected ping + whoami tools, got %v", names)
	}

	// Call ping and read the structured output.
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{
		Name:      "ping",
		Arguments: map[string]any{"message": "hello mcp"},
	})
	if err != nil {
		t.Fatalf("call ping: %v", err)
	}
	if res.IsError {
		t.Fatalf("ping returned error: %+v", res.Content)
	}
	var out pingOut
	if res.StructuredContent != nil {
		if m, ok := res.StructuredContent.(map[string]any); ok {
			if s, _ := m["reply"].(string); s != "" {
				out.Reply = s
			}
		}
	}
	if out.Reply != "pong: hello mcp" {
		t.Errorf("ping reply = %q, want %q", out.Reply, "pong: hello mcp")
	}
}

// sentMsg records one MCPChat.Send call.
type sentMsg struct{ uid, parentID, parentType, body, root string }

// fakeChat is a stand-in for *service.MessageService in tool tests: it records
// what identity each tool acted with and returns canned data.
type fakeChat struct {
	sent []sentMsg
	list []*model.Message
}

func (f *fakeChat) Send(_ context.Context, uid, parentID, parentType, body, parentMessageID string, _ ...string) (*model.Message, error) {
	f.sent = append(f.sent, sentMsg{uid, parentID, parentType, body, parentMessageID})
	return &model.Message{ID: "m-new"}, nil
}

func (f *fakeChat) List(_ context.Context, _, _, _, _ string, _ int) ([]*model.Message, bool, error) {
	return f.list, false, nil
}

// injectClaims mimics AuthWithBots: it stamps an authenticated identity onto the
// request context so the MCP tools see the caller exactly as the real
// middleware would present them.
func injectClaims(uid string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := middleware.ContextWithClaims(r.Context(), &model.TokenClaims{UserID: uid})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Full-stack proof: the MCP server behind an auth-injecting middleware, reached
// over real HTTP by the SDK client. Confirms (1) the authenticated identity
// flows from the request context into the tool handlers, and (2) the chat tools
// act as that caller against the service. This is the "live tools/call with a
// bot token" milestone, run hermetically.
func TestMCPServer_HTTPToolsRunAsCaller(t *testing.T) {
	ctx := context.Background()
	chat := &fakeChat{list: []*model.Message{
		{ID: "m1", AuthorID: "u-alice", Body: "hi there", CreatedAt: time.Unix(1_700_000_000, 0).UTC()},
	}}

	srv := httptest.NewServer(injectClaims("bot_test", NewMCPHTTPHandler(chat)))
	defer srv.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	cs, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: srv.URL, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	structured := func(res *mcp.CallToolResult) map[string]any {
		if res.IsError {
			for _, c := range res.Content {
				if tc, ok := c.(*mcp.TextContent); ok {
					t.Logf("tool error text: %s", tc.Text)
				}
			}
			t.Fatalf("tool returned error (%d content parts)", len(res.Content))
		}
		m, ok := res.StructuredContent.(map[string]any)
		if !ok {
			t.Fatalf("structured content not an object: %#v", res.StructuredContent)
		}
		return m
	}

	// whoami — the authenticated identity flows through the HTTP boundary.
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "whoami"})
	if err != nil {
		t.Fatalf("call whoami: %v", err)
	}
	who := structured(res)
	if who["user_id"] != "bot_test" {
		t.Errorf("whoami user_id = %v, want bot_test", who["user_id"])
	}
	if who["is_bot"] != true {
		t.Errorf("whoami is_bot = %v, want true", who["is_bot"])
	}

	// postMessage — posts as the caller into the given channel.
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{
		Name:      "postMessage",
		Arguments: map[string]any{"channel_id": "c-1", "text": "hello from mcp"},
	})
	if err != nil {
		t.Fatalf("call postMessage: %v", err)
	}
	if id := structured(res)["message_id"]; id != "m-new" {
		t.Errorf("postMessage message_id = %v, want m-new", id)
	}
	if len(chat.sent) != 1 {
		t.Fatalf("expected 1 Send, got %d", len(chat.sent))
	}
	if got := chat.sent[0]; got.uid != "bot_test" || got.parentID != "c-1" || got.parentType != "channel" || got.body != "hello from mcp" {
		t.Errorf("Send called with %+v, want caller bot_test into channel c-1", got)
	}

	// readChannel — reads messages the caller can access.
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{
		Name:      "readChannel",
		Arguments: map[string]any{"channel_id": "c-1"},
	})
	if err != nil {
		t.Fatalf("call readChannel: %v", err)
	}
	read := structured(res)
	msgs, ok := read["messages"].([]any)
	if !ok || len(msgs) != 1 {
		t.Fatalf("readChannel messages = %#v, want 1 message", read["messages"])
	}
	first, _ := msgs[0].(map[string]any)
	if first["author_id"] != "u-alice" || first["text"] != "hi there" {
		t.Errorf("readChannel first message = %#v, want u-alice/hi there", first)
	}
}

// mcpToolSession connects a client to an in-memory MCP server whose tools see
// uid as the caller, mirroring what AuthWithBots stamps on a real request.
func mcpToolSession(t *testing.T, chat MCPChat, uid string) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	if uid != "" {
		ctx = middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: uid})
	}
	clientT, serverT := mcp.NewInMemoryTransports()
	serverSession, err := NewMCPServer(chat).Connect(ctx, serverT, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	cs, err := client.Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

// callToolErr calls a tool and returns the error text, requiring a failure.
func callToolErr(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) string {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return err.Error()
	}
	if !res.IsError {
		t.Fatalf("%s(%v) succeeded, want an error", name, args)
	}
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

// A tool must refuse to act when the request carried no identity — every tool
// runs as the caller, so no caller means no authority.
func TestMCPServer_ToolsRequireAnIdentity(t *testing.T) {
	cs := mcpToolSession(t, &fakeChat{}, "")

	for _, name := range []string{"postMessage", "readChannel"} {
		args := map[string]any{"channel_id": "ch1"}
		if name == "postMessage" {
			args["text"] = "hi"
		}
		if got := callToolErr(t, cs, name, args); !strings.Contains(got, "unauthenticated") {
			t.Errorf("%s error = %q, want unauthenticated", name, got)
		}
	}
}

func TestMCPServer_ToolArgumentValidation(t *testing.T) {
	cs := mcpToolSession(t, &fakeChat{}, "bot_x")

	t.Run("channel_type must be a known parent type", func(t *testing.T) {
		got := callToolErr(t, cs, "postMessage", map[string]any{
			"channel_id": "ch1", "text": "hi", "channel_type": "team",
		})
		if !strings.Contains(got, "channel_type") {
			t.Errorf("error = %q, want a channel_type rejection", got)
		}
		got = callToolErr(t, cs, "readChannel", map[string]any{
			"channel_id": "ch1", "channel_type": "team",
		})
		if !strings.Contains(got, "channel_type") {
			t.Errorf("error = %q, want a channel_type rejection", got)
		}
	})

	t.Run("postMessage requires a channel and non-blank text", func(t *testing.T) {
		for _, args := range []map[string]any{
			{"channel_id": "", "text": "hi"},
			{"channel_id": "ch1", "text": "   "},
		} {
			if got := callToolErr(t, cs, "postMessage", args); !strings.Contains(got, "required") {
				t.Errorf("postMessage(%v) error = %q, want a required-fields rejection", args, got)
			}
		}
	})

	t.Run("readChannel requires a channel", func(t *testing.T) {
		// An explicit empty string, not an absent key: the SDK's schema check would
		// reject the latter before the tool body runs.
		if got := callToolErr(t, cs, "readChannel", map[string]any{"channel_id": ""}); !strings.Contains(got, "required") {
			t.Errorf("error = %q, want a required-fields rejection", got)
		}
	})
}

// A service failure surfaces as a tool error rather than a silent empty result.
func TestMCPServer_ToolsReportServiceFailures(t *testing.T) {
	cs := mcpToolSession(t, &failingChat{}, "bot_x")

	if got := callToolErr(t, cs, "postMessage", map[string]any{"channel_id": "ch1", "text": "hi"}); !strings.Contains(got, "chat down") {
		t.Errorf("postMessage error = %q, want the service failure", got)
	}
	if got := callToolErr(t, cs, "readChannel", map[string]any{"channel_id": "ch1"}); !strings.Contains(got, "chat down") {
		t.Errorf("readChannel error = %q, want the service failure", got)
	}
}

type failingChat struct{}

func (failingChat) Send(context.Context, string, string, string, string, string, ...string) (*model.Message, error) {
	return nil, errors.New("chat down")
}

func (failingChat) List(context.Context, string, string, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, errors.New("chat down")
}

// The read limit is clamped: unset falls back to a default, and an over-large
// request is capped rather than letting a bot pull an unbounded page.
func TestMCPServer_ReadChannelClampsLimit(t *testing.T) {
	chat := &limitRecordingChat{}
	cs := mcpToolSession(t, chat, "bot_x")

	for _, tc := range []struct {
		name string
		args map[string]any
		want int
	}{
		{name: "unset uses the default", args: map[string]any{"channel_id": "ch1"}, want: mcpReadDefaultLimit},
		{name: "zero uses the default", args: map[string]any{"channel_id": "ch1", "limit": 0}, want: mcpReadDefaultLimit},
		{name: "negative uses the default", args: map[string]any{"channel_id": "ch1", "limit": -5}, want: mcpReadDefaultLimit},
		{name: "over-large is capped", args: map[string]any{"channel_id": "ch1", "limit": mcpReadMaxLimit + 500}, want: mcpReadMaxLimit},
		{name: "in range is honoured", args: map[string]any{"channel_id": "ch1", "limit": 7}, want: 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{
				Name: "readChannel", Arguments: tc.args,
			}); err != nil {
				t.Fatalf("call: %v", err)
			}
			if chat.lastLimit != tc.want {
				t.Errorf("limit = %d, want %d", chat.lastLimit, tc.want)
			}
		})
	}
}

type limitRecordingChat struct{ lastLimit int }

func (limitRecordingChat) Send(context.Context, string, string, string, string, string, ...string) (*model.Message, error) {
	return &model.Message{ID: "m1"}, nil
}

func (c *limitRecordingChat) List(_ context.Context, _, _, _, _ string, limit int) ([]*model.Message, bool, error) {
	c.lastLimit = limit
	return nil, false, nil
}

// A conversation is a valid parent type for both tools.
func TestMCPServer_ConversationParentType(t *testing.T) {
	chat := &fakeChat{}
	cs := mcpToolSession(t, chat, "bot_x")
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "postMessage",
		Arguments: map[string]any{"channel_id": "conv1", "text": "hi", "channel_type": "conversation"},
	}); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(chat.sent) != 1 || chat.sent[0].parentType != mcpParentConversation {
		t.Errorf("sent = %+v, want a conversation post", chat.sent)
	}
}

// Without a chat service only the identity/health tools exist — there is nothing
// to post to or read from.
func TestMCPServer_NoChatServiceOmitsChatTools(t *testing.T) {
	cs := mcpToolSession(t, nil, "bot_x")
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	for _, tl := range tools.Tools {
		if tl.Name == "postMessage" || tl.Name == "readChannel" {
			t.Errorf("tool %q registered with no chat service", tl.Name)
		}
	}
}
