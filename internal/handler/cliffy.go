package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// Cliffy's bot identity — its real bot_ account id and how its posts render.
// Lives here (with the rest of Cliffy) rather than in the generic message
// service, which holds no bot branding. main.go provisions + registers the bot
// from these, and Share posts cards under them.
const (
	CliffyAuthorID  = "bot_cliffy"
	CliffyUsername  = "Cliffy"
	CliffyIconEmoji = "robot" // ex's emoji set names the robot 🤖 "robot" (not "robot_face").
)

// cliffyPoster posts a bot-authored card into a channel/DM on the user's behalf
// (access-checked against the requester). Satisfied by *service.MessageService.
type cliffyPoster interface {
	SendBotCard(ctx context.Context, requestUserID, authorID, username, iconEmoji, parentID, parentType, parentMessageID, body string, attachments []model.MessageAttachment) (*model.Message, error)
}

// cliffyConvReader lists a scope's recent messages (access-checked against the
// requester). Satisfied by *service.MessageService.
type cliffyConvReader interface {
	List(ctx context.Context, userID, parentID, parentType, before string, limit int) ([]*model.Message, bool, error)
}

// cliffyUserResolver resolves author display names. Satisfied by *cache.RedisCache.
type cliffyUserResolver interface {
	GetUsers(ctx context.Context, userIDs []string) (map[string]*model.User, error)
}

const (
	// cliffyMaxChatBody caps the chat payload forwarded to the agent (the
	// transcript grows with the conversation, but not without bound).
	cliffyMaxChatBody = 4 << 20 // 4 MiB
	// cliffyMaxAPIBody caps a write passthrough's request/response bodies.
	cliffyMaxAPIBody = 1 << 20 // 1 MiB
)

// Default per-user Cliffy budgets. The agent loop (Opus, up to 10 steps) has no
// cost cap of its own, so these rate limits are ex's guard against a single
// user (or a runaway client) burning tokens / hammering the API.
const (
	cliffyChatLimit       = 30
	cliffyChatWindow      = time.Minute
	cliffyChatDailyLimit  = 300
	cliffyChatDailyWindow = 24 * time.Hour
	cliffyAPILimit        = 60
	cliffyAPIWindow       = time.Minute
	// Transcript injected as context so Cliffy can summarize / act on the
	// conversation the user is in. Bounded to keep cost + prompt size in check.
	cliffyTranscriptLimit    = 40
	cliffyTranscriptMsgChars = 600
)

// cliffyWriteMethods are the only methods the write passthrough forwards. Reads
// run server-side inside the agent turn (executeApi), never through here.
var cliffyWriteMethods = map[string]bool{
	http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true,
}

// CliffyHandlerConfig configures the Cliffy handler. Bridge is required; the
// other fields enable/scope the proxy endpoints.
type CliffyHandlerConfig struct {
	Bridge *service.CliffyBridge
	// AgentURL is CliffHub's Next.js agent endpoint (…/api/ai/chat). Empty →
	// chat proxy returns 503.
	AgentURL string
	// APIOrigin is CliffHub's Laravel API origin (scheme+host) the write
	// passthrough targets. Empty → passthrough returns 503.
	APIOrigin string
	// Limiter (optional) enforces the per-user cost caps.
	Limiter middleware.RateLimitCounter
	// Poster (optional) enables the "share to conversation" endpoint.
	Poster cliffyPoster
	// ConvReader + Users (optional) let the chat proxy inject the current
	// conversation's recent transcript as context, so Cliffy can summarize /
	// act on the channel the user is in.
	ConvReader cliffyConvReader
	Users      cliffyUserResolver
	// WebBase is CliffHub's web origin (e.g. https://cliffhub.example). Sent to
	// the panel so it can turn Cliffy's relative in-app links (/tasks/<id>) into
	// absolute CliffHub links that open in a new tab.
	WebBase string
	// InChatStore (optional) holds pending write-confirmations + Cliffy-thread
	// markers for the in-chat @cliffy flow. Nil → in-chat writes stay disabled.
	InChatStore *store.CliffyInChatStore
}

// CliffyHandler exposes the Cliffy identity-bridge + agent-proxy endpoints. It
// is only wired when the bridge is configured (CLIFFY_BRIDGE_* present).
type CliffyHandler struct {
	bridge     *service.CliffyBridge
	agentURL   string
	apiOrigin  string
	webBase    string
	limiter    middleware.RateLimitCounter
	poster     cliffyPoster
	convReader cliffyConvReader
	users      cliffyUserResolver
	inchat     *store.CliffyInChatStore
	client     *http.Client
}

// NewCliffyHandler returns a handler, or nil when the bridge is disabled so the
// router skips its routes.
func NewCliffyHandler(cfg CliffyHandlerConfig) *CliffyHandler {
	if cfg.Bridge == nil {
		return nil
	}
	return &CliffyHandler{
		bridge:     cfg.Bridge,
		agentURL:   strings.TrimSpace(cfg.AgentURL),
		apiOrigin:  strings.TrimRight(strings.TrimSpace(cfg.APIOrigin), "/"),
		webBase:    strings.TrimRight(strings.TrimSpace(cfg.WebBase), "/"),
		limiter:    cfg.Limiter,
		poster:     cfg.Poster,
		convReader: cfg.ConvReader,
		users:      cfg.Users,
		inchat:     cfg.InChatStore,
		// No Client.Timeout: streaming responses run for the length of the
		// agent turn. The request context bounds it instead.
		client: &http.Client{},
	}
}

// CreateSession establishes (or refreshes) a CliffHub session for the signed-in
// ex user via the bridge, reporting availability + expiry. The CliffHub token
// is deliberately NOT returned — it never leaves ex's backend.
func (h *CliffyHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	userID, email, ok := h.caller(w, r)
	if !ok {
		return
	}

	_, expiresAt, err := h.bridge.TokenFor(r.Context(), userID, email)
	if h.writeBridgeError(w, err) {
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "expires_at": expiresAt, "cliffhub_base": h.webBase})
}

// Chat proxies the browser's assistant-ui request to CliffHub's agent, injecting
// the caller's bridged CliffHub token server-side (so the token never reaches
// the browser) and streaming the SSE response straight back. A per-user rate
// limit stands in for the loop's missing cost cap.
func (h *CliffyHandler) Chat(w http.ResponseWriter, r *http.Request) {
	if h.agentURL == "" {
		writeError(w, http.StatusServiceUnavailable, "cliffy_unconfigured", "Cliffy chat isn't configured.")
		return
	}
	userID, email, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, "cliffy:chat:"+userID, cliffyChatLimit, cliffyChatWindow) {
		return
	}
	// Second dimension: a per-day budget stands in for real token accounting on
	// the agent loop (which has no cap of its own).
	if !h.allow(w, r, "cliffy:chat:day:"+userID, cliffyChatDailyLimit, cliffyChatDailyWindow) {
		return
	}

	token, _, err := h.bridge.TokenFor(r.Context(), userID, email)
	if h.writeBridgeError(w, err) {
		return
	}

	slog.Info("cliffy audit: chat", "userID", userID)

	body, err := io.ReadAll(io.LimitReader(r.Body, cliffyMaxChatBody))
	if err != nil {
		writeError(w, http.StatusBadRequest, "cliffy_bad_request", "Couldn't read your message.")
		return
	}

	// Enrich the agent context with the current conversation's recent transcript
	// (fetched as the user, so only what they can see), so Cliffy can summarize
	// or act on the channel they're in.
	body = h.enrichWithTranscript(r.Context(), userID, body)

	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, h.agentURL, bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "cliffy_unavailable", "Cliffy is temporarily unavailable. Please try again.")
		return
	}
	upstream.Header.Set("Authorization", "Bearer "+token)
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "text/event-stream")

	res, err := h.client.Do(upstream)
	if err != nil {
		writeError(w, http.StatusBadGateway, "cliffy_unavailable", "Cliffy is temporarily unavailable. Please try again.")
		return
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()

	if ct := res.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	// SSE hygiene: disable proxy/browser buffering so tokens arrive live.
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(res.StatusCode)
	streamCopy(w, res.Body)
}

// proxyAPIRequest is the body of a write passthrough — the same shape Cliffy's
// writeApi tool produces (method + app API path + optional query/body).
type proxyAPIRequest struct {
	Method string            `json:"method"`
	Path   string            `json:"path"`
	Query  map[string]string `json:"query"`
	Body   json.RawMessage   `json:"body"`
}

// Sentinel errors from doCliffhubWrite, so callers can map them to the right
// HTTP status / user message.
var (
	errCliffyNotConfigured = errors.New("cliffy: actions not configured")
	errCliffyBadMethod     = errors.New("cliffy: method not allowed")
	errCliffyBadPath       = errors.New("cliffy: path not allowed")
)

// cliffhubWriteInput is one CliffHub write to run as the user.
type cliffhubWriteInput struct {
	Method string
	Path   string
	Query  map[string]string
	Body   []byte
}

// cliffhubWriteResult is the relayed upstream response.
type cliffhubWriteResult struct {
	Status      int
	Body        []byte
	ContentType string
}

// doCliffhubWrite is the single implementation behind both the panel passthrough
// (ProxyAPI) and the in-chat confirm flow (executeWrite): method allow-list,
// SSRF guard (an app api/ path only — never a full URL or another host), bridged
// token, capped response read, and an audit log line. auditTag distinguishes the
// two call sites in the log.
func (h *CliffyHandler) doCliffhubWrite(ctx context.Context, userID, email, auditTag string, in cliffhubWriteInput) (cliffhubWriteResult, error) {
	var out cliffhubWriteResult
	if h.apiOrigin == "" {
		return out, errCliffyNotConfigured
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if !cliffyWriteMethods[method] {
		return out, errCliffyBadMethod
	}
	cleanPath := strings.TrimLeft(in.Path, "/")
	if strings.Contains(in.Path, "://") || !strings.HasPrefix(cleanPath, "api/") {
		return out, errCliffyBadPath
	}
	target, err := url.Parse(h.apiOrigin + "/" + cleanPath)
	if err != nil {
		return out, errCliffyBadPath
	}
	if len(in.Query) > 0 {
		q := target.Query()
		for k, v := range in.Query {
			q.Set(k, v)
		}
		target.RawQuery = q.Encode()
	}
	token, _, err := h.bridge.TokenFor(ctx, userID, email)
	if err != nil {
		return out, err
	}
	var reqBody io.Reader
	if len(in.Body) > 0 {
		reqBody = bytes.NewReader(in.Body)
	}
	upstream, err := http.NewRequestWithContext(ctx, method, target.String(), reqBody)
	if err != nil {
		return out, err
	}
	upstream.Header.Set("Authorization", "Bearer "+token)
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "application/json")
	res, err := h.client.Do(upstream)
	if err != nil {
		return out, err
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()

	// Audit every cross-app write Cliffy performs on the user's behalf.
	slog.Info("cliffy audit: "+auditTag, "userID", userID, "method", method, "path", cleanPath, "status", res.StatusCode)
	out.Status = res.StatusCode
	out.Body, _ = io.ReadAll(io.LimitReader(res.Body, cliffyMaxAPIBody))
	out.ContentType = res.Header.Get("Content-Type")
	return out, nil
}

// ProxyAPI executes a single approved CliffHub write on the caller's behalf,
// injecting the bridged token. It exists because Cliffy's writeApi is executed
// client-side after the human approves it — but ex's browser must never hold
// the CliffHub token, so the approved call is relayed through here instead.
// Writes only (reads run inside the agent turn); SSRF-guarded to app API paths.
func (h *CliffyHandler) ProxyAPI(w http.ResponseWriter, r *http.Request) {
	if h.apiOrigin == "" {
		writeError(w, http.StatusServiceUnavailable, "cliffy_unconfigured", "Cliffy actions aren't configured.")
		return
	}
	userID, email, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, "cliffy:api:"+userID, cliffyAPILimit, cliffyAPIWindow) {
		return
	}

	var req proxyAPIRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, cliffyMaxAPIBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "cliffy_bad_request", "Couldn't read the requested action.")
		return
	}

	res, err := h.doCliffhubWrite(r.Context(), userID, email, "write", cliffhubWriteInput{
		Method: req.Method, Path: req.Path, Query: req.Query, Body: req.Body,
	})
	switch {
	case errors.Is(err, errCliffyBadMethod):
		writeError(w, http.StatusBadRequest, "cliffy_bad_method", "Only write actions can be run this way.")
		return
	case errors.Is(err, errCliffyBadPath):
		writeError(w, http.StatusBadRequest, "cliffy_bad_path", "That action path isn't allowed.")
		return
	case errors.Is(err, errCliffyNotConfigured):
		writeError(w, http.StatusServiceUnavailable, "cliffy_unconfigured", "Cliffy actions aren't configured.")
		return
	case err != nil:
		// A bridge/mint failure gets its specific response; anything else
		// (network to CliffHub) is a generic upstream error.
		if h.writeBridgeError(w, err) {
			return
		}
		writeError(w, http.StatusBadGateway, "cliffy_unavailable", "Cliffy is temporarily unavailable. Please try again.")
		return
	}

	// Relay CliffHub's JSON result verbatim (including its status) so the agent
	// learns the real outcome — the created record's id, a validation error, etc.
	if res.ContentType != "" {
		w.Header().Set("Content-Type", res.ContentType)
	}
	w.WriteHeader(res.Status)
	_, _ = w.Write(res.Body)
}

type shareRequest struct {
	ScopeType  string `json:"scope_type"`
	ScopeID    string `json:"scope_id"`
	Text       string `json:"text"`
	Attachment *struct {
		Title     string `json:"title"`
		TitleLink string `json:"title_link"`
		Text      string `json:"text"`
		Color     string `json:"color"`
	} `json:"attachment"`
}

// Share posts a Cliffy card (e.g. a task Cliffy just created) into the channel
// or DM the panel was opened from, so BOTH participants see it — the "visible to
// both" mode. Access is checked against the requesting ex user, so a user can't
// make Cliffy speak into a conversation they aren't in.
func (h *CliffyHandler) Share(w http.ResponseWriter, r *http.Request) {
	if h.poster == nil {
		writeError(w, http.StatusServiceUnavailable, "cliffy_unconfigured", "Sharing isn't available.")
		return
	}
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusForbidden, "cliffy_unavailable", "Cliffy isn't available for this account.")
		return
	}

	var req shareRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, cliffyMaxAPIBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "cliffy_bad_request", "Couldn't read the share request.")
		return
	}
	if req.ScopeID == "" || (req.ScopeType != service.ParentChannel && req.ScopeType != service.ParentConversation) {
		writeError(w, http.StatusBadRequest, "cliffy_bad_scope", "Missing or invalid conversation to share to.")
		return
	}
	if strings.TrimSpace(req.Text) == "" && req.Attachment == nil {
		writeError(w, http.StatusBadRequest, "cliffy_bad_request", "Nothing to share.")
		return
	}

	var attachments []model.MessageAttachment
	if req.Attachment != nil {
		attachments = []model.MessageAttachment{{
			Title:     req.Attachment.Title,
			TitleLink: req.Attachment.TitleLink,
			Text:      req.Attachment.Text,
			Color:     req.Attachment.Color,
		}}
	}

	msg, err := h.poster.SendBotCard(r.Context(), userID, CliffyAuthorID, CliffyUsername, CliffyIconEmoji, req.ScopeID, req.ScopeType, "", req.Text, attachments)
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			writeError(w, http.StatusForbidden, "cliffy_forbidden", "You can't post to that conversation.")
			return
		}
		writeError(w, http.StatusBadGateway, "cliffy_share_failed", "Couldn't share that to the conversation.")
		return
	}

	slog.Info("cliffy audit: share", "userID", userID, "scopeType", req.ScopeType, "scopeID", req.ScopeID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message_id": msg.ID})
}

// Revoke tears down the caller's bridged CliffHub session (called on ex logout).
// Best-effort: logout must succeed even if revocation can't reach CliffHub.
func (h *CliffyHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	email := ""
	if claims := middleware.ClaimsFromContext(r.Context()); claims != nil {
		email = claims.Email
	}
	if userID != "" {
		if err := h.bridge.Revoke(r.Context(), userID, email); err != nil {
			slog.Warn("cliffy revoke failed", "userID", userID, "error", err)
		} else {
			slog.Info("cliffy audit: revoke", "userID", userID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// caller resolves and validates the signed-in ex user, writing a 403 and
// returning ok=false when Cliffy can't act for them.
func (h *CliffyHandler) caller(w http.ResponseWriter, r *http.Request) (userID, email string, ok bool) {
	userID = middleware.UserIDFromContext(r.Context())
	if claims := middleware.ClaimsFromContext(r.Context()); claims != nil {
		email = claims.Email
	}
	if userID == "" || email == "" {
		writeError(w, http.StatusForbidden, "cliffy_unavailable", "Cliffy isn't available for this account.")
		return "", "", false
	}
	return userID, email, true
}

// enrichWithTranscript reads the ex scope the panel sent in the request's
// context, fetches that conversation's recent messages as the user, resolves
// author names, and injects them as context.messages for the agent. Returns the
// body unchanged when there's no scope / reader, so it's always safe to call.
func (h *CliffyHandler) enrichWithTranscript(ctx context.Context, userID string, body []byte) []byte {
	if h.convReader == nil {
		return body
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	ctxObj, _ := payload["context"].(map[string]any)
	if ctxObj == nil {
		return body
	}
	scope, _ := ctxObj["scope"].(map[string]any)
	if scope == nil {
		return body
	}
	stype, _ := scope["type"].(string)
	sid, _ := scope["id"].(string)
	if sid == "" || (stype != service.ParentChannel && stype != service.ParentConversation) {
		return body
	}

	transcript := h.buildTranscript(ctx, userID, stype, sid)
	if len(transcript) == 0 {
		return body
	}
	ctxObj["messages"] = transcript
	payload["context"] = ctxObj
	if out, err := json.Marshal(payload); err == nil {
		return out
	}
	return body
}

// buildTranscript lists the scope's recent messages (access-checked via the
// user id) and returns them oldest-first as {author, text}, names resolved.
func (h *CliffyHandler) buildTranscript(ctx context.Context, userID, parentType, parentID string) []map[string]string {
	if h.convReader == nil {
		return nil
	}
	msgs, _, err := h.convReader.List(ctx, userID, parentID, parentType, "", cliffyTranscriptLimit)
	if err != nil || len(msgs) == 0 {
		return nil
	}

	names := map[string]string{}
	if h.users != nil {
		seen := map[string]bool{}
		ids := make([]string, 0, len(msgs))
		for _, m := range msgs {
			if m.AuthorID != "" && !seen[m.AuthorID] {
				seen[m.AuthorID] = true
				ids = append(ids, m.AuthorID)
			}
		}
		if um, uerr := h.users.GetUsers(ctx, ids); uerr == nil {
			for id, u := range um {
				if u != nil {
					names[id] = u.DisplayName
				}
			}
		}
	}

	// List is newest-first (before-pagination); walk backwards for chronological order.
	out := make([]map[string]string, 0, len(msgs))
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		text := strings.TrimSpace(m.Body)
		if m.System || text == "" {
			continue
		}
		author := names[m.AuthorID]
		if author == "" {
			if m.WebhookUsername != "" {
				author = m.WebhookUsername
			} else {
				author = "Someone"
			}
		}
		// Rune-slice, not byte-slice: byte-slicing would split a multi-byte glyph
		// (emoji, non-Latin text) into invalid UTF-8.
		if r := []rune(text); len(r) > cliffyTranscriptMsgChars {
			text = string(r[:cliffyTranscriptMsgChars]) + "…"
		}
		out = append(out, map[string]string{"author": author, "text": text})
	}
	return out
}

// allow applies a per-user cost cap. It fails OPEN on a limiter error (a Redis
// blip shouldn't take Cliffy down) but blocks cleanly when the budget is
// genuinely exceeded. Returns false (and writes 429) when the caller is blocked.
func (h *CliffyHandler) allow(w http.ResponseWriter, r *http.Request, key string, limit int, window time.Duration) bool {
	if h.limiter == nil {
		return true
	}
	allowed, err := h.limiter.AllowRequest(r.Context(), key, limit, window)
	if err == nil && !allowed {
		writeError(w, http.StatusTooManyRequests, "cliffy_rate_limited", "You're using Cliffy a little too fast. Give it a moment and try again.")
		return false
	}
	return true
}

// writeBridgeError maps a TokenFor error to an HTTP response. Returns true when
// it wrote one (the caller should stop), false when err was nil.
func (h *CliffyHandler) writeBridgeError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, service.ErrCliffyNoAccount):
		writeError(w, http.StatusForbidden, "cliffy_no_account", "You don't have a CliffHub account, so Cliffy can't act on your behalf.")
	default:
		writeError(w, http.StatusBadGateway, "cliffy_unavailable", "Cliffy is temporarily unavailable. Please try again.")
	}
	return true
}

// streamCopy pumps the upstream body to the client, flushing after each chunk
// so SSE events reach the browser as they are produced rather than buffered.
func streamCopy(w http.ResponseWriter, src io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}
