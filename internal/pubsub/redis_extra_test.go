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
