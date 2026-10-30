package app

import (
	"fmt"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// wireSharePoint turns on SharePoint link sharing when it is configured:
// sign-in keeps each user's Microsoft token, background jobs on the durable
// task queue share posted links as their poster, and joining or leaving a
// channel keeps that access in step.
func (a *App) wireSharePoint() {
	cfg, in, c, n := a.cfg, &a.infra, &a.chat, &a.notify
	if !cfg.SharePointEnabled() {
		return
	}
	// The config guarantees both: a 32-byte key, and SSO to renew with.
	tokens := mustBuild(service.NewDelegatedTokens(store.NewDelegatedTokenStore(in.db), cfg.SharePointTokenKey(), in.sso.OAuth2Config()))
	graph := mustBuild(msgraph.NewDelegated("", nil))
	sp := service.NewSharePointService(service.SharePointDeps{
		Records:       store.NewSharePointStore(in.db),
		Graph:         graph,
		Tokens:        tokens,
		Queue:         n.queue,
		Locks:         in.cache,
		Members:       in.memberships,
		Conversations: in.conversations,
		Users:         in.users,
		Messages:      in.messages,
		Access:        c.messages,
		Publisher:     in.pubsub,
		Hosts:         cfg.SharePointHosts(),
	})
	// A login keeps its token through sp, which then finishes what the
	// user's lapsed token left undone.
	c.auth.SetDelegatedTokens(sp)
	c.messages.SetSharePoint(sp)
	c.channels.SetSharePointSync(sp)
	n.sharePoint = sp

	// Its own queue and workers, apart from the push pipeline's.
	worker := service.NewAsynqPushWorker(n.taskRedis, nil, service.AsynqPushWorkerConfig{
		Concurrency: service.SharePointWorkerConcurrency,
		Queues:      map[string]int{service.SharePointTaskQueue: 1},
	})
	worker.Handle(service.TaskTypeSharePointSync, sp.TaskHandler())
	if err := startTaskWorker(worker); err != nil {
		slog.Error("sharepoint worker failed to start — links wait for another instance", "error", err)
		return
	}
	a.onClose(worker.Shutdown)
}

// mustBuild unwraps a constructor whose inputs the config already validated —
// a failure here would be a programmer error.
func mustBuild[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprintf("app: constructor with validated config failed: %v", err))
	}
	return v
}
