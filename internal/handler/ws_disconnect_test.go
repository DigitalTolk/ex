package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

// wsDisconnectEnv wires a full Connect server backed by miniredis so tests can
// dial, then drop the client, exercising Connect's connection-write-failure
// arms (initial ping, replay, event-loop write).
type wsDisconnectEnv struct {
	h     *WSHandler
	ps    *pubsub.RedisPubSub
	srv   *httptest.Server
	token string
	user  string
}

func newWSDisconnectEnv(t *testing.T, rep InboxReplayer) *wsDisconnectEnv {
	t.Helper()
	mr := miniredis.RunT(t)
	ps, err := pubsub.NewRedisPubSub("redis://" + mr.Addr())
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
	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	t.Cleanup(srv.Close)
	return &wsDisconnectEnv{h: h, ps: ps, srv: srv, token: token, user: user.ID}
}

func (e *wsDisconnectEnv) dial(t *testing.T, query string) (*websocket.Conn, context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	wsURL := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/?token=" + e.token + query
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		cancel()
		t.Fatalf("dial: %v", err)
	}
	return conn, ctx, cancel
}

// TestWSHandler_Connect_DropCountWarnsOnOverflow stalls the server's event
// drain (via the wsConnWrite seam) so the per-client buffer (256) fills and the
// broker drops the overflow. On disconnect the cleanup observes DropCount > 0
// and logs the warning (the DropCount arm). Stalling the drain — rather than
// relying on the client not reading — makes the overflow deterministic.
func TestWSHandler_Connect_DropCountWarnsOnOverflow(t *testing.T) {
	release := make(chan struct{})
	var stalled atomic.Bool
	orig := wsConnWrite
	wsConnWrite = func(ctx context.Context, conn *websocket.Conn, data []byte) error {
		// Let the initial ping through; block every later write so client.Events
		// stops draining and fills up.
		if stalled.CompareAndSwap(false, true) {
			return conn.Write(ctx, websocket.MessageText, data)
		}
		<-release
		return conn.Write(ctx, websocket.MessageText, data)
	}
	t.Cleanup(func() { wsConnWrite = orig })

	env := newWSDisconnectEnv(t, nil)
	conn, ctx, cancel := env.dial(t, "")
	// Drain the handshake frames the client cares about; the server's own write
	// loop is what we've stalled.
	for range 2 {
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("handshake read: %v", err)
		}
	}
	// Publish far more than the 256-event buffer; with the drain stalled the
	// non-blocking client.Send drops the overflow and bumps DropCount.
	for i := range 1000 {
		_ = env.ps.Client().Publish(context.Background(), pubsub.UserChannel(env.user),
			fmt.Sprintf(`{"type":"test","data":{"n":%d}}`, i)).Err()
	}
	time.Sleep(200 * time.Millisecond)
	_ = conn.CloseNow()
	cancel()
	close(release) // unblock any in-flight write so the goroutine can exit
	// Allow the server-side disconnect goroutine to run its DropCount check.
	time.Sleep(150 * time.Millisecond)
}

// TestWSHandler_Connect_ReplayWriteFailureReturns drives Connect's
// `if !h.runReplay(...) { return }` arm: the replayer yields many large entries
// while the client closes immediately after dialing, so the replay write to the
// socket fails and Connect returns early.
func TestWSHandler_Connect_ReplayWriteFailureReturns(t *testing.T) {
	big := strings.Repeat("x", 8192)
	entries := make([]eventlog.Entry, 0, 64)
	for i := range 64 {
		payload, _ := json.Marshal(map[string]string{"type": "message.new", "body": big})
		entries = append(entries, eventlog.Entry{ID: fmt.Sprintf("01ID%022d", i+1), Payload: payload})
	}
	rep := &stubReplayer{res: eventlog.ReplayResult{Entries: entries}}
	env := newWSDisconnectEnv(t, rep)

	conn, _, cancel := env.dial(t, "&since=01ID0000000000000000000001")
	// Drop the client immediately so the server's replay writes fail partway
	// through, forcing runReplay to return false and Connect to bail.
	_ = conn.CloseNow()
	cancel()
	// Connect runs server-side; give it time to attempt the replay writes and
	// return. No assertion beyond "no panic / no hang" — coverage records the
	// early-return arm.
	time.Sleep(150 * time.Millisecond)
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
