package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

// withDeadServerConn upgrades one HTTP request to a WebSocket, CLOSES the
// server side, then hands the (now-closed) *websocket.Conn to fn. Every
// conn.Write fn attempts then fails deterministically with "use of closed
// network connection" — this is how the connection-write-failure branches of
// runReplay / writePing are exercised without racing socket buffers or context
// cancellation timing.
func withDeadServerConn(t *testing.T, fn func(ctx context.Context, conn *websocket.Conn)) {
	t.Helper()
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			t.Errorf("accept: %v", err)
			close(done)
			return
		}
		// Closing first guarantees every later Write returns an error.
		_ = conn.Close(websocket.StatusNormalClosure, "")
		fn(context.Background(), conn)
		close(done)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	<-done
}

// TestWSHandler_RunReplay_EntryWriteFails covers runReplay's entry-write error
// branch (return false when conn.Write of a replayed entry fails).
func TestWSHandler_RunReplay_EntryWriteFails(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{"type": "message.new"})
	rep := &stubReplayer{res: eventlog.ReplayResult{
		Entries: []eventlog.Entry{{ID: "01ID0000000000000000000010", Payload: payload}},
	}}
	h := &WSHandler{}
	h.SetReplayer(rep)
	withDeadServerConn(t, func(ctx context.Context, conn *websocket.Conn) {
		if ok := h.runReplay(ctx, conn, "u-x", "01ID0000000000000000000001"); ok {
			t.Error("runReplay should return false when an entry write fails")
		}
	})
}

// TestWSHandler_RunReplay_ControlFrameWriteFails covers the replay.done /
// replay.exhausted control-frame write-failure path: with no entries, runReplay
// goes straight to writeControlFrame, whose conn.Write fails on the dead peer.
func TestWSHandler_RunReplay_ControlFrameWriteFails(t *testing.T) {
	rep := &stubReplayer{res: eventlog.ReplayResult{}}
	h := &WSHandler{}
	h.SetReplayer(rep)
	withDeadServerConn(t, func(ctx context.Context, conn *websocket.Conn) {
		if ok := h.runReplay(ctx, conn, "u-x", "01ID0000000000000000000001"); ok {
			t.Error("runReplay should return false when the control frame write fails")
		}
	})
}

// TestWritePing_WriteFails covers writePing returning an error when the
// underlying connection write fails.
func TestWritePing_WriteFails(t *testing.T) {
	withDeadServerConn(t, func(ctx context.Context, conn *websocket.Conn) {
		if err := writePing(ctx, conn); err == nil {
			t.Error("writePing should error on a dead connection")
		}
	})
}

// TestPingLiveness_CancelsOnDeadPeer covers the liveness probe: when the
// WebSocket protocol Ping fails (the peer is gone — no pong, or the socket is
// dead), pingLiveness MUST cancel the connection context. That is what makes the
// keep-alive loop return, run the deferred OnDisconnect to clear presence, and
// let the offline mobile-push fallback engage. Without this, a half-open desktop
// socket keeps the user "online" and silently swallows incident alerts.
func TestPingLiveness_CancelsOnDeadPeer(t *testing.T) {
	withDeadServerConn(t, func(ctx context.Context, conn *websocket.Conn) {
		cancelled := false
		pingLiveness(ctx, conn, func() { cancelled = true })
		if !cancelled {
			t.Error("pingLiveness must cancel the connection when the ping fails on a dead peer")
		}
	})
}

// --- Integration: keep-alive ticker branch + initial-ping success ----------

// TestWSHandler_Connect_KeepAliveTickerFires shrinks the keep-alive interval so
// the ticker branch (presence refresh + ping) executes within the test window.
func TestWSHandler_Connect_KeepAliveTickerFires(t *testing.T) {
	orig := wsKeepAliveInterval
	wsKeepAliveInterval = 20 * time.Millisecond
	t.Cleanup(func() { wsKeepAliveInterval = orig })

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

	jwtMgr := auth.NewJWTManager("ws-ticker-secret", 15*time.Minute, 720*time.Hour)
	u := &model.User{ID: "u-tick", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, u)
	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/?token="+token, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Read several frames; with a 20ms ticker we must observe at least two ping
	// frames (the initial one plus at least one ticker-driven one), proving the
	// ticker branch ran.
	pings := 0
	for range 8 {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &frame)
		if frame.Type == "ping" {
			pings++
			if pings >= 2 {
				return
			}
		}
	}
	t.Fatalf("expected >=2 ping frames from the keep-alive ticker, saw %d", pings)
}
