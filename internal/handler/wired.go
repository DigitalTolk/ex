package handler

import "github.com/DigitalTolk/ex/internal/wiring"

// Production wiring checks (see internal/wiring) for the handlers that take
// collaborators through setters. Only what production always wires is listed.

func (h *WSHandler) Wired() error {
	return wiring.Check("websocket handler",
		wiring.Dep{Name: "notification ack recorder", Set: h.notifAck != nil},
		wiring.Dep{Name: "ticket store", Set: h.tickets != nil},
		wiring.Dep{Name: "publisher", Set: h.publisher != nil},
		wiring.Dep{Name: "user service", Set: h.userSvc != nil},
		wiring.Dep{Name: "replayer", Set: h.replayer != nil},
	)
}

func (h *RunnerTokenHandler) Wired() error {
	return wiring.Check("runner token handler",
		wiring.Dep{Name: "live runners", Set: h.live != nil},
	)
}

func (h *AgentHandler) Wired() error {
	return wiring.Check("agent handler",
		wiring.Dep{Name: "run files", Set: h.files != nil},
		wiring.Dep{Name: "timeline access", Set: h.access != nil},
	)
}

func (h *AgentRunToolHandler) Wired() error {
	return wiring.Check("agent run tool handler",
		wiring.Dep{Name: "base URL", Set: h.baseURL != ""},
		wiring.Dep{Name: "attachments", Set: h.attachments != nil},
		wiring.Dep{Name: "workspace", Set: h.workspace != nil},
	)
}

func (h *UserStateHandler) Wired() error {
	return wiring.Check("user state handler",
		wiring.Dep{Name: "skill lookup", Set: h.skills != nil},
	)
}

func (h *PresenceHandler) Wired() error {
	return wiring.Check("presence handler",
		wiring.Dep{Name: "always-online roster", Set: h.alwaysOnlineIDs != nil},
	)
}

func (h *UnfurlHandler) Wired() error {
	return wiring.Check("unfurl handler",
		wiring.Dep{Name: "message links", Set: h.msgLinks != nil},
	)
}

func (h *SidebarHandler) Wired() error {
	return wiring.Check("sidebar handler",
		wiring.Dep{Name: "sidebar service", Set: h.sidebarSvc != nil},
	)
}
