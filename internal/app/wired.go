package app

import (
	"context"
	"fmt"

	"github.com/DigitalTolk/ex/internal/wiring"
)

// checkWiring refuses the boot while any component misses a dependency
// production needs, naming every gap (instead of silently degrading: a
// message service with no notifier alerts nobody). Optional collaborators —
// wired only when their backend is configured — are checked by the
// components themselves only when present.
func (a *App) checkWiring(context.Context) error {
	c, ag, h := &a.chat, &a.agents, &a.http
	checkers := []wiring.Checker{
		c.auth, c.users, c.channels, c.conversations, c.messages, c.userState,
		c.emoji, c.presence, c.attachments, c.settings, c.unfurl, c.webhooks,
		c.commands, c.activity, c.reminders, c.scheduled,
		a.notify.svc,
		ag.runnerTokens, ag.svc, ag.orch, ag.codingTasks, ag.projects,
		h.ws, h.presence, h.userState, h.runnerToken, h.agent, h.agentRun,
		h.unfurl, h.sidebar,
	}
	if c.directorySync != nil {
		checkers = append(checkers, c.directorySync)
	}
	if ag.engine != nil {
		checkers = append(checkers, ag.engine)
	}
	if err := wiring.All(checkers...); err != nil {
		return fmt.Errorf("boot wiring incomplete: %w", err)
	}
	return nil
}
