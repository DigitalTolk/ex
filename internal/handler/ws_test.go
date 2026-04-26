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
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

func TestNewWSHandler(t *testing.T) {
	mr := miniredis.RunT(t)
	ps, err := pubsub.NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("pubsub: %v", err)
	}
	broker := pubsub.NewBroker(ps)
	t.Cleanup(func() { _ = broker.Close() })

	h := NewWSHandler(broker, nil, nil, nil)
	if h == nil {
		t.Fatal("expected non-nil WSHandler")
	}
	if h.broker != broker {
		t.Error("broker not set")
	}
}

func TestWSHandler_Connect_Unauthenticated(t *testing.T) {
	h := &WSHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
	rec := httptest.NewRecorder()

	// No auth context set, should return 401.
	h.Connect(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// TestWSHandler_Connect_FullFlow exercises the full Connect path: auth check,
// broker registration, list-channels/conversations, initial ping write,
// keepalive ping, then graceful disconnect. Also covers writePing.
func TestWSHandler_Connect_FullFlow(t *testing.T) {
	mr := miniredis.RunT(t)
	ps, err := pubsub.NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("pubsub: %v", err)
	}
	broker := pubsub.NewBroker(ps)
	t.Cleanup(func() { _ = broker.Close() })

	channels := newDataChannelStore()
	memberships := newDataMembershipStore()
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	bAdapter := NewBrokerAdapter(broker)
	chanSvc := service.NewChannelService(channels, memberships, users, nil, nil, bAdapter, nil)
	convSvc := service.NewConversationService(convs, users, nil, bAdapter, nil)

	presenceSvc := service.NewPresenceService(nil, nil)
	h := NewWSHandler(broker, chanSvc, convSvc, presenceSvc)
	jwtMgr := auth.NewJWTManager("ws-test-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-ws", Email: "ws@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	// Wrap with auth middleware so Connect sees the user ID.
	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}

	// Read the initial ping.
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	var evt struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &evt); err != nil {
		t.Fatalf("decode initial event: %v (%q)", err, data)
	}
	if evt.Type != "ping" {
		t.Errorf("initial event type = %q, want ping", evt.Type)
	}

	// Publish a message on a Redis channel the user is subscribed to (their
	// personal channel) and confirm it lands on the websocket.
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = ps.Client().Publish(context.Background(), pubsub.UserChannel("u-ws"), `{"type":"test","data":{}}`).Err()
	}()
	for i := 0; i < 5; i++ {
		_, data, err = conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read 2: %v", err)
		}
		_ = json.Unmarshal(data, &evt)
		if evt.Type == "test" {
			break
		}
	}

	_ = conn.Close(websocket.StatusNormalClosure, "")
}
