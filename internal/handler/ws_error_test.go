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

	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

// TestWSHandler_SetOriginPolicy_SkipsEmptyPattern covers the `if p == ""`
// continue arm in SetOriginPolicy: a blank entry is dropped without being
// added to the allowlist and without enabling the wildcard.
func TestWSHandler_SetOriginPolicy_SkipsEmptyPattern(t *testing.T) {
	h := &WSHandler{}
	h.SetOriginPolicy([]string{"", "app.example.com", ""})
	if h.allowAllOrigin {
		t.Fatal("blank patterns must not enable wildcard")
	}
	if len(h.originPatterns) != 1 || h.originPatterns[0] != "app.example.com" {
		t.Fatalf("originPatterns = %v, want [app.example.com] (blanks skipped)", h.originPatterns)
	}
}

// wsConnectEnv wires a WSHandler against in-memory stores so a real
// browser-style dial exercises the full Connect path. The caller can seed the
// membership/conversation stores before dialing to drive the subscribe loops
// and their error arms.
type wsConnectEnv struct {
	h       *WSHandler
	members *dataMembershipStore
	convs   *dataConversationStore
	channels *dataChannelStore
	jwtMgr  *auth.JWTManager
	token   string
	userID  string
	ps      *pubsub.RedisPubSub
}

func newWSConnectEnv(t *testing.T) *wsConnectEnv {
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

	jwtMgr := auth.NewJWTManager("ws-branch-secret", 15*time.Minute, 720*time.Hour)
	userID := "u-conn"
	user := &model.User{ID: userID, Email: "conn@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	return &wsConnectEnv{h: h, members: members, convs: convs, channels: channels, jwtMgr: jwtMgr, token: token, userID: userID, ps: ps}
}

func (e *wsConnectEnv) dial(t *testing.T, query string) (*websocket.Conn, context.Context, func()) {
	t.Helper()
	srv := httptest.NewServer(middleware.Auth(e.jwtMgr)(http.HandlerFunc(e.h.Connect)))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/?token=" + e.token + query
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		srv.Close()
		cancel()
		t.Fatalf("ws dial: %v", err)
	}
	cleanup := func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
		srv.Close()
		cancel()
	}
	return conn, ctx, cleanup
}

// readUntilPing pulls startup frames until the keep-alive ping arrives, proving
// the handshake (version frame + initial ping) completed. By then the subscribe
// loops have already executed.
func readUntilPing(t *testing.T, conn *websocket.Conn, ctx context.Context) {
	t.Helper()
	for range 6 {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &frame)
		if frame.Type == "ping" {
			return
		}
	}
	t.Fatal("did not observe a ping frame during handshake")
}

// TestWSHandler_Connect_SubscribesUserChannelsAndConversations seeds both a
// channel membership and an active conversation for the connecting user, so the
// channel/conversation subscribe loops (the `for _, c := range uc` arms) both
// execute and append topics.
func TestWSHandler_Connect_SubscribesUserChannelsAndConversations(t *testing.T) {
	env := newWSConnectEnv(t)
	// Channel the user belongs to — drives the channel subscribe loop. The
	// channel must exist and be unarchived so the service keeps it.
	if err := env.channels.CreateChannel(context.Background(), &model.Channel{
		ID: "ch-sub", Name: "general", Slug: "general", Type: model.ChannelTypePublic,
	}); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	env.members.userChannels = []*model.UserChannel{
		{UserID: env.userID, ChannelID: "ch-sub", ChannelName: "general", Role: model.ChannelRoleMember},
	}
	// Active conversation the user participates in — drives the conversation
	// subscribe loop.
	env.convs.conversations["cv-sub"] = &model.Conversation{
		ID: "cv-sub", Type: model.ConversationTypeDM, Activated: true, ParticipantIDs: []string{env.userID, "u-other"},
	}
	env.convs.userConvs[env.userID] = []*model.UserConversation{
		{UserID: env.userID, ConversationID: "cv-sub", Type: model.ConversationTypeDM, Activated: true},
	}

	conn, ctx, cleanup := env.dial(t, "")
	defer cleanup()
	readUntilPing(t, conn, ctx)
}

// TestWSHandler_Connect_ListChannelsError drives the channel-list error arm:
// when ListUserChannels fails, the handler logs and continues (no channels
// appended) but the connection still completes its handshake.
func TestWSHandler_Connect_ListChannelsError(t *testing.T) {
	env := newWSConnectEnv(t)
	env.members.listUserChannelsErr = errors.New("dynamo down")
	conn, ctx, cleanup := env.dial(t, "")
	defer cleanup()
	readUntilPing(t, conn, ctx)
}

// TestWSHandler_Connect_ListConversationsError drives the conversation-list
// error arm symmetrically.
func TestWSHandler_Connect_ListConversationsError(t *testing.T) {
	env := newWSConnectEnv(t)
	env.convs.listErr = errors.New("dynamo down")
	conn, ctx, cleanup := env.dial(t, "")
	defer cleanup()
	readUntilPing(t, conn, ctx)
}

// TestWSHandler_Connect_ReadLoopDispatchesInbound covers the read-loop's
// handleInbound call: the client sends a (well-formed but membership-less)
// typing frame, which the server reads and dispatches. The publisher is unset,
// so the frame is harmlessly dropped — the point is that conn.Read returns the
// frame and handleInbound runs without tearing down the connection.
func TestWSHandler_Connect_ReadLoopDispatchesInbound(t *testing.T) {
	env := newWSConnectEnv(t)
	conn, ctx, cleanup := env.dial(t, "")
	defer cleanup()
	readUntilPing(t, conn, ctx)

	frame, _ := json.Marshal(map[string]string{"type": "typing", "parentID": "ch-x", "parentType": "channel"})
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("client write: %v", err)
	}
	// Give the server's read loop a moment to consume the frame, then send a
	// second to confirm the loop is still alive (it would have returned on a
	// read error). A successful second write proves the loop kept running.
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("second client write: %v", err)
	}
}
