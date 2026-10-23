package handler

import (
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/wiring"
)

func TestHandlerWiredReportsMissingDependencies(t *testing.T) {
	cases := []struct {
		component string
		c         wiring.Checker
		missing   string
	}{
		{"websocket handler", &WSHandler{}, "notification ack recorder"},
		{"runner token handler", &RunnerTokenHandler{}, "live runners"},
		{"agent handler", &AgentHandler{}, "timeline access"},
		{"agent run tool handler", &AgentRunToolHandler{}, "workspace"},
		{"user state handler", &UserStateHandler{}, "skill lookup"},
		{"presence handler", &PresenceHandler{}, "always-online roster"},
		{"unfurl handler", &UnfurlHandler{}, "message links"},
		{"sidebar handler", &SidebarHandler{}, "sidebar service"},
	}
	for _, tc := range cases {
		err := tc.c.Wired()
		if err == nil {
			t.Errorf("%s: Wired = nil on a zero value, want the missing dependencies", tc.component)
			continue
		}
		if msg := err.Error(); !strings.Contains(msg, tc.component+": not wired:") || !strings.Contains(msg, tc.missing) {
			t.Errorf("%s: Wired = %q, want it to name %q", tc.component, msg, tc.missing)
		}
	}
}
