package agents

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/redis/go-redis/v9"
)

// Cross-instance coordination for the orchestrator.
//
// Production runs two or more instances behind a load balancer, so the calls
// that make up one run (the mention, the claim, every event batch, the
// terminal transition) land on instances at random. The orchestrator used to
// keep the state that ties those calls together in per-process maps — the
// one-turn-per-thread slot, the hand-off parked behind a busy turn, the claim
// long-poll wakeups, the typing indicator — and two production bugs came from
// an instance not seeing what its sibling did (a slot nobody released, a
// parked hand-off nobody started). A 2-second polling watchdog patched the
// second one, and everything was still lost on a restart.
//
// turnCoordinator is that state behind one interface: the in-process maps
// (localTurns) for a single process with no Redis, and Redis
// (RedisTurnCoordinator) in production, shared by every instance and
// surviving restarts. Lease deadlines need no copy here: the lease is on the
// run row, and the reconciler's lease sweep (sweepLeases) reads it from the
// store on every instance.
type turnCoordinator interface {
	// claimTurn takes the (parent, thread, agent, invoker) slot for runID; when
	// it is held, holder names the run holding it.
	claimTurn(ctx context.Context, key, runID string) (holder string, taken bool)
	// replaceTurn hands a slot from a dead holder to runID — compare-and-swap,
	// so two instances healing the same slot cannot both win.
	replaceTurn(ctx context.Context, key, deadRunID, runID string) bool
	// releaseTurn frees the slot iff runID still holds it (token-fenced).
	releaseTurn(ctx context.Context, key, runID string)
	// turnHolder reports the run holding the slot ("" when free).
	turnHolder(ctx context.Context, key string) string
	// parkTurn queues ONE hand-off behind the slot; the first one wins.
	parkTurn(ctx context.Context, key string, turn *deferredTurn) (bool, error)
	// takeTurn removes and returns the slot's parked hand-off (nil when none).
	takeTurn(ctx context.Context, key string) *deferredTurn
	// dropTurns discards every hand-off parked in one thread (key prefix).
	dropTurns(ctx context.Context, prefix string)
	// wakeOwner wakes the owner's parked claim long-polls on EVERY instance.
	wakeOwner(ctx context.Context, ownerID string)
	// typingTurn reports whether this instance publishes the run's typing
	// frames: several instances can hold a ticker for one run (the claimer,
	// every instance that recovered it at boot), only one may speak.
	typingTurn(ctx context.Context, runID string) bool
}

// turns is the coordinator in use: Redis when wired, the process's own maps
// otherwise.
func (o *Orchestrator) turns() turnCoordinator {
	if o.coord != nil {
		return o.coord
	}
	return localTurns{o}
}

// SetTurnCoordinator shares the orchestrator's turn state with every other
// instance through Redis, and subscribes this instance to the claim wakeups
// the others publish (until ctx ends). Without it the state stays in-process —
// correct for exactly one instance.
func (o *Orchestrator) SetTurnCoordinator(ctx context.Context, c *RedisTurnCoordinator) {
	c.subscribe(ctx, o.wakeLocal)
	o.coord = c
}

// ---------------------------------------------------------------- in-process

// localTurns is the single-process coordinator over the orchestrator's maps.
type localTurns struct{ o *Orchestrator }

func (l localTurns) claimTurn(_ context.Context, key, runID string) (string, bool) {
	held, busy := l.o.threadActive.LoadOrStore(key, runID)
	if !busy {
		return runID, true
	}
	holder, _ := held.(string)
	return holder, holder == runID
}

func (l localTurns) replaceTurn(_ context.Context, key, deadRunID, runID string) bool {
	return l.o.threadActive.CompareAndSwap(key, deadRunID, runID)
}

func (l localTurns) releaseTurn(_ context.Context, key, runID string) {
	l.o.threadActive.CompareAndDelete(key, runID)
}

func (l localTurns) turnHolder(_ context.Context, key string) string {
	held, _ := l.o.threadActive.Load(key)
	holder, _ := held.(string)
	return holder
}

func (l localTurns) parkTurn(_ context.Context, key string, turn *deferredTurn) (bool, error) {
	_, loaded := l.o.deferredTurns.LoadOrStore(key, turn)
	return !loaded, nil
}

func (l localTurns) takeTurn(_ context.Context, key string) *deferredTurn {
	d, ok := l.o.deferredTurns.LoadAndDelete(key)
	if !ok {
		return nil
	}
	return d.(*deferredTurn)
}

func (l localTurns) dropTurns(_ context.Context, prefix string) {
	l.o.deferredTurns.Range(func(k, _ any) bool {
		if strings.HasPrefix(k.(string), prefix) {
			l.o.deferredTurns.Delete(k)
		}
		return true
	})
}

// wakeOwner is a no-op: wake() already woke this process's pollers.
func (localTurns) wakeOwner(context.Context, string) {}

// typingTurn: one process, one ticker per run.
func (localTurns) typingTurn(context.Context, string) bool { return true }

// --------------------------------------------------------------------- Redis

// Redis key layout and lifetimes. A turn slot outlives any real run (a
// coding task's idle deadline reaps it long before); one that does lapse
// only lets one extra turn through, and a held slot whose run is dead is
// healed on the next turn (replaceTurn). A parked hand-off expires after the
// same 30 minutes the old watchdog waited.
const (
	turnSlotTTL     = 48 * time.Hour
	turnWakeChannel = "orch:wake"
)

func turnSlotKey(key string) string         { return "orch:turn:" + key }
func turnParkKey(key string) string         { return "orch:park:" + key }
func turnParkIndexKey(prefix string) string { return "orch:parkidx:" + prefix }
func turnTypingKey(runID string) string     { return "orch:typing:" + runID }

// turnPrefixOf is the thread prefix (turnKeyPrefix) of a turn key
// "parent#thread#agent#invoker" — IDs never contain '#'.
func turnPrefixOf(key string) string {
	parts := strings.SplitN(key, "#", 3)
	if len(parts) < 3 {
		return key
	}
	return parts[0] + "#" + parts[1] + "#"
}

var (
	// replaceTurnScript: SET the slot to ARGV[2] only if it still holds ARGV[1].
	replaceTurnScript = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`)
	// releaseTurnScript: token-fenced compare-and-delete.
	releaseTurnScript = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`)
	// typingTurnScript: keep (or take, when free) the typing lease for this
	// instance; another instance's live lease means "not you".
	typingTurnScript = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if not cur then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0`)
)

// RedisTurnCoordinator shares the orchestrator's turn state across instances.
// Every failure degrades in the direction the notification contract prefers
// — an extra turn, a duplicate typing frame — never a silently dropped reply.
type RedisTurnCoordinator struct {
	rdb      redis.UniversalClient
	instance string
}

// NewRedisTurnCoordinator wraps an existing go-redis client (built through
// redisx.Options like every other Redis client in the app).
func NewRedisTurnCoordinator(rdb redis.UniversalClient) *RedisTurnCoordinator {
	return &RedisTurnCoordinator{rdb: rdb, instance: store.NewID()}
}

func (c *RedisTurnCoordinator) claimTurn(ctx context.Context, key, runID string) (string, bool) {
	ok, err := c.rdb.SetNX(ctx, turnSlotKey(key), runID, turnSlotTTL).Result()
	if err != nil {
		// Refusing every turn because Redis is unreachable is strictly worse
		// than letting one extra one through.
		slog.WarnContext(ctx, "turn slot claim failed; letting the turn through", "key", key, "error", err)
		return runID, true
	}
	if ok {
		return runID, true
	}
	holder, err := c.rdb.Get(ctx, turnSlotKey(key)).Result()
	if err != nil {
		// Taken a moment ago and gone (or unreadable) now: the turn is free.
		return runID, true
	}
	return holder, holder == runID
}

func (c *RedisTurnCoordinator) replaceTurn(ctx context.Context, key, deadRunID, runID string) bool {
	n, err := redisx.RunScript(ctx, c.rdb, replaceTurnScript, []string{turnSlotKey(key)},
		deadRunID, runID, turnSlotTTL.Milliseconds()).Int()
	if err != nil {
		slog.WarnContext(ctx, "turn slot heal failed; letting the turn through", "key", key, "error", err)
		return true
	}
	return n == 1
}

func (c *RedisTurnCoordinator) releaseTurn(ctx context.Context, key, runID string) {
	if err := redisx.RunScript(ctx, c.rdb, releaseTurnScript, []string{turnSlotKey(key)}, runID).Err(); err != nil {
		// The next turn finds the holder terminal and heals the slot.
		slog.WarnContext(ctx, "turn slot release failed", "key", key, "runID", runID, "error", err)
	}
}

func (c *RedisTurnCoordinator) turnHolder(ctx context.Context, key string) string {
	holder, err := c.rdb.Get(ctx, turnSlotKey(key)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		slog.WarnContext(ctx, "turn slot read failed; treating it as free", "key", key, "error", err)
	}
	return holder
}

// deferredTurnWire is a parked hand-off as stored in Redis.
type deferredTurnWire struct {
	AgentID    string            `json:"agentID"`
	InvokerID  string            `json:"invokerID"`
	Msg        *model.Message    `json:"msg"`
	ParentType string            `json:"parentType"`
	Round      int               `json:"round,omitempty"`
	Untrusted  bool              `json:"untrusted,omitempty"`
	Task       *model.CodingTask `json:"task,omitempty"`
	Prompt     string            `json:"prompt,omitempty"`
}

func (c *RedisTurnCoordinator) parkTurn(ctx context.Context, key string, turn *deferredTurn) (bool, error) {
	w := deferredTurnWire{
		AgentID: turn.agentID, InvokerID: turn.invokerID, Msg: turn.msg,
		ParentType: turn.parentType, Round: turn.round, Untrusted: turn.untrusted,
	}
	if turn.bind != nil {
		w.Task, w.Prompt = turn.bind.task, turn.bind.prompt
	}
	ok, err := c.rdb.SetNX(ctx, turnParkKey(key), mustJSONBody(json.Marshal(w)), deferredWatchLimit).Result()
	if err != nil || !ok {
		return false, err
	}
	// The thread's index lets StopThread find every hand-off parked in it.
	idx := turnParkIndexKey(turnPrefixOf(key))
	pipe := c.rdb.TxPipeline()
	pipe.SAdd(ctx, idx, key)
	pipe.Expire(ctx, idx, deferredWatchLimit)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.WarnContext(ctx, "parked hand-off not indexed; a thread stop may miss it", "key", key, "error", err)
	}
	return true, nil
}

func (c *RedisTurnCoordinator) takeTurn(ctx context.Context, key string) *deferredTurn {
	raw, err := c.rdb.GetDel(ctx, turnParkKey(key)).Bytes()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			slog.WarnContext(ctx, "parked hand-off read failed", "key", key, "error", err)
		}
		return nil
	}
	_ = c.rdb.SRem(ctx, turnParkIndexKey(turnPrefixOf(key)), key).Err()
	var w deferredTurnWire
	if err := json.Unmarshal(raw, &w); err != nil {
		slog.WarnContext(ctx, "parked hand-off unreadable; dropped", "key", key, "error", err)
		return nil
	}
	turn := &deferredTurn{
		agentID: w.AgentID, invokerID: w.InvokerID, msg: w.Msg,
		parentType: w.ParentType, round: w.Round, untrusted: w.Untrusted,
	}
	if w.Task != nil {
		turn.bind = &taskBind{task: w.Task, prompt: w.Prompt}
	}
	return turn
}

func (c *RedisTurnCoordinator) dropTurns(ctx context.Context, prefix string) {
	idx := turnParkIndexKey(prefix)
	keys, err := c.rdb.SMembers(ctx, idx).Result()
	if err != nil {
		slog.WarnContext(ctx, "thread stop: parked hand-offs unreadable", "prefix", prefix, "error", err)
		return
	}
	del := make([]string, 0, len(keys)+1)
	for _, k := range keys {
		del = append(del, turnParkKey(k))
	}
	if err := c.rdb.Del(ctx, append(del, idx)...).Err(); err != nil {
		slog.WarnContext(ctx, "thread stop: parked hand-offs not dropped", "prefix", prefix, "error", err)
	}
}

func (c *RedisTurnCoordinator) wakeOwner(ctx context.Context, ownerID string) {
	if err := c.rdb.Publish(ctx, turnWakeChannel, ownerID).Err(); err != nil {
		// Pollers on other instances fall back to their next poll tick.
		slog.WarnContext(ctx, "claim wakeup not broadcast", "ownerID", ownerID, "error", err)
	}
}

func (c *RedisTurnCoordinator) typingTurn(ctx context.Context, runID string) bool {
	n, err := redisx.RunScript(ctx, c.rdb, typingTurnScript, []string{turnTypingKey(runID)},
		c.instance, (2 * typingTickInterval).Milliseconds()).Int()
	if err != nil {
		return true // a duplicate typing frame beats a missing one
	}
	return n == 1
}

// subscribe relays claim wakeups published by any instance to this one's
// parked long-polls, until ctx ends. It returns once the subscription is
// live, so a wakeup published right after is never missed.
func (c *RedisTurnCoordinator) subscribe(ctx context.Context, wake func(ownerID string)) {
	sub := c.rdb.Subscribe(ctx, turnWakeChannel)
	if _, err := sub.Receive(ctx); err != nil {
		slog.WarnContext(ctx, "claim wakeup subscription failed; claims fall back to polling", "error", err)
		_ = sub.Close()
		return
	}
	msgs := sub.Channel()
	safe.Go(func() {
		<-ctx.Done()
		_ = sub.Close() // closes msgs, which ends the relay below
	})
	safe.Go(func() {
		for m := range msgs {
			wake(m.Payload)
		}
	})
}
