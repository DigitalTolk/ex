package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

// InboxReplayer is the subset of the durable event log used by the
// WS handshake replay path.
type InboxReplayer interface {
	Replay(ctx context.Context, userID string, since string) (eventlog.ReplayResult, error)
}

// inboundMessage is the shape of a client → server WebSocket frame. Only
// "typing" is currently understood; anything else is dropped. We keep
// the shape small and JSON-tolerant — unknown fields are ignored so the
// protocol can grow without breaking older clients.
type inboundMessage struct {
	Type            string `json:"type"`
	ParentID        string `json:"parentID"`
	ParentType      string `json:"parentType"`      // "channel" | "conversation"
	ParentMessageID string `json:"parentMessageID"` // optional — set when typing inside a thread reply
	TimeZone        string `json:"timeZone"`        // optional — "timezone.update" heartbeat frame
}

// wsKeepAliveInterval is the cadence of server → client keep-alive pings AND
// presence-TTL refreshes. It is a var (not a const) purely so tests can shrink
// it to drive the keep-alive branch of the connection loop deterministically;
// production never reassigns it.
//
// Kept comfortably below presenceTTL (internal/cache) so a live connection's
// presence never lapses between refreshes, and short enough that a *dead*
// connection is noticed quickly: every tick fires a WebSocket protocol ping
// whose missing pong (peer asleep / network-partitioned / crashed without a
// TCP close) trips the connection's context — clearing presence so the
// mobile-push fallback fires. See NOTIFICATIONS.md / CLAUDE.md: incident
// alerts depend on presence reflecting reality within seconds, not minutes.
var wsKeepAliveInterval = 15 * time.Second

// wsPongTimeout bounds how long we wait for a protocol pong before declaring the
// peer dead. A var for the same test-shrinking reason. The dead-connection
// detection window is at most wsKeepAliveInterval + wsPongTimeout.
var wsPongTimeout = 10 * time.Second

// wsConnWrite is the seam every server → client text write goes through. It is
// a var (not a direct conn.Write call) so a test can force the write-failure
// arms of the connection loop (initial ping, event fan-out, keep-alive ping)
// deterministically — racing a real socket disconnect almost always loses to
// the loop's context-cancellation case instead. Production never reassigns it.
var wsConnWrite = func(ctx context.Context, conn *websocket.Conn, data []byte) error {
	return conn.Write(ctx, websocket.MessageText, data)
}

// WSHandler serves a WebSocket connection for real-time updates.
type WSHandler struct {
	broker         *pubsub.Broker
	chanSvc        *service.ChannelService
	convSvc        *service.ConversationService
	userSvc        *service.UserService
	presenceSvc    *service.PresenceService
	publisher      service.Publisher
	replayer       InboxReplayer
	version        string
	originPatterns []string
	allowAllOrigin bool
}

// NewWSHandler creates a WSHandler.
func NewWSHandler(broker *pubsub.Broker, chanSvc *service.ChannelService, convSvc *service.ConversationService, presenceSvc *service.PresenceService) *WSHandler {
	return &WSHandler{broker: broker, chanSvc: chanSvc, convSvc: convSvc, presenceSvc: presenceSvc}
}

// SetOriginPolicy configures which Origin headers the WebSocket upgrade
// will accept. Patterns are host-only (e.g. "app.example.com",
// "localhost") and use path.Match wildcards (see coder/websocket
// AcceptOptions.OriginPatterns). A single "*" entry disables origin
// verification — used in local dev where the bound port may be hit
// from arbitrary scratch origins. In production this MUST be a
// concrete allowlist; an unset policy fails closed (same-origin only).
func (h *WSHandler) SetOriginPolicy(patterns []string) {
	h.allowAllOrigin = false
	h.originPatterns = nil
	for _, p := range patterns {
		if p == "*" {
			h.allowAllOrigin = true
			h.originPatterns = nil
			return
		}
		if p == "" {
			continue
		}
		h.originPatterns = append(h.originPatterns, p)
	}
}

// SetPublisher wires a publisher for inbound ephemeral events (typing
// indicator). Optional — when nil, inbound typing is dropped.
func (h *WSHandler) SetPublisher(p service.Publisher) { h.publisher = p }

// SetUserService wires the profile service for lightweight client heartbeat
// metadata, currently timezone drift while a user remains logged in.
func (h *WSHandler) SetUserService(s *service.UserService) { h.userSvc = s }

// SetVersion records the running build version so each newly-connected
// client receives a "server.version" frame as part of the handshake. The
// browser uses this to decide if its bundle is outdated — sending it on
// the WS instead of polling /api/v1/version every minute keeps a chatty
// pinger off the HTTP fast path even with many connected users.
func (h *WSHandler) SetVersion(v string) { h.version = v }

// SetReplayer wires the durable inbox so reconnects with a `since`
// cursor can replay events missed during the disconnect. Optional —
// when nil, the handshake skips replay and the client falls back to
// its own refetch logic.
func (h *WSHandler) SetReplayer(r InboxReplayer) { h.replayer = r }

// Connect upgrades the HTTP connection to a WebSocket for the authenticated
// user. Authentication is handled via the "token" query parameter by the auth
// middleware.
func (h *WSHandler) Connect(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Same-origin is always permitted by the library. OriginPatterns
		// adds explicit cross-origin allowlist entries (host-only,
		// path.Match-style). InsecureSkipVerify is only enabled when the
		// operator has opted into dev mode via allowOrigins=["*"]; in
		// production an empty patterns list fails closed to same-origin.
		InsecureSkipVerify: h.allowAllOrigin,
		OriginPatterns:     h.originPatterns,
	})
	if err != nil {
		slog.Error("ws: accept", "error", err, "userID", userID)
		return
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	conn.SetReadLimit(4096)

	client := h.broker.RegisterClient(userID)
	defer func() {
		if dropped := client.DropCount(); dropped > 0 {
			slog.Warn("ws: events dropped", "userID", userID, "dropped", dropped)
		}
		h.broker.UnregisterClient(userID, client)
		if h.presenceSvc != nil {
			// r.Context() is already cancelled by the time the
			// disconnect runs (the upgrade ended). Use a fresh context
			// with a short deadline so a slow Redis can't keep the
			// disconnect goroutine pinned indefinitely — under bulk
			// disconnect (page-close avalanche) this would otherwise
			// leak goroutines until each Redis call timed out itself.
			disconnectCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			h.presenceSvc.OnDisconnect(disconnectCtx, userID)
		}
	}()

	// Subscribe to user's channels and conversations (fetched concurrently).
	var channels []string

	type subResult struct {
		channels []string
		err      error
	}
	chanCh := make(chan subResult, 1)
	convCh := make(chan subResult, 1)

	go func() {
		uc, err := h.chanSvc.ListUserChannels(r.Context(), userID)
		var chs []string
		for _, c := range uc {
			chs = append(chs, pubsub.ChannelName(c.ChannelID))
		}
		chanCh <- subResult{chs, err}
	}()
	go func() {
		uc, err := h.convSvc.ListUserConversations(r.Context(), userID)
		var chs []string
		for _, c := range uc {
			chs = append(chs, pubsub.ConversationName(c.ConversationID))
		}
		convCh <- subResult{chs, err}
	}()

	cr := <-chanCh
	if cr.err != nil {
		slog.Error("ws: list channels", "error", cr.err, "userID", userID)
	} else {
		channels = append(channels, cr.channels...)
	}

	cvr := <-convCh
	if cvr.err != nil {
		slog.Error("ws: list conversations", "error", cvr.err, "userID", userID)
	} else {
		channels = append(channels, cvr.channels...)
	}

	// Subscribe to the user's personal channel for direct notifications
	// (e.g. new conversation created).
	channels = append(channels, pubsub.UserChannel(userID))

	// Subscribe to global broadcast channels (channel events, emoji catalog,
	// online presence) so all connected users receive these updates.
	channels = append(channels,
		pubsub.GlobalChannelEvents(),
		pubsub.GlobalEmojiEvents(),
		pubsub.PresenceEvents(),
		pubsub.UserEvents(),
	)

	if len(channels) > 0 {
		h.broker.Subscribe(userID, channels)
	}

	// Must come after Subscribe so the presence event reaches the
	// user's own browser. PresenceService dedupes by connection count.
	if h.presenceSvc != nil {
		h.presenceSvc.OnConnect(r.Context(), userID)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Always emit a version frame on connect. A missing version (CI
	// build forgot to set ldflags, etc.) defaults to "dev" so the
	// client lands in a deterministic state — outdated stays false
	// when both sides are "dev". Write failure is non-fatal: the
	// keep-alive ping below catches a broken connection.
	version := h.version
	if version == "" {
		version = "dev"
	}
	if evt, err := events.NewEvent(events.EventServerVersion, map[string]string{"version": version}); err == nil {
		if data, err := json.Marshal(evt); err == nil {
			_ = conn.Write(ctx, websocket.MessageText, data)
		}
	}

	// Replay any events missed during a disconnect. The client sends
	// `since=<eventID>` carrying the ULID of the last event it
	// processed. We walk the user's inbox, write each newer entry to
	// the socket in order, and finish with a replay.done frame (or
	// replay.exhausted if the cursor predates retention).
	//
	// Replay runs AFTER Subscribe so live events that publish during
	// the replay are buffered in client.Events for the main loop to
	// drain immediately after; client dedups by event ID.
	if since := r.URL.Query().Get("since"); since != "" && h.replayer != nil {
		if !h.runReplay(ctx, conn, userID, since) {
			return
		}
	}

	// Read loop: parse incoming JSON frames so the typing indicator can
	// fan out via the same pubsub fabric as ordinary events. Unknown
	// frames are silently dropped — the protocol is forward-compatible.
	go func() {
		defer cancel()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			h.handleInbound(ctx, userID, data)
		}
	}()

	ticker := time.NewTicker(wsKeepAliveInterval)
	defer ticker.Stop()

	if err := writePing(ctx, conn); err != nil {
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-client.Done():
			return
		case data := <-client.Events:
			if err := wsConnWrite(ctx, conn, data); err != nil {
				return
			}
		case <-ticker.C:
			if h.presenceSvc != nil {
				h.presenceSvc.Refresh(ctx, userID)
			}
			if err := writePing(ctx, conn); err != nil {
				return
			}
			// Protocol-level liveness probe. writePing above only *writes* an
			// app-level ping frame — on a half-open socket (peer asleep /
			// network-partitioned) that write can sit in the TCP buffer for
			// minutes without erroring, during which the loop keeps refreshing
			// presence and the user looks "online" forever. A real ws Ping waits
			// for the pong (processed by the read loop); no pong within
			// wsPongTimeout means the peer is gone, so we cancel the connection
			// context: the loop returns, the deferred OnDisconnect clears
			// presence, and the offline mobile-push fallback fires. Run in a
			// goroutine so the wait never stalls live event delivery on
			// client.Events. Bounded: at most one in flight (timeout < interval).
			go pingLiveness(ctx, conn, cancel)
		}
	}
}

// pingLiveness sends a WebSocket protocol ping and cancels the connection if no
// pong arrives within wsPongTimeout. This is what makes presence reflect a
// dead socket within seconds so the mobile-push fallback can engage.
func pingLiveness(ctx context.Context, conn *websocket.Conn, cancel context.CancelFunc) {
	pingCtx, pingCancel := context.WithTimeout(ctx, wsPongTimeout)
	defer pingCancel()
	if err := conn.Ping(pingCtx); err != nil {
		// Distinguish a genuine missed pong from the connection simply being
		// torn down concurrently (parent ctx already cancelled) — either way,
		// cancelling is correct and idempotent.
		cancel()
	}
}

func writePing(ctx context.Context, conn *websocket.Conn) error {
	evt, _ := events.NewEvent(events.EventPing, map[string]int64{"ts": time.Now().UnixMilli()})
	data, _ := json.Marshal(evt)
	return wsConnWrite(ctx, conn, data)
}

// runReplay walks the user's durable inbox, emitting each entry newer
// than `since` to the open socket. Returns false if the underlying
// socket write fails (caller should give up on this connection).
//
// On exhausted cursor — the entry corresponding to `since` is no
// longer retained — we still flush whatever entries were collected
// (they're the most recent N) and then send a replay.exhausted frame
// so the client knows the cursor is unreliable and falls back to its
// existing full-refetch path. Sending the partial entries first is
// harmless because the client dedups by event ID anyway, and it
// avoids dropping data we already have on the floor.
func (h *WSHandler) runReplay(ctx context.Context, conn *websocket.Conn, userID, since string) bool {
	res, err := h.replayer.Replay(ctx, userID, since)
	if err != nil {
		slog.Error("ws: replay", "userID", userID, "error", err)
		// Treat any replay failure as exhausted so the client falls
		// back to refetch instead of believing it caught up.
		return writeControlFrame(ctx, conn, events.EventReplayExhausted, map[string]string{"since": since})
	}
	for _, entry := range res.Entries {
		if err := conn.Write(ctx, websocket.MessageText, entry.Payload); err != nil {
			return false
		}
	}
	if res.Exhausted {
		return writeControlFrame(ctx, conn, events.EventReplayExhausted, map[string]string{"since": since})
	}
	return writeControlFrame(ctx, conn, events.EventReplayDone, map[string]int{"count": len(res.Entries)})
}

// writeControlFrame marshals and writes a server → client control
// frame, returning false on socket write failure (signals the caller
// to abandon the connection without bubbling up the specific error).
func writeControlFrame(ctx context.Context, conn *websocket.Conn, eventType string, payload any) bool {
	evt, err := events.NewEvent(eventType, payload)
	if err != nil { // coverage-ignore: callers pass only scalar map payloads (map[string]string / map[string]int); json.Marshal of those cannot fail, so NewEvent never errors here.
		return true
	}
	data, err := json.Marshal(evt)
	if err != nil { // coverage-ignore: evt is an *events.Event of scalar fields plus a pre-validated json.RawMessage; re-marshaling it cannot fail.
		return true
	}
	return conn.Write(ctx, websocket.MessageText, data) == nil
}

// handleInbound dispatches a single client → server frame. Currently
// only the "typing" event is recognised; everything else is ignored.
func (h *WSHandler) handleInbound(ctx context.Context, userID string, raw []byte) {
	var msg inboundMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	switch msg.Type {
	case "typing":
		h.publishTyping(ctx, userID, msg)
	case "timezone.update":
		if h.userSvc != nil {
			_, _ = h.userSvc.PatchTimeZoneIfChanged(ctx, userID, msg.TimeZone)
		}
	}
}

// publishTyping broadcasts a typing event to the parent's pubsub topic
// after verifying the sender is a member. Membership check prevents a
// stranger from spamming a channel they can't read.
func (h *WSHandler) publishTyping(ctx context.Context, userID string, msg inboundMessage) {
	if h.publisher == nil || msg.ParentID == "" {
		return
	}
	var topic string
	switch msg.ParentType {
	case service.ParentChannel:
		if h.chanSvc == nil {
			return
		}
		// CheckAccess silently no-ops if the membership exists; an error
		// means the user isn't allowed in this channel — drop the event.
		if !h.chanSvc.IsMember(ctx, userID, msg.ParentID) {
			return
		}
		topic = pubsub.ChannelName(msg.ParentID)
	case service.ParentConversation:
		if h.convSvc == nil {
			return
		}
		if !h.convSvc.IsParticipant(ctx, userID, msg.ParentID) {
			return
		}
		topic = pubsub.ConversationName(msg.ParentID)
	default:
		return
	}
	payload := map[string]any{
		"userID":     userID,
		"parentID":   msg.ParentID,
		"parentType": msg.ParentType,
	}
	// Only include parentMessageID when it's set so a non-thread typing
	// frame stays exactly the same on the wire as before.
	if msg.ParentMessageID != "" {
		payload["parentMessageID"] = msg.ParentMessageID
	}
	evt, err := events.NewEvent(events.EventTyping, payload)
	if err != nil { // coverage-ignore: payload is a map of string values (plus an optional string parentMessageID); json.Marshal cannot fail, so NewEvent never errors here.
		return
	}
	_ = h.publisher.Publish(ctx, topic, evt)
}
