//go:build integration

package agents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/redis/go-redis/v9"
)

// Two orchestrator instances over ONE store and ONE Redis — what production
// runs behind its load balancer. Each test picks which instance sees which
// call, including the worst split.

// redisPair is newOrchCovTwoInstances with both instances sharing a Redis
// turn coordinator (their own instance ids, like two tasks).
func redisPair(t *testing.T) (*orchCovTwoInstances, *redis.Client) {
	t.Helper()
	x := newOrchCovTwoInstances(t)
	rdb := newTestRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	x.a.SetTurnCoordinator(ctx, NewRedisTurnCoordinator(rdb))
	x.b.SetTurnCoordinator(ctx, NewRedisTurnCoordinator(rdb))
	return x, rdb
}

func (x *orchCovTwoInstances) queued(t *testing.T) []string {
	t.Helper()
	ids, err := x.runs.fakeRunStore.ListQueuedRuns(context.Background(), "u-alice", 50)
	if err != nil {
		t.Fatalf("list queued: %v", err)
	}
	return ids
}

func dmReply(id, root, body string) *model.Message {
	return &model.Message{ID: id, ParentID: "dm1", ParentMessageID: root, AuthorID: "u-alice", Body: body}
}

// One turn per (thread, agent, invoker) holds across instances: B sees A's
// live turn as busy and parks the reply in Redis — not in B's own memory —
// and A, finishing the run, starts the hand-off B parked. No watchdog is
// involved (its interval is an hour here).
func TestRedisTurns_SlotAndHandOffSpanInstances(t *testing.T) {
	old := deferredWatchInterval
	deferredWatchInterval = time.Hour
	defer func() { deferredWatchInterval = old }()
	x, rdb := redisPair(t)
	ctx := context.Background()

	x.a.OnMessage(ctx, dmReply("r-m1", "r-root", "first"), service.ParentConversation, x.dm)
	ids := x.queued(t)
	if len(ids) != 1 {
		t.Fatalf("A started %d runs", len(ids))
	}
	key := turnKey("dm1", "r-root", testGGID, "u-alice")
	if holder := rdb.Get(ctx, turnSlotKey(key)).Val(); holder != ids[0] {
		t.Fatalf("the slot must live in Redis, held by %s; got %q", ids[0], holder)
	}

	x.b.OnMessage(ctx, dmReply("r-m2", "r-root", "second"), service.ParentConversation, x.dm)
	if len(x.queued(t)) != 1 {
		t.Fatal("B must see A's turn as busy")
	}
	if _, local := x.b.deferredTurns.Load(key); local {
		t.Fatal("the hand-off must be parked in Redis, not in B's memory")
	}
	if rdb.Exists(ctx, turnParkKey(key)).Val() != 1 {
		t.Fatal("the hand-off is not parked in Redis")
	}

	x.finishOn(t, x.a, ids[0])
	after := x.queued(t)
	if len(after) != 2 {
		t.Fatalf("A must start the hand-off B parked (queued %d)", len(after))
	}
	second, _ := x.runs.GetRun(ctx, after[1])
	if second.MessageID != "r-m2" || rdb.Exists(ctx, turnParkKey(key)).Val() != 0 {
		t.Fatalf("wrong hand-off started or left parked: %+v", second)
	}
	if holder := rdb.Get(ctx, turnSlotKey(key)).Val(); holder != second.ID {
		t.Fatalf("the slot must pass to the hand-off; held by %q", holder)
	}
}

// A slot whose holder already finished (its release was lost) is healed by
// the next turn on any instance.
func TestRedisTurns_DeadHolderIsHealed(t *testing.T) {
	x, rdb := redisPair(t)
	ctx := context.Background()
	x.a.OnMessage(ctx, dmReply("h-m1", "h-root", "one"), service.ParentConversation, x.dm)
	first := x.queued(t)[0]
	run, _ := x.runs.GetRun(ctx, first)
	run.State = model.RunStateCompleted
	if err := x.runs.UpdateRun(ctx, run, model.RunStateQueued); err != nil {
		t.Fatal(err)
	}
	// No afterTerminal anywhere: the slot still names the finished run.
	x.b.OnMessage(ctx, dmReply("h-m2", "h-root", "two"), service.ParentConversation, x.dm)
	ids := x.queued(t)
	if len(ids) != 2 {
		t.Fatalf("a finished holder must not keep the agent busy (queued %d)", len(ids))
	}
	key := turnKey("dm1", "h-root", testGGID, "u-alice")
	if holder := rdb.Get(ctx, turnSlotKey(key)).Val(); holder != ids[1] {
		t.Fatalf("slot not healed: %q", holder)
	}
}

// A runner's claim long-poll parked on B wakes the moment A queues a run for
// its owner — the poll tick is a minute here, so only the broadcast can do it.
func TestRedisTurns_ClaimWakeupReachesTheOtherInstance(t *testing.T) {
	old := claimPollInterval
	claimPollInterval = time.Minute
	defer func() { claimPollInterval = old }()
	x, _ := redisPair(t)
	ctx := context.Background()

	got := make(chan []Assignment, 1)
	go func() {
		as, _ := x.b.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 30*time.Second)
		got <- as
	}()
	waitFor(t, func() bool {
		x.b.mu.Lock()
		defer x.b.mu.Unlock()
		return x.b.wakeups["u-alice"] != nil
	})
	x.a.OnMessage(ctx, dmReply("w-m1", "w-root", "wake up"), service.ParentConversation, x.dm)
	select {
	case as := <-got:
		if len(as) != 1 || as[0].MessageID != "w-m1" {
			t.Fatalf("claim on B returned %+v", as)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("B's parked claim was not woken by A's run")
	}
}

// countingPub counts typing frames.
type countingPub struct {
	mu     sync.Mutex
	typing int
}

func (p *countingPub) Publish(_ context.Context, _ string, e *events.Event) error {
	if e.Type == events.EventTyping {
		p.mu.Lock()
		p.typing++
		p.mu.Unlock()
	}
	return nil
}

func (p *countingPub) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.typing
}

// Both instances tick for one run (one claimed it, one recovered it at
// boot); only the holder of the run's typing lease publishes.
func TestRedisTurns_OneInstanceTypesPerRun(t *testing.T) {
	oldTick, oldLease := typingTickInterval, typingLeaseTicks
	// Fast ticks, and a lease no scheduler pause outlasts: at the default two
	// ticks (10ms here) a busy machine let the holder's lease lapse, and the
	// other instance rightly took over (see the next test).
	typingTickInterval, typingLeaseTicks = 5*time.Millisecond, 12000
	defer func() { typingTickInterval, typingLeaseTicks = oldTick, oldLease }()
	x, _ := redisPair(t)
	pa, pb := &countingPub{}, &countingPub{}
	x.a.pub, x.b.pub = pa, pb
	run := &model.Run{ID: "typing-run", AgentID: testGGID, ParentID: "dm1", ParentType: service.ParentConversation, State: model.RunStateRunning}
	x.runs.runs[run.ID] = run
	x.a.startTypingTicker(run)
	x.b.startTypingTicker(run)
	defer x.a.stopTypingTicker(run.ID)
	defer x.b.stopTypingTicker(run.ID)
	waitFor(t, func() bool { return pa.count()+pb.count() >= 5 })
	if pa.count() > 0 && pb.count() > 0 {
		t.Fatalf("both instances published typing frames (a=%d b=%d)", pa.count(), pb.count())
	}
}

// When the instance holding the typing lease stops ticking, another takes
// over once the lease runs out.
func TestRedisTurns_TypingTakenOverWhenTheHolderStops(t *testing.T) {
	old := typingTickInterval
	typingTickInterval = 5 * time.Millisecond
	defer func() { typingTickInterval = old }()
	x, _ := redisPair(t)
	pa, pb := &countingPub{}, &countingPub{}
	x.a.pub, x.b.pub = pa, pb
	run := &model.Run{ID: "typing-handover", AgentID: testGGID, ParentID: "dm1", ParentType: service.ParentConversation, State: model.RunStateRunning}
	x.runs.runs[run.ID] = run
	x.a.startTypingTicker(run)
	waitFor(t, func() bool { return pa.count() > 0 })
	x.b.startTypingTicker(run)
	defer x.b.stopTypingTicker(run.ID)
	x.a.stopTypingTicker(run.ID)
	waitFor(t, func() bool { return pb.count() > 0 })
}

// The human brake on a thread reaches hand-offs parked by ANY instance.
func TestRedisTurns_StopThreadDropsHandOffsParkedElsewhere(t *testing.T) {
	x, rdb := redisPair(t)
	ctx := context.Background()
	x.a.OnMessage(ctx, dmReply("s-m1", "s-root", "one"), service.ParentConversation, x.dm)
	first := x.queued(t)[0]
	x.b.OnMessage(ctx, dmReply("s-m2", "s-root", "two"), service.ParentConversation, x.dm)
	key := turnKey("dm1", "s-root", testGGID, "u-alice")
	if rdb.Exists(ctx, turnParkKey(key)).Val() != 1 {
		t.Fatal("hand-off not parked")
	}
	if n, err := x.a.StopThread(ctx, "u-alice", first); err != nil || n != 1 {
		t.Fatalf("stop: %d %v", n, err)
	}
	if rdb.Exists(ctx, turnParkKey(key), turnParkIndexKey(turnPrefixOf(key))).Val() != 0 {
		t.Fatal("the stop left the parked hand-off behind")
	}
	if len(x.queued(t)) != 0 {
		t.Fatal("nothing may start after a stop")
	}
}

// A hand-off bound to a coding task survives the trip through Redis.
func TestRedisTurns_TaskBindRoundTrips(t *testing.T) {
	_, rdb := redisPair(t)
	c := NewRedisTurnCoordinator(rdb)
	ctx := context.Background()
	turn := &deferredTurn{agentID: testGGID, invokerID: "u-alice", msg: &model.Message{ID: "m", Body: "b"}, parentType: service.ParentChannel,
		round: 2, untrusted: true, bind: &taskBind{task: &model.CodingTask{ID: "t1", Title: "T"}, prompt: "steer"}}
	if ok, err := c.parkTurn(ctx, "p#t#a#i", turn); !ok || err != nil {
		t.Fatalf("park: %v %v", ok, err)
	}
	if again, _ := c.parkTurn(ctx, "p#t#a#i", &deferredTurn{msg: &model.Message{}}); again {
		t.Fatal("the first hand-off must win")
	}
	got := c.takeTurn(ctx, "p#t#a#i")
	if got == nil || got.msg.Body != "b" || got.round != 2 || !got.untrusted || got.bind == nil || got.bind.task.ID != "t1" || got.bind.prompt != "steer" {
		t.Fatalf("round trip: %+v", got)
	}
	if c.takeTurn(ctx, "p#t#a#i") != nil {
		t.Fatal("taking is once")
	}
	// An unreadable parked value is dropped, not started.
	rdb.Set(ctx, turnParkKey("p#t#a#x"), "{not json", time.Minute)
	if c.takeTurn(ctx, "p#t#a#x") != nil {
		t.Fatal("a corrupt hand-off must not start")
	}
	if turnPrefixOf("odd") != "odd" {
		t.Fatal("a key without the thread shape is its own prefix")
	}
}

// failingHook fails the named commands — singly, or any pipeline carrying one
// (the connection handshake is a pipeline too, so pipelines are matched by
// content, never failed wholesale).
type failingHook struct {
	names map[string]bool
}

var errInjectedRedis = errors.New("injected redis fault")

func (h failingHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h failingHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if h.names[cmd.Name()] {
			cmd.SetErr(errInjectedRedis)
			return errInjectedRedis
		}
		return next(ctx, cmd)
	}
}

func (h failingHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, c := range cmds {
			if h.names[c.Name()] {
				for _, c := range cmds {
					c.SetErr(errInjectedRedis)
				}
				return errInjectedRedis
			}
		}
		return next(ctx, cmds)
	}
}

func faultyCoordinator(t *testing.T, h failingHook) (*RedisTurnCoordinator, *redis.Client) {
	t.Helper()
	newTestRedis(t) // flushes the shared container
	rdb := redis.NewClient(&redis.Options{Addr: testRedisAddr})
	t.Cleanup(func() { _ = rdb.Close() })
	rdb.AddHook(h)
	return NewRedisTurnCoordinator(rdb), rdb
}

// Every Redis failure degrades toward an extra turn or a duplicate frame —
// never toward a reply that is silently not written.
func TestRedisTurns_FailuresFailOpen(t *testing.T) {
	ctx := context.Background()
	all := map[string]bool{"set": true, "get": true, "evalsha": true, "eval": true, "getdel": true,
		"smembers": true, "del": true, "publish": true}
	c, _ := faultyCoordinator(t, failingHook{names: all})
	if holder, taken := c.claimTurn(ctx, "k", "r1"); !taken || holder != "r1" {
		t.Fatal("an unreachable slot store lets the turn through")
	}
	if !c.replaceTurn(ctx, "k", "dead", "r1") {
		t.Fatal("an unreachable slot store lets the heal through")
	}
	c.releaseTurn(ctx, "k", "r1") // logged
	if c.turnHolder(ctx, "k") != "" {
		t.Fatal("an unreadable slot reads as free")
	}
	if ok, err := c.parkTurn(ctx, "k", &deferredTurn{msg: &model.Message{}}); ok || err == nil {
		t.Fatal("a park that cannot be written must say so")
	}
	if c.takeTurn(ctx, "k") != nil {
		t.Fatal("an unreadable park yields nothing")
	}
	c.dropTurns(ctx, "p#t#") // logged
	c.wakeOwner(ctx, "u")    // logged
	if !c.typingTurn(ctx, "r1") {
		t.Fatal("an unreachable typing lease lets this instance type")
	}

	// SET NX said "held", then the holder vanished before the read: free.
	c2, rdb2 := faultyCoordinator(t, failingHook{names: map[string]bool{"get": true}})
	rdb2.Set(ctx, turnSlotKey("k2"), "someone", time.Minute)
	if holder, taken := c2.claimTurn(ctx, "k2", "r2"); !taken || holder != "r2" {
		t.Fatalf("claim with an unreadable holder: %q %v", holder, taken)
	}

	// The index write of a park can fail on its own; the park still counts.
	c3, _ := faultyCoordinator(t, failingHook{names: map[string]bool{"sadd": true}})
	if ok, err := c3.parkTurn(ctx, "p#t#a#i", &deferredTurn{msg: &model.Message{}}); !ok || err != nil {
		t.Fatalf("park with a failed index: %v %v", ok, err)
	}

	// Dropping: the index reads, the delete fails.
	c4, rdb4 := faultyCoordinator(t, failingHook{names: map[string]bool{"del": true}})
	rdb4.SAdd(ctx, turnParkIndexKey("p#t#"), "p#t#a#i")
	c4.dropTurns(ctx, "p#t#") // logged

	// A subscription that cannot be opened (the client is gone) leaves claims
	// polling.
	closed := redis.NewClient(&redis.Options{Addr: testRedisAddr})
	_ = closed.Close()
	NewRedisTurnCoordinator(closed).subscribe(ctx, func(string) {})
}

// The wakeup relay ends with its context.
func TestRedisTurns_SubscriptionEndsWithContext(t *testing.T) {
	rdb := newTestRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	woke := make(chan string, 4)
	NewRedisTurnCoordinator(rdb).subscribe(ctx, func(owner string) { woke <- owner })
	NewRedisTurnCoordinator(rdb).wakeOwner(context.Background(), "u-relay")
	select {
	case got := <-woke:
		if got != "u-relay" {
			t.Fatalf("relayed %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the wakeup was not relayed")
	}
	cancel()
	waitFor(t, func() bool {
		n, err := rdb.PubSubNumSub(context.Background(), turnWakeChannel).Result()
		return err == nil && n[turnWakeChannel] == 0
	})
}

// A hand-off that cannot be parked anywhere starts at once instead.
func TestRedisTurns_UnparkableHandOffStartsNow(t *testing.T) {
	x := newOrchCovTwoInstances(t)
	c, _ := faultyCoordinator(t, failingHook{names: map[string]bool{"set": true}})
	x.a.coord = c
	ctx := context.Background()
	x.a.deferTurn(ctx, turnKey("dm1", "u-root", testGGID, "u-alice"), &deferredTurn{
		agentID: testGGID, invokerID: "u-alice", msg: dmReply("u-m1", "u-root", "now"), parentType: service.ParentConversation,
	})
	if ids := x.queued(t); len(ids) != 1 {
		t.Fatalf("the unparkable hand-off must start now (queued %d)", len(ids))
	}
}

// The lease sweep is the authority on lost runners: ANY instance reaps a
// claimed run whose lease lapsed, whoever's timer died with it.
func TestOrchestrator_SweepLeasesReapsLostRunnersAnywhere(t *testing.T) {
	x := newOrchCovTwoInstances(t)
	ctx := context.Background()
	now := time.Now()
	past, fresh := now.Add(-time.Minute), now.Add(time.Minute)
	mk := func(id string, state model.RunState, lease *time.Time) {
		x.runs.runs[id] = &model.Run{ID: id, AgentID: testGGID, InvokerID: "u-alice", OwnerID: "u-alice",
			ParentID: "dm1", ParentType: service.ParentConversation, MessageID: "m-" + id, State: state, LeaseExpiresAt: lease,
			Deadline: now.Add(time.Hour)}
	}
	mk("lost", model.RunStateRunning, &past)
	mk("live", model.RunStateRunning, &fresh)
	mk("queued", model.RunStateQueued, &past)
	mk("unleased", model.RunStateAcknowledged, nil)
	x.b.now = func() time.Time { return now }
	x.b.sweepLeases(ctx)
	for id, want := range map[string]model.RunState{"lost": model.RunStateFailed, "live": model.RunStateRunning,
		"queued": model.RunStateQueued, "unleased": model.RunStateAcknowledged} {
		r, _ := x.runs.GetRun(ctx, id)
		if r.State != want || (id == "lost" && r.FailReason != "runner_lost") {
			t.Fatalf("%s: %s (%s), want %s", id, r.State, r.FailReason, want)
		}
	}
	// A reap whose write fails is logged and retried next tick.
	mk("lost2", model.RunStateRunning, &past)
	x.runs.failUpdateRun = errors.New("store down")
	x.b.sweepLeases(ctx)
	if r, _ := x.runs.GetRun(ctx, "lost2"); r.State != model.RunStateRunning {
		t.Fatalf("a failed reap must leave the run for the next tick: %s", r.State)
	}
	x.runs.failUpdateRun = nil
	x.runs.failListActive = errors.New("active runs down")
	x.b.sweepLeases(ctx) // logged, nothing else
}

// The coordinator's typed keys never collide across concerns.
func TestRedisTurns_KeyLayout(t *testing.T) {
	keys := []string{turnSlotKey("k"), turnParkKey("k"), turnParkIndexKey("k"), turnTypingKey("k")}
	seen := map[string]bool{}
	for _, k := range keys {
		if seen[k] || !strings.HasPrefix(k, "orch:") {
			t.Fatalf("key layout: %v", keys)
		}
		seen[k] = true
	}
	_ = fmt.Sprint(keys)
}
