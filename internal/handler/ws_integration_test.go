//go:build integration

package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/coder/websocket"
)

// WSHandler tests that need a live broker — and therefore the shared Redis
// container started in TestMain (adapters_integration_test.go). The
// Redis-free WSHandler tests stay untagged in ws_test.go.

func TestNewWSHandler(t *testing.T) {
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
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

// dialWS opens a test WebSocket authenticated via the Authorization header —
// the query-token fallback is gone (it leaked JWTs into URL logs), so tests
// authenticate the way non-browser clients do. Browser-style ticket auth has
// its own dedicated tests.
func dialWS(ctx context.Context, wsURL, token string) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
}

// TestWSHandler_Connect_FullFlow exercises the full Connect path: auth check,
// broker registration, list-channels/conversations, initial ping write,
// keepalive ping, then graceful disconnect. Also covers writePing.
func TestWSHandler_Connect_FullFlow(t *testing.T) {
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
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

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := dialWS(ctx, wsURL, token)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}

	// First two frames are the version handshake then the keep-alive
	// ping. Read both before moving on to assert message delivery.
	var evt struct {
		Type string `json:"type"`
	}
	for range 2 {
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
	for range 5 {
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
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
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

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := dialWS(ctx, wsURL, token)
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
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
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

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := dialWS(ctx, wsURL, token)
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
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatalf("build upgrade request: %v", err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	req.Header.Set("Authorization", "Bearer "+token)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

func newWSHandlerForOriginTest(t *testing.T) (*WSHandler, *auth.JWTManager, string) {
	t.Helper()
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
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

// Helper that builds a WSHandler + test server wired to a stub
// replayer, returning the dial URL with `since` already encoded.
func newReplayHarness(t *testing.T, rep *stubReplayer) (string, *auth.JWTManager, string, func()) {
	t.Helper()
	ps, err := pubsub.NewRedisPubSub("redis://" + redisAddrForTest(t))
	if err != nil {
		t.Fatalf("pubsub: %v", err)
	}
	broker := pubsub.NewBroker(ps)
	channels := newDataChannelStore()
	memberships := newDataMembershipStore()
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	bAdapter := NewBrokerAdapter(broker)
	chanSvc := service.NewChannelService(channels, memberships, users, nil, nil, bAdapter, nil)
	convSvc := service.NewConversationService(convs, users, nil, bAdapter, nil)
	presenceSvc := service.NewPresenceService(nil, nil)
	h := NewWSHandler(broker, chanSvc, convSvc, presenceSvc)
	if rep != nil {
		h.SetReplayer(rep)
	}
	jwtMgr := auth.NewJWTManager("ws-replay-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u-rep", Email: "r@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	cleanup := func() {
		srv.Close()
		_ = broker.Close()
	}
	return srv.URL, jwtMgr, token, cleanup
}

// drainUntil reads frames until one matches `match` or `max` frames
// have been read. Returns the matched frame (with raw decoded) or
// fails the test.
func drainUntil(t *testing.T, conn *websocket.Conn, ctx context.Context, match func(typ string) bool, max int) map[string]any {
	t.Helper()
	for range max {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame map[string]any
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatalf("decode frame: %v (%q)", err, data)
		}
		typ, _ := frame["type"].(string)
		if match(typ) {
			return frame
		}
	}
	t.Fatalf("did not see matching frame within %d reads", max)
	return nil
}

// When the client sends `since` and the durable inbox has missed
// events, the server flushes each entry to the socket in order and
// closes with a replay.done frame so the client knows it's caught up.
func TestWSHandler_Connect_ReplaysMissedEvents(t *testing.T) {
	missedA, _ := json.Marshal(map[string]any{"id": "01ID0000000000000000000010", "type": "message.new", "data": map[string]string{"text": "first"}})
	missedB, _ := json.Marshal(map[string]any{"id": "01ID0000000000000000000020", "type": "message.edited", "data": map[string]string{"text": "second"}})
	rep := &stubReplayer{res: eventlog.ReplayResult{
		Entries: []eventlog.Entry{
			{ID: "01ID0000000000000000000010", Payload: missedA},
			{ID: "01ID0000000000000000000020", Payload: missedB},
		},
	}}
	base, _, token, cleanup := newReplayHarness(t, rep)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http") + "/?since=01ID0000000000000000000005"
	conn, _, err := dialWS(ctx, wsURL, token)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// server.version → entry A → entry B → replay.done
	// Other frames (ping) may interleave; pull until we hit replay.done.
	seen := []string{}
	for range 8 {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &frame)
		seen = append(seen, frame.Type)
		if frame.Type == "replay.done" {
			break
		}
	}
	// Both missed events must appear, in order, before replay.done.
	idxA, idxB, idxDone := -1, -1, -1
	for i, s := range seen {
		switch s {
		case "message.new":
			idxA = i
		case "message.edited":
			idxB = i
		case "replay.done":
			idxDone = i
		}
	}
	if idxA < 0 || idxB < 0 || idxDone < 0 {
		t.Fatalf("missed frames or no replay.done; saw %v", seen)
	}
	if idxA >= idxB || idxB >= idxDone {
		t.Errorf("expected message.new < message.edited < replay.done; got A=%d B=%d done=%d (frames=%v)", idxA, idxB, idxDone, seen)
	}
	if rep.gotSince != "01ID0000000000000000000005" {
		t.Errorf("replayer saw since=%q, want 01ID0000000000000000000005", rep.gotSince)
	}
	if rep.gotUser != "u-rep" {
		t.Errorf("replayer saw userID=%q, want u-rep", rep.gotUser)
	}
}

// Exhausted cursor — the client's `since` predates the inbox's
// retention window. Server emits replay.exhausted so the client
// can fall back to its existing refetch path.
func TestWSHandler_Connect_ReplayExhaustedFrame(t *testing.T) {
	rep := &stubReplayer{res: eventlog.ReplayResult{Exhausted: true}}
	base, _, token, cleanup := newReplayHarness(t, rep)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http") + "/?since=00OLD000000000000000000000"
	conn, _, err := dialWS(ctx, wsURL, token)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	frame := drainUntil(t, conn, ctx, func(typ string) bool {
		return typ == "replay.exhausted" || typ == "replay.done"
	}, 6)
	if frame["type"] != "replay.exhausted" {
		t.Errorf("frame type = %v, want replay.exhausted", frame["type"])
	}
}

// Replayer errors fall back to replay.exhausted — the client must
// refetch rather than believe an empty replay is complete.
func TestWSHandler_Connect_ReplayErrorBecomesExhausted(t *testing.T) {
	rep := &stubReplayer{err: errors.New("redis down")}
	base, _, token, cleanup := newReplayHarness(t, rep)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http") + "/?since=01ID0000000000000000000005"
	conn, _, err := dialWS(ctx, wsURL, token)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	frame := drainUntil(t, conn, ctx, func(typ string) bool {
		return typ == "replay.exhausted" || typ == "replay.done"
	}, 6)
	if frame["type"] != "replay.exhausted" {
		t.Errorf("frame type = %v, want replay.exhausted", frame["type"])
	}
}

// No `since` → no replay attempted, no replay frame emitted. This is
// the first-connect path; clients with no cursor just start tracking
// from the live stream.
func TestWSHandler_Connect_NoSinceSkipsReplay(t *testing.T) {
	rep := &stubReplayer{}
	base, _, token, cleanup := newReplayHarness(t, rep)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http") + "/" // no since
	conn, _, err := dialWS(ctx, wsURL, token)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Read the two startup frames (server.version, ping); neither
	// should be a replay.* frame — replay must not run without a
	// `since` cursor in the request.
	for range 2 {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &frame)
		if strings.HasPrefix(frame.Type, "replay.") {
			t.Errorf("got replay frame without since: %s", frame.Type)
		}
	}
	if rep.gotUser != "" {
		t.Errorf("replayer should not have been called, got userID=%q", rep.gotUser)
	}
}

// Even with a `since` param, if no replayer is wired (dev / pre-rollout
// stage) the handler must skip replay rather than crash — the feature
// is purely additive and must be safe to leave disabled.
func TestWSHandler_Connect_SinceWithoutReplayerIsNoop(t *testing.T) {
	base, _, token, cleanup := newReplayHarness(t, nil) // no SetReplayer
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http") + "/?since=01ID0000000000000000000005"
	conn, _, err := dialWS(ctx, wsURL, token)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	for range 2 {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &frame)
		if strings.HasPrefix(frame.Type, "replay.") {
			t.Errorf("got replay frame without replayer wired: %s", frame.Type)
		}
	}
}

// --- Keep-alive ticker branch + initial-ping success -----------------------

// TestWSHandler_Connect_KeepAliveTickerFires shrinks the keep-alive interval so
// the ticker branch (presence refresh + ping) executes within the test window.
func TestWSHandler_Connect_KeepAliveTickerFires(t *testing.T) {
	orig := wsKeepAliveInterval
	wsKeepAliveInterval = 20 * time.Millisecond
	t.Cleanup(func() { wsKeepAliveInterval = orig })

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

	jwtMgr := auth.NewJWTManager("ws-ticker-secret", 15*time.Minute, 720*time.Hour)
	u := &model.User{ID: "u-tick", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, u)
	srv := httptest.NewServer(middleware.Auth(jwtMgr)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := dialWS(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/", token)
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

// The socket's lifetime is capped at the auth context's expiry (+grace): a
// connection whose session deadline passes is force-closed by the server, so
// a deactivated/revoked session cannot hold a live socket past its token —
// even when the ephemeral force-logout event is lost. The client reconnects
// with a freshly-authenticated ticket, re-validating the session.
func TestWSHandler_Connect_SessionDeadlineClosesSocket(t *testing.T) {
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

	tickets := newFakeTicketStore()
	h.SetTicketStore(tickets)
	// Zero grace so the deadline below is the exact close time.
	origGrace := wsSessionGrace
	wsSessionGrace = 0
	t.Cleanup(func() { wsSessionGrace = origGrace })
	// The ticket carries a nearly-expired session: the socket must be closed
	// by the server shortly after connecting.
	if err := tickets.MintWSTicket(context.Background(), "tick-short", "u-exp", time.Now().Add(400*time.Millisecond)); err != nil {
		t.Fatalf("mint: %v", err)
	}

	headerAuth := func(next http.Handler) http.Handler { return next } // unused: ticket path
	srv := httptest.NewServer(h.UpgradeAuth(headerAuth)(http.HandlerFunc(h.Connect)))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/?ticket=tick-short", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Drain frames until the server closes the connection. The session
	// deadline is 400ms out; requiring the close within 5s distinguishes a
	// genuine server-side close from this test's own 10s ctx timing out (a
	// ctx timeout would also error the read — but only at 10s).
	start := time.Now()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			if elapsed := time.Since(start); elapsed > 5*time.Second {
				t.Fatalf("read errored only after %v — that is the test ctx, not the server enforcing the session deadline", elapsed)
			}
			return // server closed the session — contract holds
		}
		if time.Since(start) > 8*time.Second {
			t.Fatal("socket outlived its session deadline — expired auth must close the connection")
		}
	}
}
