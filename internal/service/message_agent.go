package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
)

// Machine state reactions (plan-v2 §9 / plan.md §9). Written exclusively by
// the orchestrator via SetMachineReaction; ToggleReaction rejects them from
// human callers so the state display is non-spoofable. Stored as the actual
// unicode emoji — that is what the SPA's reaction picker sends and what
// EmojiGlyph renders (a shortcode name would display as literal text).
const (
	StateEmojiRead      = "👀"  // acknowledged
	StateEmojiWorking   = "⚙️" // executing
	StateEmojiThinking  = "🧠"  // consulting/planning
	StateEmojiReviewing = "🔍"  // reviewing
	StateEmojiDone      = "✅"  // completed
	StateEmojiBlocked   = "⛔"  // blocked / awaiting approval
	StateEmojiFailed    = "❌"  // failed
	StateEmojiQueued    = "⏳"  // queued until the invoker's runner is online
)

// machineStateEmojis is the closed set of reaction names reserved for the
// run-state display.
var machineStateEmojis = map[string]struct{}{
	StateEmojiRead:      {},
	StateEmojiWorking:   {},
	StateEmojiThinking:  {},
	StateEmojiReviewing: {},
	StateEmojiDone:      {},
	StateEmojiBlocked:   {},
	StateEmojiFailed:    {},
	StateEmojiQueued:    {},
}

// transientStateEmojis describe what is happening RIGHT NOW (queued, blocked
// on approval, thinking, reviewing) — they leave when the next state lands.
// The rest (👀 ⚙️ ✅ ❌) are the durable trail: saw it → worked → outcome.
var transientStateEmojis = map[string]struct{}{
	StateEmojiQueued:    {},
	StateEmojiBlocked:   {},
	StateEmojiThinking:  {},
	StateEmojiReviewing: {},
}

// IsMachineStateEmoji reports whether the emoji name is reserved for
// backend-written run-state reactions.
func IsMachineStateEmoji(emoji string) bool {
	_, ok := machineStateEmojis[emoji]
	return ok
}

// ErrReservedEmoji is returned when a human tries to react with a reserved
// machine-state emoji.
var ErrReservedEmoji = errors.New("message: emoji reserved for agent state")

// AgentDispatcher receives every persisted message so it can start runs for
// mentioned agents. Implemented by the orchestrator; wired via
// SetAgentDispatcher like the other optional seams.
type AgentDispatcher interface {
	OnMessage(ctx context.Context, msg *model.Message, parentType string)
}

// RunLogPurger deletes the agent-run activity logs tied to a message when it
// is deleted (implemented by the Orchestrator). Optional seam
// (SetRunLogPurger) — nil means deleting a chat leaves its run logs in place.
type RunLogPurger interface {
	PurgeThreadLogs(ctx context.Context, parentID, msgID string)
}

// SetRunLogPurger wires run-log cleanup into message deletion. Optional.
func (s *MessageService) SetRunLogPurger(p RunLogPurger) { s.runLogPurger = p }

// SetAgentDispatcher wires the agent run dispatcher. Optional — when nil,
// agent mentions are inert.
func (s *MessageService) SetAgentDispatcher(d AgentDispatcher) { s.agentDispatcher = d }

// dispatchAgents hands the persisted message to the dispatcher off the send
// path, mirroring notify(): agent runs are minutes-long and must never add
// to the sender's request latency.
func (s *MessageService) dispatchAgents(ctx context.Context, msg *model.Message, parentType string) {
	if s.agentDispatcher == nil || msg == nil || msg.System {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		s.agentDispatcher.OnMessage(bg, msg, parentType)
	})
}

// SetMachineReaction ADDS the actor's machine-state reaction to a message.
// States are cumulative, not exclusive — a message an agent read keeps 👀
// when ⚙️ lands, and both stay when ✅ arrives, so the trail reads as a
// history: saw it → worked on it → done. Idempotent per (emoji, actor).
// state == "" clears every machine emoji for the actor (unused today; kept
// for symmetry).
//
// Backend-only: no access check on purpose — the orchestrator is the sole
// caller and the agent actor is not a channel member. The human-facing path
// (ToggleReaction) rejects these emojis instead.
func (s *MessageService) SetMachineReaction(ctx context.Context, actorID, parentID, parentType, msgID, state string) error {
	if state != "" && !IsMachineStateEmoji(state) {
		return fmt.Errorf("message: %q is not a machine state emoji", state)
	}
	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return fmt.Errorf("message: get for state reaction: %w", err)
	}
	if msg.Reactions == nil {
		msg.Reactions = map[string][]string{}
	}
	if state == "" {
		for emoji := range machineStateEmojis {
			users := msg.Reactions[emoji]
			for i, u := range users {
				if u == actorID {
					users = append(users[:i], users[i+1:]...)
					break
				}
			}
			if len(users) == 0 {
				delete(msg.Reactions, emoji)
			} else {
				msg.Reactions[emoji] = users
			}
		}
	} else {
		changed := false
		// A new state ends whatever transient state preceded it — ⛔ must not
		// outlive the approval it announced, ⏳ must not outlive the queue.
		for emoji := range transientStateEmojis {
			if emoji == state {
				continue
			}
			users := msg.Reactions[emoji]
			for i, u := range users {
				if u == actorID {
					users = append(users[:i], users[i+1:]...)
					changed = true
					break
				}
			}
			if len(users) == 0 {
				delete(msg.Reactions, emoji)
			} else {
				msg.Reactions[emoji] = users
			}
		}
		already := false
		for _, u := range msg.Reactions[state] {
			if u == actorID {
				already = true
				break
			}
		}
		if !already {
			msg.Reactions[state] = append(msg.Reactions[state], actorID)
			changed = true
		}
		if !changed {
			return nil // nothing to persist or fan out
		}
	}
	if len(msg.Reactions) == 0 {
		msg.Reactions = nil
	}
	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return fmt.Errorf("message: update state reaction: %w", err)
	}
	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)
	return nil
}

// RewriteAgentMessage replaces the body of an AGENT-authored machine message
// (a task card marker, a lifecycle notice) in place — backend-only, no access
// check on purpose: the orchestrator/task service is the sole caller and the
// author is the shared agent user, not a channel member. Refuses to touch
// human-authored messages so it can never become an edit-anything primitive.
func (s *MessageService) RewriteAgentMessage(ctx context.Context, agentID, parentID, parentType, msgID, body string) (*model.Message, error) {
	if err := ValidateMessageBody(body); err != nil {
		return nil, err
	}
	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, fmt.Errorf("message: get for rewrite: %w", err)
	}
	if msg.AuthorID != agentID || msg.AgentInvokerID == "" {
		return nil, fmt.Errorf("message: rewrite is limited to this agent's own machine messages: %w", ErrForbidden)
	}
	if msg.Deleted {
		return nil, ErrThreadDeleted
	}
	if msg.Body == body {
		return msg, nil
	}
	msg.Body = body
	now := time.Now()
	msg.EditedAt = &now
	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: rewrite: %w", err)
	}
	s.attachRendered(msg)
	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)
	return msg, nil
}
