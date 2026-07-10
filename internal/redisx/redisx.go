// Package redisx centralizes go-redis quirks every Redis-backed package
// (cache, pubsub, store, migrate) must handle identically: client options
// hardened against the maintenance-notifications handshake, and Lua script
// execution hardened against NOSCRIPT errors surfacing to callers.
package redisx

import (
	"context"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"
)

// Options parses a Redis URL into client options with the maintenance-
// notifications handshake disabled. go-redis defaults the feature to "auto",
// which sends CLIENT MAINT_NOTIFICATIONS during every connection handshake;
// a server that doesn't know the subcommand rejects it, and auto-mode's
// downgrade has proven leaky across client/server version pairs — in
// production the rejection surfaced through the boot PING as
// `ERR unknown subcommand 'maint_notifications'` and aborted startup. The
// feature only matters for Redis Enterprise hitless upgrades, which this app
// never runs against, so the handshake is disabled outright instead of
// trusting auto-mode to degrade.
func Options(redisURL string) (*redis.Options, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	opts.MaintNotificationsConfig = &maintnotifications.Config{Mode: maintnotifications.ModeDisabled}
	return opts, nil
}

// RunScript executes a cached Lua script, tolerating a server that no longer
// has its source cached (restart, SCRIPT FLUSH, failover to a fresh node).
// go-redis's own NOSCRIPT handling (the EvalSha normalization and Script.Run's
// EVAL fallback) only engages when the error still satisfies the redis.Error
// interface via errors.As; an error re-created by an instrumentation layer
// (production builds are Datadog-instrumented) loses that interface and
// escapes both checks — that surfaced as persistent `NOSCRIPT No matching
// script` failures from the emoji-frequency script after a Redis restart.
// Match the message text instead: a NOSCRIPT reply is only ever produced
// WITHOUT executing the script, so re-sending the full source via EVAL is
// always safe (and re-caches it server-side for subsequent EVALSHA calls).
func RunScript(ctx context.Context, c redis.Scripter, script *redis.Script, keys []string, args ...any) *redis.Cmd {
	cmd := script.Run(ctx, c, keys, args...)
	if err := cmd.Err(); err != nil && strings.Contains(err.Error(), "NOSCRIPT") {
		return script.Eval(ctx, c, keys, args...)
	}
	return cmd
}
