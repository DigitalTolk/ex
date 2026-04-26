package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/events"
)

const wsKeepAliveInterval = 30 * time.Second

// WSHandler serves a WebSocket connection for real-time updates.
type WSHandler struct {
	broker      *pubsub.Broker
	chanSvc     *service.ChannelService
	convSvc     *service.ConversationService
	presenceSvc *service.PresenceService
}

// NewWSHandler creates a WSHandler.
func NewWSHandler(broker *pubsub.Broker, chanSvc *service.ChannelService, convSvc *service.ConversationService, presenceSvc *service.PresenceService) *WSHandler {
	return &WSHandler{broker: broker, chanSvc: chanSvc, convSvc: convSvc, presenceSvc: presenceSvc}
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

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // allow any origin in dev; tighten in production
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
		h.broker.UnregisterClient(userID)
		if h.presenceSvc != nil {
			h.presenceSvc.OnDisconnect(context.Background(), userID)
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

	// Mark the user online AFTER subscribing to PresenceEvents so the publish
	// reaches the user's own client (and all other connected clients) instead
	// of being dispatched before any subscriber is wired up.
	if h.presenceSvc != nil {
		h.presenceSvc.OnConnect(r.Context(), userID)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Read loop: drain incoming messages (we don't use them), detect close.
	go func() {
		defer cancel()
		for {
			_, _, err := conn.Read(ctx)
			if err != nil {
				return
			}
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
			if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
				return
			}
		case <-ticker.C:
			if err := writePing(ctx, conn); err != nil {
				return
			}
		}
	}
}

func writePing(ctx context.Context, conn *websocket.Conn) error {
	evt, _ := events.NewEvent(events.EventPing, map[string]int64{"ts": time.Now().UnixMilli()})
	data, _ := json.Marshal(evt)
	return conn.Write(ctx, websocket.MessageText, data)
}
