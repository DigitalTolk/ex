package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
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
	defer serverSession.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	cs, err := client.Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer cs.Close()

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
	defer cs.Close()

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
