package agents

import "github.com/DigitalTolk/ex/internal/wiring"

// Production wiring checks for the agent subsystem (see internal/wiring and
// internal/service/wired.go).

func (s *RunnerTokenService) Wired() error {
	return wiring.Check("runner token service",
		wiring.Dep{Name: "publisher", Set: s.pub != nil},
		wiring.Dep{Name: "owner notifier", Set: s.notifier != nil},
	)
}

func (s *AgentService) Wired() error {
	return wiring.Check("agent service",
		wiring.Dep{Name: "user lister", Set: s.userList != nil},
		wiring.Dep{Name: "DM resolver", Set: s.dms != nil},
	)
}

// Wired covers what boot wires. The turn coordinator is attached when the
// background workers start (it needs their context), so it is not listed.
func (o *Orchestrator) Wired() error {
	return wiring.Check("orchestrator",
		wiring.Dep{Name: "owner DM resolver", Set: o.ownerDM != nil},
		wiring.Dep{Name: "context service", Set: o.ctxSvc != nil},
		wiring.Dep{Name: "connector registry", Set: o.connectors != nil},
		wiring.Dep{Name: "skill prefs", Set: o.skillPrefs != nil},
		wiring.Dep{Name: "attachments", Set: o.attachments != nil},
		wiring.Dep{Name: "approval notifier", Set: o.notifier != nil},
		wiring.Dep{Name: "task store", Set: o.tasks != nil},
		wiring.Dep{Name: "projects", Set: o.projects != nil},
	)
}

func (s *ProjectService) Wired() error {
	return wiring.Check("project service",
		wiring.Dep{Name: "publisher", Set: s.publisher != nil},
	)
}

func (s *CodingTaskService) Wired() error {
	return wiring.Check("coding task service",
		wiring.Dep{Name: "base URL", Set: s.baseURL != ""},
	)
}

func (e *ServerEngine) Wired() error {
	return wiring.Check("server engine",
		wiring.Dep{Name: "run API base", Set: e.runAPIBase != ""},
	)
}
