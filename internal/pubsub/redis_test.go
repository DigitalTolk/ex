package pubsub

import "testing"

// Redis-backed pub/sub tests live in the integration-tagged files and run
// against a real container; the tests here never touch a server.

func TestNewRedisPubSubBadURL(t *testing.T) {
	_, err := NewRedisPubSub("not-a-valid-url")
	if err == nil {
		t.Fatal("expected error for bad URL")
	}
}

func TestChannelName(t *testing.T) {
	got := ChannelName("abc123")
	want := "chan:abc123"
	if got != want {
		t.Fatalf("ChannelName: got %q, want %q", got, want)
	}
}

func TestConversationName(t *testing.T) {
	got := ConversationName("conv456")
	want := "conv:conv456"
	if got != want {
		t.Fatalf("ConversationName: got %q, want %q", got, want)
	}
}
