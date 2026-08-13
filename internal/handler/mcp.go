package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ex exposes an MCP server so bots/agents access ex's data + actions through a
// standard protocol instead of bespoke HTTP wiring. Mounted behind AuthWithBots,
// so the caller is an authenticated bot/user; every tool acts with that
// identity and is access-checked exactly like the equivalent REST call — ex
// never impersonates anyone. (Streamable-HTTP transport, per docs/rfc-generic-bots-mcp.md.)

// MCPChat is the slice of the message service the MCP tools need. Satisfied by
// *service.MessageService. Kept as an interface so the handler package doesn't
// hard-depend on the service and so tests can substitute a fake.
type MCPChat interface {
	Send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error)
	List(ctx context.Context, userID, parentID, parentType, before string, limit int) ([]*model.Message, bool, error)
}

// Parent types accepted by the channel-scoped tools — the same values the REST
// layer uses (service.ParentChannel / ParentConversation).
const (
	mcpParentChannel      = "channel"
	mcpParentConversation = "conversation"
	mcpReadDefaultLimit   = 20
	mcpReadMaxLimit       = 100
)

type pingIn struct {
	Message string `json:"message"`
}
type pingOut struct {
	Reply string `json:"reply"`
}

type whoamiOut struct {
	UserID string `json:"user_id"`
	IsBot  bool   `json:"is_bot"`
}

type postMessageIn struct {
	ChannelID    string `json:"channel_id"`
	ChannelType  string `json:"channel_type,omitempty"`   // "channel" (default) or "conversation"
	Text         string `json:"text"`                     // message body
	ThreadRootID string `json:"thread_root_id,omitempty"` // reply into this thread, if set
}
type postMessageOut struct {
	MessageID string `json:"message_id"`
}

type readChannelIn struct {
	ChannelID   string `json:"channel_id"`
	ChannelType string `json:"channel_type,omitempty"` // "channel" (default) or "conversation"
	Limit       int    `json:"limit,omitempty"`        // default 20, capped at 100
	Before      string `json:"before,omitempty"`       // page backward from this message ID
}
type readMessage struct {
	ID        string `json:"id"`
	AuthorID  string `json:"author_id"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}
type readChannelOut struct {
	Messages []readMessage `json:"messages"`
	HasMore  bool          `json:"has_more"`
}

// NewMCPServer builds the ex MCP server and registers its tools. chat may be nil
// (e.g. in the trivial round-trip test) — the chat-backed tools are only
// registered when it is provided.
func NewMCPServer(chat MCPChat) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "ex", Version: "1.0.0"}, nil)

	// ping — trivial health-check / round-trip proof.
	mcp.AddTool(s, &mcp.Tool{Name: "ping", Description: "Echo a message back (MCP health check)."},
		func(_ context.Context, _ *mcp.CallToolRequest, in pingIn) (*mcp.CallToolResult, pingOut, error) {
			return nil, pingOut{Reply: "pong: " + in.Message}, nil
		})

	// whoami — reports the caller's authenticated identity as seen by ex.
	mcp.AddTool(s, &mcp.Tool{Name: "whoami", Description: "Return the calling bot/user identity."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, whoamiOut, error) {
			uid := middleware.UserIDFromContext(ctx)
			return nil, whoamiOut{UserID: uid, IsBot: model.IsBotUserID(uid)}, nil
		})

	if chat != nil {
		// postMessage — post as the calling identity into a channel/conversation.
		// Access is enforced by MessageService.Send (membership required), so a
		// bot can only post where it has been added.
		mcp.AddTool(s, &mcp.Tool{Name: "postMessage", Description: "Post a message to a channel or conversation as the calling bot/user."},
			func(ctx context.Context, _ *mcp.CallToolRequest, in postMessageIn) (*mcp.CallToolResult, postMessageOut, error) {
				uid := middleware.UserIDFromContext(ctx)
				if uid == "" {
					return nil, postMessageOut{}, errors.New("unauthenticated")
				}
				ptype, err := mcpParentType(in.ChannelType)
				if err != nil {
					return nil, postMessageOut{}, err
				}
				if in.ChannelID == "" || strings.TrimSpace(in.Text) == "" {
					return nil, postMessageOut{}, errors.New("channel_id and text are required")
				}
				msg, err := chat.Send(ctx, uid, in.ChannelID, ptype, in.Text, in.ThreadRootID)
				if err != nil {
					return nil, postMessageOut{}, err
				}
				return nil, postMessageOut{MessageID: msg.ID}, nil
			})

		// readChannel — read recent messages from a channel/conversation as the
		// calling identity. Access is enforced by MessageService.List.
		mcp.AddTool(s, &mcp.Tool{Name: "readChannel", Description: "Read recent messages from a channel or conversation the caller can access."},
			func(ctx context.Context, _ *mcp.CallToolRequest, in readChannelIn) (*mcp.CallToolResult, readChannelOut, error) {
				uid := middleware.UserIDFromContext(ctx)
				if uid == "" {
					return nil, readChannelOut{}, errors.New("unauthenticated")
				}
				ptype, err := mcpParentType(in.ChannelType)
				if err != nil {
					return nil, readChannelOut{}, err
				}
				if in.ChannelID == "" {
					return nil, readChannelOut{}, errors.New("channel_id is required")
				}
				limit := in.Limit
				if limit <= 0 {
					limit = mcpReadDefaultLimit
				}
				if limit > mcpReadMaxLimit {
					limit = mcpReadMaxLimit
				}
				msgs, hasMore, err := chat.List(ctx, uid, in.ChannelID, ptype, in.Before, limit)
				if err != nil {
					return nil, readChannelOut{}, err
				}
				out := readChannelOut{Messages: make([]readMessage, 0, len(msgs)), HasMore: hasMore}
				for _, m := range msgs {
					out.Messages = append(out.Messages, readMessage{
						ID:        m.ID,
						AuthorID:  m.AuthorID,
						Text:      m.Body,
						CreatedAt: m.CreatedAt.Format(time.RFC3339),
					})
				}
				return nil, out, nil
			})
	}

	return s
}

// mcpParentType normalizes a tool's channel_type argument to the parent-type
// value the message service expects, defaulting to "channel".
func mcpParentType(t string) (string, error) {
	switch t {
	case "", mcpParentChannel:
		return mcpParentChannel, nil
	case mcpParentConversation:
		return mcpParentConversation, nil
	default:
		return "", errors.New(`channel_type must be "channel" or "conversation"`)
	}
}

// NewMCPHTTPHandler mounts the MCP server as a Streamable-HTTP endpoint. Wrap it
// with AuthWithBots so tools run with the caller's identity.
func NewMCPHTTPHandler(chat MCPChat) http.Handler {
	server := NewMCPServer(chat)
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
}
