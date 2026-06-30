// Package safe provides panic-isolated goroutine spawning. net/http recovers
// panics on the request goroutine, but a panic in a detached `go func()` spawned
// off that request (the many fire-and-forget notify/index/fan-out goroutines in
// this codebase) is unrecovered and takes down the whole process — dropping
// every WebSocket client on the instance. Spawning such work via safe.Go (or
// guarding a hand-rolled goroutine with `defer safe.Recover()`) confines a panic
// to a logged ERROR instead.
package safe

import (
	"log/slog"
	"runtime/debug"
)

// Go runs fn in a new goroutine whose panics are recovered and logged.
func Go(fn func()) {
	go func() {
		defer Recover()
		fn()
	}()
}

// Recover recovers and logs a panic in the current goroutine. Use it as the
// first deferred call at the top of a manually-spawned goroutine body.
func Recover() {
	if r := recover(); r != nil {
		slog.Error("recovered from panic in background goroutine",
			"panic", r, "stack", string(debug.Stack()))
	}
}
