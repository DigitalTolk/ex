//go:build integration

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

// wsDisconnectEnv wires a full Connect server backed by the shared Redis
// container so tests can dial, then drop the client, exercising Connect's
// connection-write-failure arms (initial ping, replay, event-loop write).
type wsDisconnectEnv struct {
	h     *WSHandler
	ps    *pubsub.RedisPubSub
	srv   *httptest.Server
	token string
	user  string
}

// wsDisconnectSetup tunes the test server: wrapConn wraps every connection
// it accepts, and returned (when set) is closed once Connect returns.
type wsDisconnectSetup struct {
	wrapConn func(net.Conn) net.Conn
	returned chan struct{}
}

type wsDisconnectOption func(*wsDisconnectSetup)

func withServerConns(wrap func(net.Conn) net.Conn) wsDisconnectOption {
	return func(s *wsDisconnectSetup) { s.wrapConn = wrap }
}

func withConnectReturned(returned chan struct{}) wsDisconnectOption {
	return func(s *wsDisconnectSetup) { s.returned = returned }
}

// wrappedListener hands each accepted connection through wrap.
type wrappedListener struct {
	net.Listener
	wrap func(net.Conn) net.Conn
}

func (l wrappedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return l.wrap(c), nil
}

// writeFailConn fails every write once fail is set, as a socket whose peer
// has gone does, without depending on when the kernel notices.
type writeFailConn struct {
	net.Conn
	fail *atomic.Bool
}

func (c writeFailConn) Write(p []byte) (int, error) {
	if c.fail.Load() {
		return 0, errors.New("peer gone")
	}
	return c.Conn.Write(p)
}

// funcReplayer is an InboxReplayer from a function.
type funcReplayer func(ctx context.Context, userID, since string) (eventlog.ReplayResult, error)

func (f funcReplayer) Replay(ctx context.Context, userID, since string) (eventlog.ReplayResult, error) {
	return f(ctx, userID, since)
}

func newWSDisconnectEnv(t *testing.T, rep InboxReplayer, opts ...wsDisconnectOption) *wsDisconnectEnv {
	t.Helper()
	var setup wsDisconnectSetup
	for _, o := range opts {
		o(&setup)
	}
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
	if err != nil {
		t.Fatalf("pubsub: %v", err)
	}
	broker := pubsub.NewBroker(ps)
	t.Cleanup(func() { _ = broker.Close() })
	channels := newDataChannelStore()
	members := newDataMembershipStore()
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	bAdapter := NewBrokerAdapter(broker)
	chanSvc := service.NewChannelService(channels, members, users, nil, nil, bAdapter, nil)
	convSvc := service.NewConversationService(convs, users, nil, bAdapter, nil)
	presenceSvc := service.NewPresenceService(nil, nil)
	h := NewWSHandler(broker, chanSvc, convSvc, presenceSvc)
	if rep != nil {
		h.SetReplayer(rep)
	}
	jwtMgr := auth.NewJWTManager("ws-disc-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-disc", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	connect := http.HandlerFunc(h.Connect)
	if setup.returned != nil {
		connect = func(w http.ResponseWriter, r *http.Request) {
			defer close(setup.returned)
			h.Connect(w, r)
		}
	}
	srv := httptest.NewUnstartedServer(middleware.Auth(jwtMgr)(connect))
	if setup.wrapConn != nil {
		srv.Listener = wrappedListener{Listener: srv.Listener, wrap: setup.wrapConn}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	return &wsDisconnectEnv{h: h, ps: ps, srv: srv, token: token, user: user.ID}
}

func (e *wsDisconnectEnv) dial(t *testing.T, query string) (*websocket.Conn, context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	wsURL := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/" + query
	conn, _, err := dialWS(ctx, wsURL, e.token)
	if err != nil {
		cancel()
		t.Fatalf("dial: %v", err)
	}
	return conn, ctx, cancel
}

// lockedBuffer is a log sink several goroutines may write while a test reads.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestWSHandler_Connect_DropCountWarnsOnOverflow stalls the server's event
// drain (via the wsConnWrite seam) so the per-client buffer (256) fills and the
// broker drops the overflow, which closes the client. On disconnect the cleanup
// observes DropCount > 0 and logs the warning (the DropCount arm).
//
// A second client of the same user tells the test when the stalled one has
// been sent more than it holds: the broker sends each event to every client
// of the user before it takes the next, so once the watcher has an event, the
// stalled client was sent every event before it. No sleeps.
func TestWSHandler_Connect_DropCountWarnsOnOverflow(t *testing.T) {
	logs := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	release := make(chan struct{})
	var releaseOnce sync.Once
	letGo := func() { releaseOnce.Do(func() { close(release) }) }
	var stalled atomic.Bool
	orig := wsConnWrite
	wsConnWrite = func(ctx context.Context, conn *websocket.Conn, data []byte) error {
		// Let the first write through; block every later one so client.Events
		// stops draining and fills up.
		if stalled.CompareAndSwap(false, true) {
			return conn.Write(ctx, websocket.MessageText, data)
		}
		<-release
		return conn.Write(ctx, websocket.MessageText, data)
	}
	t.Cleanup(func() { wsConnWrite = orig })

	returned := make(chan struct{})
	env := newWSDisconnectEnv(t, nil, withConnectReturned(returned))
	// Runs before wsConnWrite is put back (cleanups run last first): Connect
	// must be gone before the seam it reads changes, whether or not the test
	// got that far.
	t.Cleanup(func() {
		letGo()
		select {
		case <-returned:
		case <-time.After(5 * time.Second):
			t.Error("Connect never returned")
		}
	})
	conn, ctx, cancel := env.dial(t, "")
	defer cancel()
	defer func() { _ = conn.CloseNow() }()
	for range 2 {
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("handshake read: %v", err)
		}
	}
	// Registered after Connect's own client, so the per-user socket cap never
	// closes that one in its place.
	watcher := env.h.broker.RegisterClient(env.user)
	t.Cleanup(func() { env.h.broker.UnregisterClient(env.user, watcher) })

	publish := func(n int) {
		t.Helper()
		if err := env.ps.Client().Publish(context.Background(), pubsub.UserChannel(env.user),
			fmt.Sprintf(`{"type":"test","data":{"n":%d}}`, n)).Err(); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	// Connect's subscription to the user's channel reaches Redis on its own
	// time, and Redis drops what nobody hears: publish until the watcher
	// hears one, and every later event reaches both clients.
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	live := time.After(5 * time.Second)
	publish(-1)
	for heard := false; !heard; {
		select {
		case <-watcher.Events:
			heard = true
		case <-tick.C:
			publish(-1)
		case <-live:
			t.Fatal("the user's channel never went live")
		}
	}

	// More than the stalled client holds (one in each of its two writes, 256
	// buffered), in batches the watcher, read as they come, never falls a
	// whole buffer behind on. Every event the watcher hears, the stalled
	// client was sent first.
	const overflow, batch = 300, 50
	for received := 1; received < overflow; {
		for i := range batch {
			publish(received + i)
		}
		for want := received + batch; received < want; received++ {
			select {
			case <-watcher.Events:
			case <-watcher.Done():
				t.Fatal("the watcher fell behind and was closed")
			case <-time.After(5 * time.Second):
				t.Fatal("the events never reached the watcher")
			}
		}
	}

	// The stalled client overflowed and was closed: let its drain go, and
	// Connect ends the connection.
	letGo()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("Connect did not return after its client overflowed")
	}
	if got := logs.String(); !strings.Contains(got, "ws: events dropped") {
		t.Fatalf("no drop warning logged:\n%s", got)
	}
}

// TestWSHandler_Connect_ReplayWriteFailureReturns drives Connect's
// `if !h.runReplay(...) { return }` arm: the socket dies while the replay is
// read, so the replay's first write fails and Connect returns. The failure is
// the server's own connection refusing writes from that moment, not a client
// that closed and a kernel that may or may not have noticed in time (which
// left the arm unrun on a busy CI runner).
func TestWSHandler_Connect_ReplayWriteFailureReturns(t *testing.T) {
	var peerGone atomic.Bool
	payload, _ := json.Marshal(map[string]string{"type": "message.new"})
	rep := funcReplayer(func(context.Context, string, string) (eventlog.ReplayResult, error) {
		peerGone.Store(true)
		return eventlog.ReplayResult{Entries: []eventlog.Entry{{ID: "01ID0000000000000000000002", Payload: payload}}}, nil
	})
	returned := make(chan struct{})
	env := newWSDisconnectEnv(t, rep,
		withServerConns(func(c net.Conn) net.Conn { return writeFailConn{Conn: c, fail: &peerGone} }),
		withConnectReturned(returned))

	conn, _, cancel := env.dial(t, "?since=01ID0000000000000000000001")
	defer cancel()
	defer func() { _ = conn.CloseNow() }()
	// The client stays connected and silent, and the keep-alive ping is 15 s
	// away: only the failed replay write can end the connection.
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("Connect did not return when the replay could not be written")
	}
	if !peerGone.Load() {
		t.Fatal("the replay was never read")
	}
}

// TestWSHandler_Connect_EventLoopWriteFailureReturns drives the main loop's
// `case data := <-client.Events:` write-failure arm: after the handshake the
// client disconnects, then an event is published. The server's attempt to write
// it to the dead socket fails and the loop returns.
func TestWSHandler_Connect_EventLoopWriteFailureReturns(t *testing.T) {
	env := newWSDisconnectEnv(t, nil)
	conn, ctx, cancel := env.dial(t, "")
	for range 2 {
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("handshake read: %v", err)
		}
	}
	_ = conn.CloseNow()
	cancel()
	// Publish repeatedly so at least one event lands on client.Events after the
	// socket is dead, forcing the write-failure return.
	for range 20 {
		_ = env.ps.Client().Publish(context.Background(), pubsub.UserChannel(env.user),
			`{"type":"test","data":{}}`).Err()
		time.Sleep(5 * time.Millisecond)
	}
}
