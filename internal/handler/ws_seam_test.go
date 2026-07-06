//go:build integration

package handler

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

// newSeamConnectServer builds a full Connect server backed by the shared Redis
// container and returns its dial URL plus the broker pubsub (for publishing
// events). The caller is expected to have overridden wsConnWrite to drive
// write failures.
func newSeamConnectServer(t *testing.T) (string, string, *pubsub.RedisPubSub) {
	t.Helper()
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
	jwtMgr := auth.NewJWTManager("ws-seam-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-seam", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/?token=" + token, user.ID, ps
}

// TestWSHandler_Connect_InitialPingWriteFails forces wsConnWrite to fail so the
// initial writePing in Connect (the `if err := writePing(...); err != nil`
// guard before the loop) returns, ending the connection early.
func TestWSHandler_Connect_InitialPingWriteFails(t *testing.T) {
	orig := wsConnWrite
	wsConnWrite = func(context.Context, *websocket.Conn, []byte) error {
		return errors.New("forced write failure")
	}
	t.Cleanup(func() { wsConnWrite = orig })

	wsURL, _, _ := newSeamConnectServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	// Connect must tear the connection down quickly. Reading should hit EOF/close
	// rather than hang — confirming the initial-ping guard returned.
	for range 4 {
		if _, _, err := conn.Read(ctx); err != nil {
			return // connection closed by the server — guard fired
		}
	}
	t.Fatal("connection stayed open despite forced initial-ping write failure")
}

// TestWSHandler_Connect_EventWriteFails lets the handshake (version frame +
// initial ping) succeed, then fails the next write so the event-loop's
// `case data := <-client.Events:` write-error arm returns. A published event
// triggers that write.
func TestWSHandler_Connect_EventWriteFails(t *testing.T) {
	orig := wsConnWrite
	wsConnWrite = func(ctx context.Context, conn *websocket.Conn, data []byte) error {
		// Pings (the pre-loop initial one and keep-alives, ours or a prior
		// test's straggler connection) pass through so the loop is entered;
		// the first non-ping frame is the published event — fail it. Keying
		// on frame type instead of a global write count keeps this immune to
		// stray writes from connections still draining out of earlier tests.
		if bytes.Contains(data, []byte(`"type":"ping"`)) {
			return conn.Write(ctx, websocket.MessageText, data)
		}
		return errors.New("forced event write failure")
	}
	t.Cleanup(func() { wsConnWrite = orig })

	wsURL, userID, ps := newSeamConnectServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	// Publish events to the user's personal channel; the loop's write of one
	// will fail and the handler returns.
	go func() {
		for range 50 {
			_ = ps.Client().Publish(context.Background(), pubsub.UserChannel(userID), `{"type":"test","data":{}}`).Err()
			time.Sleep(5 * time.Millisecond)
		}
	}()
	for range 60 {
		if _, _, err := conn.Read(ctx); err != nil {
			return // server closed after the forced event-write failure
		}
	}
	t.Fatal("connection stayed open despite forced event write failure")
}

// TestWSHandler_Connect_KeepAlivePingWriteFails shrinks the keep-alive interval
// and fails only the ticker-driven ping write, covering the keep-alive ping
// write-error arm (`if err := writePing(...); err != nil` inside the ticker
// case).
func TestWSHandler_Connect_KeepAlivePingWriteFails(t *testing.T) {
	origInterval := wsKeepAliveInterval
	wsKeepAliveInterval = 20 * time.Millisecond
	t.Cleanup(func() { wsKeepAliveInterval = origInterval })

	// Per-connection ping counts: each connection's first ping is the
	// pre-loop initial one (let it through so the loop runs); its second is
	// the first ticker-driven keep-alive — fail that. Scoping by conn keeps
	// a straggler connection from an earlier test (whose last keep-alive can
	// still flow through the swapped seam) from eating the pass-through slot
	// and failing OUR initial ping instead, which would skip the ticker arm.
	var pingsByConn sync.Map
	orig := wsConnWrite
	wsConnWrite = func(ctx context.Context, conn *websocket.Conn, data []byte) error {
		if !bytes.Contains(data, []byte(`"type":"ping"`)) {
			return conn.Write(ctx, websocket.MessageText, data)
		}
		c, _ := pingsByConn.LoadOrStore(conn, &atomic.Int64{})
		if c.(*atomic.Int64).Add(1) <= 1 {
			return conn.Write(ctx, websocket.MessageText, data)
		}
		return errors.New("forced keepalive ping failure")
	}
	t.Cleanup(func() { wsConnWrite = orig })

	wsURL, _, _ := newSeamConnectServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	for range 10 {
		if _, _, err := conn.Read(ctx); err != nil {
			return // server returned after the failed keep-alive ping
		}
	}
	t.Fatal("connection stayed open despite forced keep-alive ping write failure")
}
