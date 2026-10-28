package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/DigitalTolk/ex/internal/service"
)

// notifications is the alert pipeline: the notifier, its audience cache, and
// the durable task queue behind mobile push and the fan-out safety net.
type notifications struct {
	svc       *service.NotificationService
	taskRedis *redis.Client
	queue     *service.AsynqPushScheduler
	worker    *service.AsynqPushWorker
}

// startTaskWorker is a seam over the worker start: a fresh asynq server only
// refuses to start when it is already running or stopped, so its failure arm
// is otherwise unreachable from a test.
var startTaskWorker = (*service.AsynqPushWorker).Start

func (a *App) buildNotifications(context.Context) error {
	cfg, in, c, n := a.cfg, &a.infra, &a.chat, &a.notify

	n.svc = service.NewNotificationServiceFromDeps(service.NotificationServiceDeps{
		Publisher:     in.pubsub,
		Memberships:   in.memberships,
		Conversations: in.conversations,
		Channels:      in.channels,
		Users:         in.users,
		Messages:      in.messages,
		Presence:      c.presence,
		ThreadFollows: in.threadFollows,
		UserState:     c.userState,
		// Desktop-delivery acks: the notifier reads them to gate the deferred
		// mobile-push fallback; the WS handler records them. Both share the
		// same Redis-backed store so an ack and the deferred push can live on
		// different backend instances.
		AckStore: in.cache,
		// Cache channel/author names off the per-message notify path.
		NameCache: in.cache,
	})
	// Generation-checked audience cache: members, mutes, per-channel and
	// account notification settings stay in process while their Redis
	// generations match; every in-app change bumps them synchronously.
	audience := service.NewAudienceCache(service.NewRedisAudienceGenerations(in.cache.Client()))
	n.svc.SetAudienceCache(audience)
	c.channels.SetAudienceInvalidator(audience)
	c.users.SetAudienceInvalidator(audience)
	push := newPushSender(cfg)

	// Durable task queue (asynq over Redis): mobile pushes (immediate or
	// ack-deferred) and the notification safety net (a check per message that
	// re-runs a fan-out a crash or deploy lost). Tasks survive restarts and
	// any instance's worker runs them. Dedicated Redis client so asynq's
	// polling never contends with the cache/pubsub pools; closed after the
	// worker and producer.
	n.taskRedis = redis.NewClient(mustRedisOptions(redisx.Options(cfg.RedisURL)))
	a.onClose(func() { _ = n.taskRedis.Close() })
	n.queue = service.NewAsynqPushScheduler(n.taskRedis)
	a.onClose(func() { _ = n.queue.Close() })
	n.svc.SetNotifyMarker(service.NewRedisNotifyMarker(in.cache.Client()))
	c.messages.SetNotifySafetyNet(n.queue)
	var pushHandler func(context.Context, *asynq.Task) error
	if push != nil {
		n.svc.SetMobilePushScheduler(n.queue)
		pushHandler = service.NewMobilePushTaskHandler(in.cache, push)
	}
	n.worker = service.NewAsynqPushWorker(n.taskRedis, pushHandler,
		service.AsynqPushWorkerConfig{Concurrency: cfg.PushWorkerConcurrency})
	n.worker.Handle(service.TaskTypeNotifyCheck, n.svc.NotifyCheckTaskHandler())
	if err := startTaskWorker(n.worker); err != nil {
		slog.Error("durable task worker failed to start — scheduled pushes and notification checks will wait for another instance", "error", err)
	} else {
		// Shutdown waits for in-flight tasks and requeues the rest in Redis —
		// never drops them (the old in-memory queue did exactly that).
		a.onClose(n.worker.Shutdown)
	}
	// A message service that alerts nobody is an incident, not a degraded
	// mode: the boot-time wiring check refuses to serve without the full
	// notification pipeline.
	c.messages.SetNotifier(n.svc)
	a.agents.orch.SetApprovalNotifier(n.svc)
	// An install revoked for being used away from its computer alerts its owner.
	a.agents.runnerTokens.SetOwnerNotifier(n.svc)
	n.svc.SetActivityRecorder(c.activity) // mentions, thread replies, DMs
	c.reminders.SetDelivery(c.activity, n.svc)
	n.svc.SetMentionResolver(c.mentions)
	return nil
}

// newPushSender builds the OneSignal mobile-push sender; nil when it is not
// configured, or misconfigured (mobile push then stays off, loudly).
func newPushSender(cfg *config.Config) *service.OneSignalPushSender {
	p, err := service.NewOneSignalPushSender(service.OneSignalConfig{
		AppID:     cfg.OneSignalAppID,
		APIKey:    cfg.OneSignalRESTAPIKey,
		PublicURL: cfg.BaseURL,
	})
	if err != nil {
		slog.Warn("OneSignal mobile push disabled", "error", err)
		return nil
	}
	return p
}

// mustRedisOptions unwraps redisx.Options for a URL the Redis cache already
// parsed successfully at boot — a failure here would be a programmer error.
func mustRedisOptions(o *redis.Options, err error) *redis.Options {
	if err != nil {
		panic(fmt.Sprintf("app: redis options for an already-parsed URL failed: %v", err))
	}
	return o
}
