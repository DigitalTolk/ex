//go:build integration

package store

import (
	"context"
	"encoding/json"
	"testing"
)

// In-chat Cliffy's short-lived state: a per-(chat,user) write proposal awaiting a
// yes/no, and markers for threads Cliffy has spoken in. Both are deliberately
// ephemeral — Redis with a TTL, not a durable row.

func pendingWrite() *CliffyPendingWrite {
	return &CliffyPendingWrite{
		Method:  "POST",
		Path:    "/tasks",
		Query:   map[string]string{"project": "core"},
		Body:    json.RawMessage(`{"title":"Ship it"}`),
		Summary: "create a task",
	}
}

func TestCliffyInChatStore_PendingRoundTrip(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCliffyInChatStore(client)

	// Nothing parked yet.
	got, err := s.GetPending(ctx, "ch-1", "u-1")
	if err != nil || got != nil {
		t.Fatalf("GetPending = (%+v, %v), want (nil, nil)", got, err)
	}

	if err := s.SetPending(ctx, "ch-1", "u-1", pendingWrite()); err != nil {
		t.Fatalf("SetPending: %v", err)
	}
	got, err = s.GetPending(ctx, "ch-1", "u-1")
	if err != nil {
		t.Fatalf("GetPending: %v", err)
	}
	if got == nil || got.Path != "/tasks" || got.Summary != "create a task" ||
		got.Query["project"] != "core" || string(got.Body) != `{"title":"Ship it"}` {
		t.Fatalf("GetPending = %+v, want the parked write intact", got)
	}

	// The proposal is scoped per (chat, user): another user's "yes" must not be
	// able to claim it.
	if other, err := s.GetPending(ctx, "ch-1", "u-2"); err != nil || other != nil {
		t.Errorf("GetPending(other user) = (%+v, %v), want (nil, nil)", other, err)
	}

	// TakePending is the single point of mutual exclusion (GETDEL): if two "yes"
	// messages race, only one caller sees the value and executes.
	claimed, err := s.TakePending(ctx, "ch-1", "u-1")
	if err != nil || claimed == nil {
		t.Fatalf("TakePending = (%+v, %v), want the parked write", claimed, err)
	}
	second, err := s.TakePending(ctx, "ch-1", "u-1")
	if err != nil || second != nil {
		t.Errorf("second TakePending = (%+v, %v), want (nil, nil) — a duplicate yes must not re-execute", second, err)
	}
}

func TestCliffyInChatStore_ClearPending(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCliffyInChatStore(client)

	if err := s.SetPending(ctx, "ch-1", "u-1", pendingWrite()); err != nil {
		t.Fatalf("SetPending: %v", err)
	}
	// An unrelated message abandons the proposal, so a later "yes" can't fire a
	// stale write.
	s.ClearPending(ctx, "ch-1", "u-1")
	if got, err := s.GetPending(ctx, "ch-1", "u-1"); err != nil || got != nil {
		t.Errorf("after ClearPending: (%+v, %v), want (nil, nil)", got, err)
	}
}

// A corrupt value is an error rather than a zero-valued proposal — executing a
// write with an empty method and path would be worse than failing.
func TestCliffyInChatStore_CorruptPending(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCliffyInChatStore(client)

	if err := client.Set(ctx, cliffyPendingKey("ch-1", "u-1"), "not json", cliffyPendingTTL).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := s.GetPending(ctx, "ch-1", "u-1"); err == nil {
		t.Error("GetPending: want an error for a corrupt value")
	}
	if _, err := s.TakePending(ctx, "ch-1", "u-1"); err == nil {
		t.Error("TakePending: want an error for a corrupt value")
	}
}

func TestCliffyInChatStore_PendingRedisErrors(t *testing.T) {
	ctx := context.Background()

	if err := NewCliffyInChatStore(storeRedisClientFailingOn(t, "set")).
		SetPending(ctx, "ch-1", "u-1", pendingWrite()); err == nil {
		t.Error("SetPending: want the Redis failure surfaced")
	}
	if _, err := NewCliffyInChatStore(storeRedisClientFailingOn(t, "get")).
		GetPending(ctx, "ch-1", "u-1"); err == nil {
		t.Error("GetPending: want the Redis failure surfaced")
	}
	if _, err := NewCliffyInChatStore(storeRedisClientFailingOn(t, "getdel")).
		TakePending(ctx, "ch-1", "u-1"); err == nil {
		t.Error("TakePending: want the Redis failure surfaced")
	}
}

func TestCliffyInChatStore_ThreadMarkers(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCliffyInChatStore(client)

	if s.IsCliffyThread(ctx, "root-1") {
		t.Error("an unmarked thread must not report as Cliffy's")
	}
	s.MarkThread(ctx, "root-1")
	if !s.IsCliffyThread(ctx, "root-1") {
		t.Error("a marked thread should report as Cliffy's — replies there reach it without an @mention")
	}

	// An empty root id is a no-op both ways: a top-level message has no thread to
	// mark, and asking about "" must not match a stray key.
	s.MarkThread(ctx, "")
	if s.IsCliffyThread(ctx, "") {
		t.Error("an empty root id must never report as a Cliffy thread")
	}
}

// Body is a json.RawMessage, so an agent that proposed a malformed body fails at
// the park rather than being stored and executed later.
func TestCliffyInChatStore_SetPendingRejectsInvalidBody(t *testing.T) {
	s := NewCliffyInChatStore(storeRedisClient(t))
	p := pendingWrite()
	p.Body = json.RawMessage(`{not json`)
	if err := s.SetPending(context.Background(), "ch-1", "u-1", p); err == nil {
		t.Fatal("want an error for a body that is not valid JSON")
	}
}
