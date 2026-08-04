//go:build integration

package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/redis/go-redis/v9"
)

// The confirm-first write flow, against real Redis. Everything here is about the
// gate in front of a cross-app write: a proposal is parked, only a bare "yes"
// executes it, a duplicate "yes" must not execute it twice, and anything else
// abandons it so a later "yes" can't fire a stale write.

// withPendingStore attaches a Redis-backed in-chat store to the handler.
func withPendingStore(t *testing.T, env *cliffyTurnEnv) *store.CliffyInChatStore {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: redisAddrForTest(t)})
	t.Cleanup(func() { _ = client.Close() })
	inchat := store.NewCliffyInChatStore(client)
	env.handler.inchat = inchat
	return inchat
}

func inchatEvent(prompt string) service.BotEvent {
	return service.BotEvent{
		AskerID: "u1", ParentID: "ch1", ParentType: service.ParentChannel,
		RootMessageID: "root1", Prompt: prompt,
	}
}

// proposalStream is an agent turn that proposes one task creation.
func proposalStream() string {
	return sseLines(
		map[string]any{"type": "text-delta", "delta": "I can do that."},
		map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
			"method": "POST", "path": "api/work/tasks", "summary": "create a task",
			"body": map[string]any{"title": "Ship it"},
		}},
	)
}

func TestInChat_ProposalIsParkedAndConfirmed(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{stream: proposalStream()})
	inchat := withPendingStore(t, env)

	// Turn 1: the agent proposes; ex parks it and asks, without writing anything.
	text, err := env.handler.handleTurn(ctx, inchatEvent("make a task"))
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if !strings.Contains(text, "create a task") || !strings.Contains(text, "Reply **yes**") {
		t.Errorf("text = %q, want the confirmation prompt", text)
	}
	if env.agent.writes != 0 {
		t.Fatalf("writes = %d, want 0 before confirmation", env.agent.writes)
	}
	if p, _ := inchat.GetPending(ctx, "ch1", "u1"); p == nil {
		t.Fatal("the proposal was not parked")
	}
	// The thread is now Cliffy's, so replies reach it without another @mention.
	if !env.handler.OwnsThread(ctx, "root1") {
		t.Error("the thread was not marked as Cliffy's")
	}

	// Turn 2: a bare "yes" executes it.
	text, err = env.handler.handleTurn(ctx, inchatEvent("yes"))
	if err != nil {
		t.Fatalf("handleTurn(yes): %v", err)
	}
	if !strings.Contains(text, "Created") {
		t.Errorf("text = %q, want the write confirmation", text)
	}
	if env.agent.writes != 1 {
		t.Errorf("writes = %d, want exactly 1", env.agent.writes)
	}
	// Claimed, so it can't be run again.
	if p, _ := inchat.GetPending(ctx, "ch1", "u1"); p != nil {
		t.Error("the proposal survived confirmation")
	}
}

// A duplicate "yes" (double-tap, client retry) must not execute the write twice —
// TakePending is the single point of mutual exclusion.
func TestInChat_DuplicateYesDoesNotRunTwice(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{stream: proposalStream()})
	withPendingStore(t, env)

	if _, err := env.handler.handleTurn(ctx, inchatEvent("make a task")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if _, err := env.handler.handleTurn(ctx, inchatEvent("yes")); err != nil {
		t.Fatalf("handleTurn(yes): %v", err)
	}
	// The second "yes" finds nothing parked and must stay silent rather than
	// running a fresh turn that could propose the same write again.
	text, err := env.handler.handleTurn(ctx, inchatEvent("yes"))
	if err != nil {
		t.Fatalf("handleTurn(yes again): %v", err)
	}
	if env.agent.writes != 1 {
		t.Errorf("writes = %d, want exactly 1", env.agent.writes)
	}
	_ = text
}

func TestInChat_NoCancelsTheProposal(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{stream: proposalStream()})
	inchat := withPendingStore(t, env)

	if _, err := env.handler.handleTurn(ctx, inchatEvent("make a task")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	text, err := env.handler.handleTurn(ctx, inchatEvent("no"))
	if err != nil {
		t.Fatalf("handleTurn(no): %v", err)
	}
	if !strings.Contains(text, "won't do that") {
		t.Errorf("text = %q, want the cancellation", text)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0", env.agent.writes)
	}
	if p, _ := inchat.GetPending(ctx, "ch1", "u1"); p != nil {
		t.Error("the proposal survived cancellation")
	}
}

// An unrelated reply abandons the parked proposal and runs a fresh turn, so a
// later bare "yes" cannot fire the stale write.
func TestInChat_UnrelatedReplyAbandonsTheProposal(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{stream: proposalStream()})
	inchat := withPendingStore(t, env)

	if _, err := env.handler.handleTurn(ctx, inchatEvent("make a task")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	// "yes, but …" deliberately does NOT confirm — the correction must be honored.
	if _, err := env.handler.handleTurn(ctx, inchatEvent("yes, but call it Ship It Now")); err != nil {
		t.Fatalf("handleTurn(correction): %v", err)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0 — a correction must not run the un-amended write", env.agent.writes)
	}
	// The fresh turn proposed again, so there is a NEW pending write, not the old one.
	if p, _ := inchat.GetPending(ctx, "ch1", "u1"); p == nil {
		t.Error("the fresh turn should have parked its own proposal")
	}
	if env.agent.turns != 2 {
		t.Errorf("agent turns = %d, want 2 (original + fresh)", env.agent.turns)
	}
}

// A proposal is scoped per (chat, user): another member's "yes" must not claim it.
func TestInChat_ProposalIsScopedToTheAsker(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{stream: proposalStream()})
	withPendingStore(t, env)
	// Both users must resolve to an email for a turn to run at all.
	env.handler.users = fakeCliffyUsers{"u1": "u1@example.com", "u2": "u2@example.com"}

	if _, err := env.handler.handleTurn(ctx, inchatEvent("make a task")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	other := inchatEvent("yes")
	other.AskerID = "u2"
	if _, err := env.handler.handleTurn(ctx, other); err != nil {
		t.Fatalf("handleTurn(other user): %v", err)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0 — only the asker can confirm their own write", env.agent.writes)
	}
}

// When the confirmed write is executed, the reply carries the created record's
// link — the whole point of confirm-then-report.
func TestInChat_ConfirmedWriteReportsTheRecord(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{
		stream:    proposalStream(),
		writeBody: []string{`{"id":"42","ticket_key":"CORE-42","title":"Ship it"}`},
	})
	withPendingStore(t, env)

	if _, err := env.handler.handleTurn(ctx, inchatEvent("make a task")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	text, err := env.handler.handleTurn(ctx, inchatEvent("yes"))
	if err != nil {
		t.Fatalf("handleTurn(yes): %v", err)
	}
	if !strings.Contains(text, "CORE-42") || !strings.Contains(text, "/tasks/42") {
		t.Errorf("text = %q, want the ticket key and link", text)
	}
}

// A proposal with no summary falls back to describing the raw action, so the
// confirmation prompt is never blank.
func TestInChat_ProposalWithoutASummary(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(map[string]any{
			"type": "tool-input-available", "toolName": "writeApi",
			"input": map[string]any{"method": "POST", "path": "api/work/tasks"},
		}),
	})
	withPendingStore(t, env)

	text, err := env.handler.handleTurn(ctx, inchatEvent("make a task"))
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if !strings.Contains(text, "POST api/work/tasks") {
		t.Errorf("text = %q, want the method and path as the fallback summary", text)
	}
}

// Marking the thread happens on every answered turn, not just proposals, so a
// plain question also makes the thread Cliffy's.
func TestInChat_PlainAnswerMarksTheThread(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(map[string]any{"type": "text-delta", "delta": "Three are open."}),
	})
	withPendingStore(t, env)

	if _, err := env.handler.handleTurn(ctx, inchatEvent("how many?")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	if !env.handler.OwnsThread(ctx, "root1") {
		t.Error("the thread should be Cliffy's after it answered there")
	}
	if !env.handler.OwnsThread(ctx, "root1") {
		t.Error("OwnsThread should be stable")
	}
	if env.handler.OwnsThread(ctx, "some-other-root") {
		t.Error("an unrelated thread must not be Cliffy's")
	}
}

// A pending write whose body cannot be stored (invalid raw JSON from the agent)
// must not leave the turn claiming it parked something.
func TestInChat_UnstorableProposalFallsBackToText(t *testing.T) {
	ctx := context.Background()
	// json.RawMessage round-trips through Redis, so an invalid body fails SetPending.
	env := setupCliffyTurn(t, &stubAgent{
		stream: sseLines(
			map[string]any{"type": "text-delta", "delta": "Here's the plan."},
			map[string]any{"type": "tool-input-available", "toolName": "writeApi", "input": map[string]any{
				"method": "POST", "path": "api/work/tasks", "summary": "create a task",
				"body": json.RawMessage(`{"broken":`),
			}},
		),
	})
	withPendingStore(t, env)

	text, err := env.handler.handleTurn(ctx, inchatEvent("make a task"))
	if err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	// Falls through to the agent's text rather than promising a confirmation that
	// could never be honored.
	if strings.Contains(text, "Reply **yes**") {
		t.Errorf("text = %q, want no confirmation prompt when parking failed", text)
	}
	if env.agent.writes != 0 {
		t.Errorf("writes = %d, want 0", env.agent.writes)
	}
}

// The confirmed-write path still applies the repair-and-retry logic end to end.
func TestInChat_ConfirmedWriteRepairsOnValidationFailure(t *testing.T) {
	ctx := context.Background()
	env := setupCliffyTurn(t, &stubAgent{
		stream: proposalStream(),
		// The repair turn re-issues the same method+path with the missing field.
		repairStream: sseLines(map[string]any{
			"type": "tool-input-available", "toolName": "writeApi",
			"input": map[string]any{
				"method": "POST", "path": "api/work/tasks", "summary": "create a task",
				"body": map[string]any{"title": "Ship it", "type_id": 3},
			},
		}),
		writeStatus: []int{http.StatusUnprocessableEntity, http.StatusCreated},
		writeBody:   []string{`{"message":"type_id is required"}`, `{"id":"9","title":"Ship it"}`},
	})
	withPendingStore(t, env)

	if _, err := env.handler.handleTurn(ctx, inchatEvent("make a task")); err != nil {
		t.Fatalf("handleTurn: %v", err)
	}
	text, err := env.handler.handleTurn(ctx, inchatEvent("yes"))
	if err != nil {
		t.Fatalf("handleTurn(yes): %v", err)
	}
	if !strings.Contains(text, "Ship it") {
		t.Errorf("text = %q, want the retry's confirmation", text)
	}
	if env.agent.writes != 2 {
		t.Errorf("writes = %d, want 2 (original + repaired retry)", env.agent.writes)
	}
}

// Constructed through NewCliffyHandler with a real store, the in-chat flow is
// enabled — the config path the server actually uses.
func TestNewCliffyHandler_WithInChatStoreEnablesWrites(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: redisAddrForTest(t)})
	t.Cleanup(func() { _ = client.Close() })

	bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
		Secret: testBridgeSecret, MintURL: "https://cliffhub.example/api/ai/bridge/mint",
	})
	if err != nil || bridge == nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	h := NewCliffyHandler(CliffyHandlerConfig{
		Bridge:      bridge,
		InChatStore: store.NewCliffyInChatStore(client),
	})
	if h.inchat == nil {
		t.Fatal("a configured in-chat store should be wired")
	}
	ctx := context.Background()
	if h.OwnsThread(ctx, "root1") {
		t.Error("an unmarked thread must not be Cliffy's")
	}
	h.inchat.MarkThread(ctx, "root1")
	if !h.OwnsThread(ctx, "root1") {
		t.Error("a marked thread should be Cliffy's")
	}
}
