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

	// First two frames are the version handshake then the keep-alive
	// ping. Read both before moving on to assert message delivery.
	var evt struct {
		Type string `json:"type"`
	}
	for i := 0; i < 2; i++ {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		if err := json.Unmarshal(data, &evt); err != nil {
			t.Fatalf("decode initial event: %v (%q)", err, data)
		}
	}
	if evt.Type != "ping" {
		t.Errorf("second event type = %q, want ping", evt.Type)
	}

	// Publish a message on a Redis channel the user is subscribed to (their
	// personal channel) and confirm it lands on the websocket.
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = ps.Client().Publish(context.Background(), pubsub.UserChannel("u-ws"), `{"type":"test","data":{}}`).Err()
	}()
	for i := 0; i < 5; i++ {
		_, data, err := conn.Read(ctx)
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

// Connecting clients should receive a "server.version" frame on connect
// when SetVersion has been called — that's how the frontend learns the
// running build without polling /api/v1/version once a minute per user.
func TestWSHandler_Connect_SendsServerVersionOnHandshake(t *testing.T) {
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
	h.SetVersion("v1.2.3")

	jwtMgr := auth.NewJWTManager("ws-version-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-vws", Email: "v@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// First frame must be the server.version handshake — read with a
	// short loop in case ping ordering ever changes; but the version
	// frame is always written before the read loop starts, so it should
	// arrive first deterministically.
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	var evt struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &evt); err != nil {
		t.Fatalf("decode: %v (%q)", err, data)
	}
	if evt.Type != "server.version" {
		t.Fatalf("first event type = %q, want server.version (data=%q)", evt.Type, data)
	}
	var payload struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(evt.Data, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Version != "v1.2.3" {
		t.Errorf("version = %q, want v1.2.3", payload.Version)
	}
}

// When SetVersion is not called the handler still sends a version frame
// — defaulted to "dev" — so the frontend lands in a deterministic state
// regardless of whether ldflags wired the build identifier through. The
// frontend's outdated check stays false when both sides are "dev".
func TestWSHandler_Connect_DefaultsServerVersionToDevWhenUnset(t *testing.T) {
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
	h := NewWSHandler(broker, chanSvc, convSvc, presenceSvc) // no SetVersion call

	jwtMgr := auth.NewJWTManager("ws-noversion-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-nv", Email: "nv@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)

	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	var evt struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &evt); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if evt.Type != "server.version" {
		t.Fatalf("first event type = %q, want server.version", evt.Type)
	}
	var payload struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(evt.Data, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Version != "dev" {
		t.Errorf("default version = %q, want dev", payload.Version)
	}
}

// origin-policy tests — verify the WebSocket upgrade rejects requests
// whose Origin header isn't in the allowlist, while preserving same-
// origin and explicit-allowlist matches. Uses raw HTTP upgrade
// requests (not websocket.Dial) so the Origin header can be controlled.
func newOriginUpgradeRequest(t *testing.T, target, origin, token string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, target+"?token="+token, nil)
	if err != nil {
		t.Fatalf("build upgrade request: %v", err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

func newWSHandlerForOriginTest(t *testing.T) (*WSHandler, *auth.JWTManager, string) {
	t.Helper()
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

	jwtMgr := auth.NewJWTManager("ws-origin-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-org", Email: "o@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	return h, jwtMgr, token
}

// Cross-origin upgrades must fail closed when SetOriginPolicy is
// configured with a concrete allowlist. This is the core regression
// test for the prior `InsecureSkipVerify: true` default that allowed
// any attacker-controlled origin to open an authenticated WS.
func TestWSHandler_Connect_RejectsCrossOriginNotInAllowlist(t *testing.T) {
	h, jwtMgr, token := newWSHandlerForOriginTest(t)
	h.SetOriginPolicy([]string{"app.example.com"})

	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	req := newOriginUpgradeRequest(t, srv.URL+"/api/v1/ws", "https://attacker.example.com", token)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("upgrade request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (origin rejected)", res.StatusCode)
	}
}

// An Origin host that matches the allowlist must be upgraded
// successfully — verifies the policy isn't a global block.
func TestWSHandler_Connect_AcceptsAllowlistedOrigin(t *testing.T) {
	h, jwtMgr, token := newWSHandlerForOriginTest(t)
	h.SetOriginPolicy([]string{"app.example.com"})

	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	req := newOriginUpgradeRequest(t, srv.URL+"/api/v1/ws", "https://app.example.com", token)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("upgrade request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101 (upgraded)", res.StatusCode)
	}
}

// "*" preserves the prior dev-mode behaviour: any origin is accepted.
// Production deployments must NOT pass "*" — that is enforced via the
// CORS allow-list mirroring in main.go (a non-dev config emits a
// concrete list).
func TestWSHandler_SetOriginPolicy_WildcardAllowsAnyOrigin(t *testing.T) {
	h, jwtMgr, token := newWSHandlerForOriginTest(t)
	h.SetOriginPolicy([]string{"*"})

	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	req := newOriginUpgradeRequest(t, srv.URL+"/api/v1/ws", "https://anywhere.test", token)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("upgrade request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101 (wildcard allows)", res.StatusCode)
	}
}

// Without a policy set, the handler must fail closed to same-origin —
// the request below has no Origin header and no policy, so the
// library's default (same-origin) applies and the upgrade succeeds
// because httptest.NewServer puts the request on the same origin.
// The cross-origin attacker case (no Origin policy + foreign Origin)
// is the production-concern check.
func TestWSHandler_Connect_DefaultPolicyRejectsForeignOrigin(t *testing.T) {
	h, jwtMgr, token := newWSHandlerForOriginTest(t)
	// no SetOriginPolicy → empty patterns, no wildcard

	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	req := newOriginUpgradeRequest(t, srv.URL+"/api/v1/ws", "https://attacker.example.com", token)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("upgrade request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (default policy rejects foreign origin)", res.StatusCode)
	}
}
