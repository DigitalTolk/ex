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

// CommandUserError is a command failure whose message is safe — and meant —
// to be shown verbatim to the invoking user (e.g. "guests can't start
// meetings"). Anything not wrapped in it stays a generic 500 so internal
// details never leak into the composer.
type CommandUserError struct {
	Message string
}

func (e *CommandUserError) Error() string { return "command: " + e.Message }

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
	// Text is everything after the trigger word — the command's arguments. Always
	// empty for built-in commands, which take none; external (Mattermost-shaped)
	// commands receive it as MM's `text` field.
	Text string
}

// CommandResult is the outcome of a slash-command run.
//
// Built-in commands only ever post a message. External commands additionally
// support Mattermost's two other outcomes: an ephemeral reply shown to the caller
// alone (MM's default response type), and a client-side navigation.
type CommandResult struct {
	// Message is the post the command made, when it made one.
	Message *model.Message `json:"message,omitempty"`
	// EphemeralText is shown only to the invoking user and is never persisted.
	EphemeralText string `json:"ephemeral_text,omitempty"`
	// GotoLocation is an http(s) URL the client should open. Already filtered.
	GotoLocation string `json:"goto_location,omitempty"`
}

// ExternalCommandRunner supplies admin-registered (Mattermost-shaped) commands to
// the registry. Satisfied by *ExternalCommandService; nil means built-ins only.
type ExternalCommandRunner interface {
	// ListCommands returns the external commands for the "/" autocomplete.
	ListCommands(ctx context.Context) []CommandInfo
	// RunCommand invokes one by trigger, reporting ErrUnknownCommand if absent.
	RunCommand(ctx context.Context, trigger string, req CommandRequest) (CommandResult, error)
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
	// external serves admin-registered commands. Set once at wiring time.
	external ExternalCommandRunner
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

// SetExternalRunner wires admin-registered external commands into the registry.
// Optional — without it, only compiled-in commands exist.
func (s *CommandService) SetExternalRunner(r ExternalCommandRunner) { s.external = r }

// BuiltinTriggers returns the set of compiled-in triggers, so external-command
// registration can refuse to shadow one (a built-in always wins in Run below, so
// an external command on the same trigger would be silently dead).
func (s *CommandService) BuiltinTriggers() map[string]bool {
	out := make(map[string]bool, len(s.byName))
	for name := range s.byName {
		out[name] = true
	}
	return out
}

// List returns the commands available to clients: built-ins in registration
// order, then external ones. Always non-nil so the handler serializes an empty
// array, not null.
func (s *CommandService) List(ctx context.Context) []CommandInfo {
	out := make([]CommandInfo, len(s.order))
	copy(out, s.order)
	if s.external == nil {
		return out
	}
	// A built-in with the same trigger shadows an external command at dispatch, so
	// it also shadows it in the list — offering both would show a duplicate entry
	// where only one can ever run.
	builtin := s.BuiltinTriggers()
	for _, info := range s.external.ListCommands(ctx) {
		if builtin[info.Name] {
			continue
		}
		out = append(out, info)
	}
	return out
}

// Run executes a registered command: a built-in if one owns the name, otherwise
// an external one. Each command owns its own access control (built-ins verify the
// caller's membership; the external runner checks it before calling out).
func (s *CommandService) Run(ctx context.Context, name string, req CommandRequest) (CommandResult, error) {
	if req.ParentType != ParentChannel && req.ParentType != ParentConversation {
		return CommandResult{}, fmt.Errorf("command: unknown parent type %q: %w", req.ParentType, ErrForbidden)
	}
	if cmd, ok := s.byName[name]; ok {
		msg, err := cmd.Run(ctx, req)
		if err != nil {
			return CommandResult{}, err
		}
		return CommandResult{Message: msg}, nil
	}
	if s.external != nil {
		return s.external.RunCommand(ctx, name, req)
	}
	return CommandResult{}, fmt.Errorf("command %q: %w", name, ErrUnknownCommand)
}
