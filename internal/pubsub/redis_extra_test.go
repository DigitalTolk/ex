package pubsub

import "testing"

func TestChannelNameFormatting(t *testing.T) {
	cases := []struct {
		fn   func(string) string
		in   string
		want string
		name string
	}{
		{ChannelName, "abc", "chan:abc", "ChannelName"},
		{ConversationName, "abc", "conv:abc", "ConversationName"},
		{UserChannel, "abc", "user:abc", "UserChannel"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.fn(c.in); got != c.want {
				t.Errorf("%s(%q) = %q, want %q", c.name, c.in, got, c.want)
			}
		})
	}
}

func TestGlobalChannelEvents(t *testing.T) {
	if got := GlobalChannelEvents(); got != "global:channels" {
		t.Errorf("GlobalChannelEvents() = %q, want %q", got, "global:channels")
	}
}

// TestGlobalEventChannels covers the workspace-scoped channel-name builders.
// These map to fan-out topics every connected user subscribes to (or every
// instance, in the global emoji-catalog case).
func TestGlobalEventChannels(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"GlobalEmojiEvents", GlobalEmojiEvents(), "global:emojis"},
		{"PresenceEvents", PresenceEvents(), "global:presence"},
		{"UserEvents", UserEvents(), "global:users"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.got != c.want {
				t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
			}
		})
	}
}
