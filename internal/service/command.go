package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
)

// ErrUnknownCommand marks a slash-command invocation whose name isn't
// registered. Handlers map it to 404 so a stale client (offering a command a
// newer deploy removed) gets a clean error instead of a generic 500.
var ErrUnknownCommand = errors.New("command: unknown command")

// CommandInfo describes a slash command to clients; the composer's "/"
// autocomplete renders exactly this.
type CommandInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// CommandRequest carries the invocation context of a slash command: who ran
// it and in which chat (channel or conversation).
type CommandRequest struct {
	UserID     string
	ParentID   string
	ParentType string // ParentChannel or ParentConversation
}

// Command is one executable slash command. Run returns the message the
// command posted into the chat (commands surface their result in-channel so
// every member sees it via the normal message.new fan-out).
type Command interface {
	Info() CommandInfo
	Run(ctx context.Context, req CommandRequest) (*model.Message, error)
}

// CommandService is the slash-command registry. Commands register at wiring
// time based on which integrations are configured; an empty registry is valid
// (clients see no commands and offer none).
type CommandService struct {
	order  []CommandInfo
	byName map[string]Command
}

// NewCommandService creates an empty registry.
func NewCommandService() *CommandService {
	return &CommandService{byName: make(map[string]Command)}
}

// Register adds a command to the registry. Registration happens once at
// wiring time (no concurrent use).
func (s *CommandService) Register(cmd Command) {
	info := cmd.Info()
	s.order = append(s.order, info)
	s.byName[info.Name] = cmd
}

// List returns the registered commands in registration order. Always
// non-nil so the handler serializes an empty array, not null.
func (s *CommandService) List() []CommandInfo {
	out := make([]CommandInfo, len(s.order))
	copy(out, s.order)
	return out
}

// Run executes a registered command. The command itself owns access control
// (each verifies the caller's membership in the target chat before acting).
func (s *CommandService) Run(ctx context.Context, name string, req CommandRequest) (*model.Message, error) {
	cmd, ok := s.byName[name]
	if !ok {
		return nil, fmt.Errorf("command %q: %w", name, ErrUnknownCommand)
	}
	if req.ParentType != ParentChannel && req.ParentType != ParentConversation {
		return nil, fmt.Errorf("command: unknown parent type %q: %w", req.ParentType, ErrForbidden)
	}
	return cmd.Run(ctx, req)
}
