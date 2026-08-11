//go:build integration

package store

import (
	"context"
	"testing"
)

// The delayed slash-command response store (Mattermost's response_url). The
// token IS the credential, so what it authorizes is pinned here at mint time and
// bounded by a TTL — these tests pin both.

func pendingFixture() *PendingCommandResponse {
	return &PendingCommandResponse{
		CommandID:  "cmd-1",
		Trigger:    "deploy",
		UserID:     "u-1",
		ParentID:   "ch-1",
		ParentType: "channel",
		BotUserID:  "bot_deploy",
		Username:   "Deploy Bot",
		IconURL:    "https://cdn.example.com/deploy.png",
	}
}

func TestCommandResponseStore_PutGetDelete(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCommandResponseStore(client)

	if err := s.Put(ctx, "tok-1", pendingFixture()); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := s.Get(ctx, "tok-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("Get returned nothing for a stored token")
	}
	// Every field is server-authored; a stolen token must not be able to retarget
	// the post, so all of it has to survive the round trip intact.
	want := pendingFixture()
	if *got != *want {
		t.Errorf("Get = %+v, want %+v", got, want)
	}

	// The TTL is what bounds how long a leaked URL stays useful.
	ttl, err := client.TTL(ctx, commandResponseKey("tok-1")).Result()
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	if ttl <= 0 || ttl > CommandResponseTTL {
		t.Errorf("TTL = %v, want a positive value no greater than %v", ttl, CommandResponseTTL)
	}

	// Get does not consume the token: MM's response_url accepts several posts
	// within its window (progress, then a result).
	if again, err := s.Get(ctx, "tok-1"); err != nil || again == nil {
		t.Errorf("second Get = (%+v, %v), want the token still valid", again, err)
	}

	s.Delete(ctx, "tok-1")
	if got, err := s.Get(ctx, "tok-1"); err != nil || got != nil {
		t.Errorf("after Delete: (%+v, %v), want (nil, nil)", got, err)
	}
}

// An unknown token is (nil, nil) — absence, not an error, so the caller reports
// "unknown or expired" rather than a server fault.
func TestCommandResponseStore_UnknownToken(t *testing.T) {
	s := NewCommandResponseStore(storeRedisClient(t))
	got, err := s.Get(context.Background(), "never-minted")
	if err != nil || got != nil {
		t.Fatalf("Get = (%+v, %v), want (nil, nil)", got, err)
	}
}

// A corrupt value is an error, not a silent zero-valued invocation — posting with
// an empty parent id would be worse than failing.
func TestCommandResponseStore_CorruptValue(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCommandResponseStore(client)

	if err := client.Set(ctx, commandResponseKey("tok-bad"), "not json", CommandResponseTTL).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := s.Get(ctx, "tok-bad"); err == nil {
		t.Fatal("want an error for a corrupt stored value")
	}
}

// Re-putting the same token overwrites it — that is how the synchronous response
// threads a later delayed one under the message it just posted.
func TestCommandResponseStore_Overwrite(t *testing.T) {
	client := storeRedisClient(t)
	ctx := context.Background()
	s := NewCommandResponseStore(client)

	if err := s.Put(ctx, "tok-2", pendingFixture()); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rethreaded := pendingFixture()
	rethreaded.RootMessageID = "m-99"
	if err := s.Put(ctx, "tok-2", rethreaded); err != nil {
		t.Fatalf("Put (rethread): %v", err)
	}
	got, err := s.Get(ctx, "tok-2")
	if err != nil || got == nil {
		t.Fatalf("Get = (%+v, %v)", got, err)
	}
	if got.RootMessageID != "m-99" {
		t.Errorf("RootMessageID = %q, want the rethreaded value", got.RootMessageID)
	}
}

// A Redis that refuses the write surfaces the error rather than silently handing
// the integration a response_url that could never be honored.
func TestCommandResponseStore_PutError(t *testing.T) {
	s := NewCommandResponseStore(storeRedisClientFailingOn(t, "set"))
	if err := s.Put(context.Background(), "tok-3", pendingFixture()); err == nil {
		t.Fatal("want the Redis failure surfaced")
	}
}

func TestCommandResponseStore_GetError(t *testing.T) {
	s := NewCommandResponseStore(storeRedisClientFailingOn(t, "get"))
	if _, err := s.Get(context.Background(), "tok-4"); err == nil {
		t.Fatal("want the Redis failure surfaced")
	}
}
