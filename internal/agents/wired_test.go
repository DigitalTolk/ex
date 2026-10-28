package agents

import (
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/wiring"
)

func TestAgentWiredReportsMissingDependencies(t *testing.T) {
	cases := []struct {
		component string
		c         wiring.Checker
		missing   string
	}{
		{"runner token service", &RunnerTokenService{}, "publisher"},
		{"runner token service", &RunnerTokenService{}, "owner notifier"},
		{"agent service", &AgentService{}, "DM resolver"},
		{"orchestrator", &Orchestrator{}, "approval notifier"},
		{"project service", &ProjectService{}, "publisher"},
		{"coding task service", &CodingTaskService{}, "base URL"},
		{"server engine", &ServerEngine{}, "run API base"},
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
