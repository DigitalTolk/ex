package service

// Coverage tests for message_agent.go — the MessageService↔agent glue:
// optional seam setters, async agent dispatch, machine-state reactions, and
// agent message rewrite. All identifiers are prefixed msgagCov.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// --- fakes ---

type msgagCovPurger struct{}

func (p *msgagCovPurger) PurgeThreadLogs(context.Context, string, string) {}

type msgagCovDispatchCall struct {
	ctxErr      error
	hasDeadline bool
	msgID       string
	parentType  string
}

type msgagCovDispatcher struct {
	mu    sync.Mutex
	calls []msgagCovDispatchCall
	done  chan struct{}
}

func msgagCovNewDispatcher() *msgagCovDispatcher {
	return &msgagCovDispatcher{done: make(chan struct{}, 4)}
}

func (d *msgagCovDispatcher) OnMessage(ctx context.Context, msg *model.Message, parentType string) {
	_, hasDeadline := ctx.Deadline()
	d.mu.Lock()
	d.calls = append(d.calls, msgagCovDispatchCall{
		ctxErr:      ctx.Err(),
		hasDeadline: hasDeadline,
		msgID:       msg.ID,
		parentType:  parentType,
	})
	d.mu.Unlock()
	d.done <- struct{}{}
}

func (d *msgagCovDispatcher) snapshot() []msgagCovDispatchCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]msgagCovDispatchCall, len(d.calls))
	copy(out, d.calls)
	return out
}

func msgagCovWait(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for async dispatch")
	}
}

// msgagCovSeed stores a message in the mock store and returns it (the store
// hands back the same pointer, so tests can inspect mutations directly).
func msgagCovSeed(messages *mockMessageStore, msg *model.Message) *model.Message {
	messages.messages[msg.ParentID+"#"+msg.ID] = msg
	return msg
}

// --- seam setters (SetRunLogPurger / SetAgentDispatcher) ---

func TestMsgagCovSeamSetters(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()

	purger := &msgagCovPurger{}
	svc.SetRunLogPurger(purger)
	if svc.runLogPurger != RunLogPurger(purger) {
		t.Fatal("SetRunLogPurger did not wire the purger field")
	}

	dispatcher := msgagCovNewDispatcher()
	svc.SetAgentDispatcher(dispatcher)
	if svc.agentDispatcher != AgentDispatcher(dispatcher) {
		t.Fatal("SetAgentDispatcher did not wire the dispatcher field")
	}
}

// --- IsMachineStateEmoji ---

func TestMsgagCovIsMachineStateEmoji(t *testing.T) {
	if !IsMachineStateEmoji(StateEmojiDone) {
		t.Error("✅ should be a machine state emoji")
	}
	if IsMachineStateEmoji("🎉") {
		t.Error("🎉 should not be a machine state emoji")
	}
}

// --- dispatchAgents ---

func TestMsgagCovDispatchAgentsInertCases(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	ctx := context.Background()
	msg := &model.Message{ID: "m1", ParentID: "ch1", Body: "hi @agent"}

	// Nil dispatcher: nothing to do, returns synchronously.
	svc.dispatchAgents(ctx, msg, ParentChannel)

	dispatcher := msgagCovNewDispatcher()
	svc.SetAgentDispatcher(dispatcher)

	// Nil message and system messages are inert even with a dispatcher.
	svc.dispatchAgents(ctx, nil, ParentChannel)
	svc.dispatchAgents(ctx, &model.Message{ID: "sys", ParentID: "ch1", System: true}, ParentChannel)

	// A real message dispatches; use it to flush and prove the inert calls
	// never reached the dispatcher.
	svc.dispatchAgents(ctx, msg, ParentChannel)
	msgagCovWait(t, dispatcher.done)

	calls := dispatcher.snapshot()
	if len(calls) != 1 {
		t.Fatalf("dispatcher calls = %d, want 1 (inert cases must not dispatch)", len(calls))
	}
	if calls[0].msgID != "m1" || calls[0].parentType != ParentChannel {
		t.Fatalf("dispatched (%q, %q), want (m1, %s)", calls[0].msgID, calls[0].parentType, ParentChannel)
	}
}

func TestMsgagCovDispatchAgentsSurvivesCanceledContext(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	dispatcher := msgagCovNewDispatcher()
	svc.SetAgentDispatcher(dispatcher)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // request context already gone before dispatch

	svc.dispatchAgents(ctx, &model.Message{ID: "m2", ParentID: "dm1"}, ParentConversation)
	msgagCovWait(t, dispatcher.done)

	calls := dispatcher.snapshot()
	if len(calls) != 1 {
		t.Fatalf("dispatcher calls = %d, want 1", len(calls))
	}
	if calls[0].ctxErr != nil {
		t.Errorf("OnMessage ctx.Err() = %v, want nil (detachedContext must drop parent cancellation)", calls[0].ctxErr)
	}
	if !calls[0].hasDeadline {
		t.Error("OnMessage ctx has no deadline, want the detachedTimeout deadline")
	}
	if calls[0].parentType != ParentConversation {
		t.Errorf("parentType = %q, want %q", calls[0].parentType, ParentConversation)
	}
}

// --- SetMachineReaction ---

func TestMsgagCovSetMachineReaction(t *testing.T) {
	ctx := context.Background()

	t.Run("rejects non machine emoji", func(t *testing.T) {
		svc, _, _, _, _ := setupMessageService()
		err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", "🎉")
		if err == nil || !strings.Contains(err.Error(), "not a machine state emoji") {
			t.Fatalf("err = %v, want machine-emoji rejection", err)
		}
	})

	t.Run("get error is wrapped", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		messages.getErr = errors.New("boom")
		err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiRead)
		if err == nil || !strings.Contains(err.Error(), "get for state reaction") {
			t.Fatalf("err = %v, want wrapped get error", err)
		}
	})

	t.Run("set on nil reactions initialises the map", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msg := msgagCovSeed(messages, &model.Message{ID: "m1", ParentID: "ch1", Body: "x"})
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiRead); err != nil {
			t.Fatalf("set: %v", err)
		}
		if got := msg.Reactions[StateEmojiRead]; len(got) != 1 || got[0] != "agent-1" {
			t.Fatalf("reactions[👀] = %v, want [agent-1]", got)
		}
	})

	t.Run("new state removes the actor's previous transient state", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msg := msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", Body: "x",
			Reactions: map[string][]string{StateEmojiBlocked: {"agent-1"}},
		})
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiDone); err != nil {
			t.Fatalf("set: %v", err)
		}
		if _, ok := msg.Reactions[StateEmojiBlocked]; ok {
			t.Error("⛔ survived the transition to ✅")
		}
		if got := msg.Reactions[StateEmojiDone]; len(got) != 1 || got[0] != "agent-1" {
			t.Fatalf("reactions[✅] = %v, want [agent-1]", got)
		}
	})

	t.Run("setting a transient state clears other transients but not itself", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msg := msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", Body: "x",
			Reactions: map[string][]string{StateEmojiThinking: {"agent-1"}},
		})
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiBlocked); err != nil {
			t.Fatalf("set: %v", err)
		}
		if _, ok := msg.Reactions[StateEmojiThinking]; ok {
			t.Error("🧠 survived the transition to ⛔")
		}
		if got := msg.Reactions[StateEmojiBlocked]; len(got) != 1 || got[0] != "agent-1" {
			t.Fatalf("reactions[⛔] = %v, want [agent-1]", got)
		}
	})

	t.Run("another actor's transient state is kept", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msg := msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", Body: "x",
			Reactions: map[string][]string{StateEmojiQueued: {"agent-other"}},
		})
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiWorking); err != nil {
			t.Fatalf("set: %v", err)
		}
		if got := msg.Reactions[StateEmojiQueued]; len(got) != 1 || got[0] != "agent-other" {
			t.Fatalf("reactions[⏳] = %v, want other actor's ⏳ untouched", got)
		}
		if got := msg.Reactions[StateEmojiWorking]; len(got) != 1 || got[0] != "agent-1" {
			t.Fatalf("reactions[⚙️] = %v, want [agent-1]", got)
		}
	})

	t.Run("idempotent set persists nothing", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", Body: "x",
			Reactions: map[string][]string{StateEmojiDone: {"agent-1"}},
		})
		// Any UpdateMessage would fail — the early return must dodge it.
		messages.updateErr = errors.New("must not update")
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiDone); err != nil {
			t.Fatalf("idempotent set should be a no-op, got %v", err)
		}
	})

	t.Run("clear removes only the actor and keeps other holders", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msg := msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", Body: "x",
			Reactions: map[string][]string{
				StateEmojiRead:    {"agent-1"},
				StateEmojiWorking: {"agent-1", "agent-other"},
			},
		})
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", ""); err != nil {
			t.Fatalf("clear: %v", err)
		}
		if _, ok := msg.Reactions[StateEmojiRead]; ok {
			t.Error("👀 should be deleted once its only holder is cleared")
		}
		if got := msg.Reactions[StateEmojiWorking]; len(got) != 1 || got[0] != "agent-other" {
			t.Fatalf("reactions[⚙️] = %v, want [agent-other]", got)
		}
	})

	t.Run("clearing the sole reactor nils the map", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msg := msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", Body: "x",
			Reactions: map[string][]string{StateEmojiRead: {"agent-1"}},
		})
		if err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", ""); err != nil {
			t.Fatalf("clear: %v", err)
		}
		if msg.Reactions != nil {
			t.Fatalf("Reactions = %v, want nil once the map empties", msg.Reactions)
		}
	})

	t.Run("update error is wrapped", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{ID: "m1", ParentID: "ch1", Body: "x"})
		messages.updateErr = errors.New("dynamo down")
		err := svc.SetMachineReaction(ctx, "agent-1", "ch1", ParentChannel, "m1", StateEmojiFailed)
		if err == nil || !strings.Contains(err.Error(), "update state reaction") {
			t.Fatalf("err = %v, want wrapped update error", err)
		}
	})
}

// --- RewriteAgentMessage ---

func TestMsgagCovRewriteAgentMessage(t *testing.T) {
	ctx := context.Background()
	const agentID = "agent-user"

	t.Run("rejects an invalid body", func(t *testing.T) {
		svc, _, _, _, _ := setupMessageService()
		tooLong := strings.Repeat("x", MaxMessageBodyChars+1)
		if _, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", tooLong); !errors.Is(err, ErrMessageTooLong) {
			t.Fatalf("err = %v, want ErrMessageTooLong", err)
		}
	})

	t.Run("get error is wrapped", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		messages.getErr = errors.New("boom")
		_, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "new body")
		if err == nil || !strings.Contains(err.Error(), "get for rewrite") {
			t.Fatalf("err = %v, want wrapped get error", err)
		}
	})

	t.Run("refuses a human-authored message", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", AuthorID: "human-1", Body: "hello",
		})
		if _, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "new body"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})

	t.Run("refuses an agent message without an invoker", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", AuthorID: agentID, Body: "hello",
		})
		if _, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "new body"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})

	t.Run("refuses a deleted message", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", AuthorID: agentID, AgentInvokerID: "u1",
			Deleted: true,
		})
		if _, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "new body"); !errors.Is(err, ErrThreadDeleted) {
			t.Fatalf("err = %v, want ErrThreadDeleted", err)
		}
	})

	t.Run("identical body is a persisted-nothing no-op", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", AuthorID: agentID, AgentInvokerID: "u1",
			Body: "same",
		})
		messages.updateErr = errors.New("must not update")
		got, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "same")
		if err != nil {
			t.Fatalf("no-op rewrite: %v", err)
		}
		if got == nil || got.Body != "same" || got.EditedAt != nil {
			t.Fatalf("got %+v, want unchanged message without EditedAt", got)
		}
	})

	t.Run("update error is wrapped", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", AuthorID: agentID, AgentInvokerID: "u1",
			Body: "old",
		})
		messages.updateErr = errors.New("dynamo down")
		_, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "new body")
		if err == nil || !strings.Contains(err.Error(), "message: rewrite") {
			t.Fatalf("err = %v, want wrapped rewrite error", err)
		}
	})

	t.Run("rewrites the body and stamps EditedAt", func(t *testing.T) {
		svc, messages, _, _, _ := setupMessageService()
		msgagCovSeed(messages, &model.Message{
			ID: "m1", ParentID: "ch1", AuthorID: agentID, AgentInvokerID: "u1",
			Body: "old",
		})
		got, err := svc.RewriteAgentMessage(ctx, agentID, "ch1", ParentChannel, "m1", "new body")
		if err != nil {
			t.Fatalf("rewrite: %v", err)
		}
		if got.Body != "new body" {
			t.Fatalf("Body = %q, want %q", got.Body, "new body")
		}
		if got.EditedAt == nil {
			t.Fatal("EditedAt not stamped on rewrite")
		}
		stored, err := messages.GetMessage(ctx, "ch1", "m1")
		if err != nil || stored.Body != "new body" {
			t.Fatalf("stored body = %v (err %v), want the rewrite persisted", stored, err)
		}
	})
}
