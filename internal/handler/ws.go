package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
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
	MessageID       string `json:"messageID"`       // optional — set on a "notification.ack" frame
}

// typingGate caches per-connection membership verdicts for typing frames.
// Typing is the chattiest inbound event (keystroke bursts) and each frame
// paid a DynamoDB membership read; a verdict is stable enough to reuse for
// typingMembershipTTL. Entries expire so a member removed mid-connection
// stops broadcasting within seconds, and a freshly added member starts
// within the same window. Owned by the connection's single read goroutine —
// no locking.
type typingGate struct {
	verdicts map[string]typingVerdict
	// lastTyping throttles inbound typing frames per connection: each frame
	// fans out a Redis PUBLISH to every subscriber, and the read loop would
	// otherwise relay them as fast as a client can send — an amplification
	// lever. One frame per typingMinInterval is plenty for a UI indicator.
	lastTyping time.Time
}

// typingMinInterval is the per-connection floor between relayed typing
// frames. A var so tests can exercise the throttle without sleeping.
var typingMinInterval = 300 * time.Millisecond

type typingVerdict struct {
	member  bool
	expires time.Time
}

// typingMembershipTTL bounds verdict staleness. A var so tests can shrink it.
var typingMembershipTTL = 30 * time.Second

func newTypingGate() *typingGate {
	return &typingGate{verdicts: make(map[string]typingVerdict)}
}

// check returns the cached verdict for key, or computes and caches one.
func (g *typingGate) check(key string, lookup func() bool) bool {
	if v, ok := g.verdicts[key]; ok && time.Now().Before(v.expires) {
		return v.member
	}
	member := lookup()
	g.verdicts[key] = typingVerdict{member: member, expires: time.Now().Add(typingMembershipTTL)}
	return member
}

// NotificationAckRecorder records a client's acknowledgement that it received
// (and surfaced) the desktop notification for a message. The deferred
// mobile-push fallback reads these to avoid double-notifying a desktop that
// actually delivered. Implemented by the Redis cache.
type NotificationAckRecorder interface {
	MarkNotificationAcked(ctx context.Context, userID, messageID string) error
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
	notifAck       NotificationAckRecorder
	version        string
	originPatterns []string
	allowAllOrigin bool
	tickets        WSTicketStore

	// drain tracks in-flight Connect handlers so a graceful shutdown can wait
	// for their teardown (presence cleanup + offline publish) to finish. The
	// HTTP server's Shutdown does not track hijacked connections, so without
	// this every deploy left presence markers to lapse by TTL and offline
	// transitions unpublished.
	drain sync.WaitGroup
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

// SetNotificationAckRecorder wires the store that records desktop-delivery acks
// (a `notification.ack` inbound frame). Optional — without it, acks are ignored
// and the deferred mobile-push fallback degrades to presence-only behaviour.
func (h *WSHandler) SetNotificationAckRecorder(r NotificationAckRecorder) { h.notifAck = r }

// Drain blocks until every in-flight Connect handler has finished its
// teardown (presence cleanup + offline publish), or the timeout lapses.
// Called during graceful shutdown AFTER the broker closes its clients (which
// unblocks each connection loop). Returns false on timeout — teardown then
// finishes on the distributed side by per-connection expiry.
func (h *WSHandler) Drain(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		h.drain.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Connect upgrades the HTTP connection to a WebSocket for the authenticated
// user. Authentication is handled via the "token" query parameter by the auth
// middleware.
func (h *WSHandler) Connect(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	h.drain.Add(1)
	defer h.drain.Done()
	// Per-connection identity for distributed presence: each socket owns its
	// own expiring entry, so crashes/deploys can never leak or corrupt a
	// shared per-user counter.
	connID := store.NewID()

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
			h.presenceSvc.OnDisconnect(disconnectCtx, userID, connID)
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
		var chs []string
		var err error
		// Always send a result, even on panic: the receive below is unconditional,
		// so a recovered panic that skipped the send would hang the connection
		// forever. This defer runs AFTER safe.Recover (LIFO) — on panic it sends a
		// zero result (no extra subscriptions) and the handler proceeds; the panic
		// itself is already logged by safe.Recover.
		defer func() { chanCh <- subResult{chs, err} }()
		defer safe.Recover()
		// ID-only list: topic names need no channel META or unread math.
		ids, e := h.chanSvc.ListUserChannelIDs(r.Context(), userID)
		err = e
		for _, id := range ids {
			chs = append(chs, pubsub.ChannelName(id))
		}
	}()
	go func() {
		var chs []string
		var err error
		defer func() { convCh <- subResult{chs, err} }()
		defer safe.Recover()
		ids, e := h.convSvc.ListUserConversationIDs(r.Context(), userID)
		err = e
		for _, id := range ids {
			chs = append(chs, pubsub.ConversationName(id))
		}
	}()

	// presenceTopics is the channel+conversation subset of the subscription
	// list — exactly the audience a presence transition should reach. Handing
	// it to OnConnect below saves the audience resolver a second, redundant
	// read of the memberships this handshake just fetched.
	var presenceTopics []string

	cr := <-chanCh
	if cr.err != nil {
		slog.Error("ws: list channels", "error", cr.err, "userID", userID)
	} else {
		channels = append(channels, cr.channels...)
		presenceTopics = append(presenceTopics, cr.channels...)
	}

	cvr := <-convCh
	if cvr.err != nil {
		slog.Error("ws: list conversations", "error", cvr.err, "userID", userID)
	} else {
		channels = append(channels, cvr.channels...)
		presenceTopics = append(presenceTopics, cvr.channels...)
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
	// The just-built topics ride along so the transition publish does not
	// re-read this user's memberships. OnDisconnect (deferred above) stays
	// resolver-based: memberships may change over the connection's lifetime,
	// so the offline audience is resolved fresh.
	if h.presenceSvc != nil {
		h.presenceSvc.OnConnect(r.Context(), userID, connID, presenceTopics...)
	}

	// Cap the socket's lifetime at the auth context's expiry (+grace): auth
	// is otherwise verified only at upgrade time, so a deactivated user's
	// socket used to live indefinitely if the ephemeral force-logout event
	// was lost. At the deadline the loop exits, the connection closes, and a
	// healthy client transparently reconnects with a freshly-authenticated
	// ticket/token — re-validating the session at least every token lifetime.
	sessionDeadline := time.Now().Add(wsMaxSessionLifetime)
	if claims := middleware.ClaimsFromContext(r.Context()); claims != nil && claims.ExpiresAt != nil {
		sessionDeadline = claims.ExpiresAt.Add(wsSessionGrace)
	}
	ctx, cancel := context.WithDeadline(r.Context(), sessionDeadline)
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
		defer safe.Recover()
		gate := newTypingGate()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			h.handleInbound(ctx, userID, data, gate)
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
				h.presenceSvc.Refresh(ctx, userID, connID)
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
			safe.Go(func() { pingLiveness(ctx, conn, cancel) })
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
	evt := mustEvent(events.NewEvent(eventType, payload))
	data := mustJSON(json.Marshal(evt))
	return conn.Write(ctx, websocket.MessageText, data) == nil
}

// handleInbound dispatches a single client → server frame. Currently
// only the "typing" event is recognised; everything else is ignored.
func (h *WSHandler) handleInbound(ctx context.Context, userID string, raw []byte, gate *typingGate) {
	var msg inboundMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	switch msg.Type {
	case "typing":
		h.publishTyping(ctx, userID, msg, gate)
	case "timezone.update":
		if h.userSvc != nil {
			_, _ = h.userSvc.PatchTimeZoneIfChanged(ctx, userID, msg.TimeZone)
		}
	case "notification.ack":
		// The client confirms it received (and surfaced) the desktop
		// notification, so the deferred mobile-push fallback can stand down.
		if h.notifAck != nil && msg.MessageID != "" {
			if err := h.notifAck.MarkNotificationAcked(ctx, userID, msg.MessageID); err != nil {
				slog.Warn("notification ack record failed", "userID", userID, "messageID", msg.MessageID, "error", err)
			}
		}
	}
}

// publishTyping broadcasts a typing event to the parent's pubsub topic
// after verifying the sender is a member. Membership check prevents a
// stranger from spamming a channel they can't read.
func (h *WSHandler) publishTyping(ctx context.Context, userID string, msg inboundMessage, gate *typingGate) {
	if h.publisher == nil || msg.ParentID == "" {
		return
	}
	// Per-connection throttle BEFORE any lookup or publish: typing is pure
	// UI garnish, and an unthrottled read loop let one client turn keystroke
	// frames into a fan-out PUBLISH each.
	now := time.Now()
	if now.Sub(gate.lastTyping) < typingMinInterval {
		return
	}
	gate.lastTyping = now
	var topic string
	switch msg.ParentType {
	case service.ParentChannel:
		if h.chanSvc == nil {
			return
		}
		// Membership gate prevents a stranger from spamming a channel they
		// can't read; the verdict is cached per connection so a keystroke
		// burst costs one DynamoDB read, not one per frame.
		if !gate.check("c#"+msg.ParentID, func() bool { return h.chanSvc.IsMember(ctx, userID, msg.ParentID) }) {
			return
		}
		topic = pubsub.ChannelName(msg.ParentID)
	case service.ParentConversation:
		if h.convSvc == nil {
			return
		}
		if !gate.check("v#"+msg.ParentID, func() bool { return h.convSvc.IsParticipant(ctx, userID, msg.ParentID) }) {
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
	evt := mustEvent(events.NewEvent(events.EventTyping, payload))
	_ = h.publisher.Publish(ctx, topic, evt)
}
