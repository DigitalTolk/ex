package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/netguard"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

var (
	// ErrAppUnavailable: the app is paused — by an admin, or for failing.
	ErrAppUnavailable = errors.New("app unavailable")
	// ErrClickRateLimited: the clicker sent this app too many clicks.
	ErrClickRateLimited = errors.New("too many clicks")
	// ErrAppBusy: too many of the app's clicks are on their way already.
	ErrAppBusy = errors.New("app busy")
	// ErrBotTokenRequired: buttons that call the app need its bot token.
	ErrBotTokenRequired = errors.New("bot token required")
	// ErrInvalidBotToken: the bot token sent isn't this app's.
	ErrInvalidBotToken = errors.New("invalid bot token")
	// ErrNotRichWebhook: interactivity (buttons, forms, a bot token) is a
	// rich webhook's; a classic webhook only posts.
	ErrNotRichWebhook = errors.New("not a rich webhook")
	// ErrAppVersionConflict: the app's change was made on a version of the
	// message that is no longer current (if_version).
	ErrAppVersionConflict = errors.New("version conflict")
	// ErrResponseURLExpired / ErrResponseURLUsedUp: a response_url past its
	// 30 minutes, or its 5 uses.
	ErrResponseURLExpired = errors.New("response url expired")
	ErrResponseURLUsedUp  = errors.New("response url used up")
)

const (
	// appClickTimeout is how long ex waits for an app's answer to a click.
	appClickTimeout = 3 * time.Second
	// maxAppReplyBytes bounds what ex reads of an app's answer.
	maxAppReplyBytes = 1 << 20
	responseURLUses  = 5
	responseURLTTL   = 30 * time.Minute
	// An app failing appFailureThreshold clicks in a row is paused for
	// appFailurePause, so its users stop waiting out timeouts.
	appFailureThreshold = 10
	appFailurePause     = 5 * time.Minute
	// maxAppClicksInFlight caps one app's clicks on their way at once (per
	// server), so a slow app can't hold every request.
	maxAppClicksInFlight = 10
	maxNoticeChars       = 300
	maxRequestURLChars   = 2048
)

// AppInteractionState is interactivity's short-lived state (Redis).
type AppInteractionState interface {
	MintResponseURL(ctx context.Context, tokenHash string, rec model.ResponseURLRecord, uses int, ttl time.Duration) error
	UseResponseURL(ctx context.Context, tokenHash string) (*model.ResponseURLRecord, int, error)
	RecordInteraction(ctx context.Context, webhookID string, entry model.InteractionEntry) error
	ListInteractions(ctx context.Context, webhookID string) ([]model.InteractionEntry, error)
	NoteAppFailure(ctx context.Context, webhookID string, threshold int, pause time.Duration) (time.Duration, error)
	NoteAppSuccess(ctx context.Context, webhookID string) error
	AppPausedFor(ctx context.Context, webhookID string) (time.Duration, error)

	MintTrigger(ctx context.Context, tokenHash string, rec model.TriggerRecord, ttl time.Duration) error
	UseTrigger(ctx context.Context, tokenHash string) (*model.TriggerRecord, error)
	SaveView(ctx context.Context, v *model.StoredView, ttl time.Duration) error
	GetView(ctx context.Context, id string) (*model.StoredView, error)
	ViewIDByExternalID(ctx context.Context, webhookID, externalID string) (string, error)
	DeleteView(ctx context.Context, v *model.StoredView) error
	// TakeView deletes v and reports whether this call was the one that did.
	TakeView(ctx context.Context, v *model.StoredView) (bool, error)
	DropViewExternalID(ctx context.Context, webhookID, externalID, viewID string) error
	ClaimIdempotencyKey(ctx context.Context, scope, key string, ttl time.Duration) ([]byte, bool, error)
	FinishIdempotencyKey(ctx context.Context, scope, key string, answer []byte, ttl time.Duration) error
}

// ClickLimiter admits one more click under key's budget, and one more call
// an app makes to ex under its own.
type ClickLimiter interface {
	AllowClick(ctx context.Context, key string) (bool, error)
	AllowAppCall(ctx context.Context, webhookID string) (ok bool, retryAfter time.Duration, err error)
}

// AppClickResult is what a click on an app button came to: the message as it
// now is (nil when the app changed nothing) and a notice for the clicker.
// Failed marks a click that didn't go through, so its notice reads as an error.
type AppClickResult struct {
	Message *model.Message
	Notice  string
	Failed  bool
}

// AppResponse is an app's answer — in the body of its reply to a click, or
// posted to a response_url. It may replace or delete the message, post a new
// one, and leave the clicker a notice.
type AppResponse struct {
	ReplaceOriginal bool                      `json:"replace_original"`
	DeleteOriginal  bool                      `json:"delete_original"`
	Text            string                    `json:"text"`
	Blocks          model.Blocks              `json:"blocks"`
	Attachments     []model.MessageAttachment `json:"attachments"`
	RootID          string                    `json:"root_id"`
	// IfVersion applies the change only to that version of the message.
	IfVersion *int   `json:"if_version"`
	Notice    string `json:"notice"`
}

func (r AppResponse) postsMessage() bool {
	return r.Text != "" || len(r.Blocks) > 0 || len(r.Attachments) > 0
}

// InteractionService connects apps to the buttons on their messages: it
// sends clicks, applies the apps' answers, and runs the setup the webhooks
// panel offers.
type InteractionService struct {
	messages  *MessageService
	webhooks  *IncomingWebhookService
	state     AppInteractionState
	limiter   ClickLimiter
	signer    *AppSigner
	client    *http.Client
	publisher Publisher
	baseURL   string

	// allowPrivate admits any request URL (a development workspace whose
	// app runs on the same machine, over plain HTTP); internalDomains lets
	// hosts under them reach 10.0.0.0/8, as connectors may.
	allowPrivate    bool
	internalDomains []string
	lookupIP        func(ctx context.Context, host string) ([]net.IP, error)
	now             func() time.Time
	// timeout is how long a click waits for the app (appClickTimeout).
	timeout time.Duration
	// async runs what nobody waits for (view_closed): a goroutine, or
	// inline in tests.
	async func(func())

	mu       sync.Mutex
	inFlight map[string]int
}

// InteractionConfig is what NewInteractionService needs beyond its peers.
type InteractionConfig struct {
	SigningKey      []byte
	BaseURL         string
	AllowPrivate    bool
	InternalDomains []string
}

// NewInteractionService wires interactivity and registers it with the
// message service, which hands it every click on an app button.
func NewInteractionService(messages *MessageService, webhooks *IncomingWebhookService, state AppInteractionState, limiter ClickLimiter, publisher Publisher, cfg InteractionConfig) *InteractionService {
	s := &InteractionService{
		messages:        messages,
		webhooks:        webhooks,
		state:           state,
		limiter:         limiter,
		signer:          NewAppSigner(cfg.SigningKey),
		publisher:       publisher,
		baseURL:         strings.TrimRight(cfg.BaseURL, "/"),
		allowPrivate:    cfg.AllowPrivate,
		internalDomains: cfg.InternalDomains,
		lookupIP: func(ctx context.Context, host string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip", host)
		},
		now:      time.Now,
		timeout:  appClickTimeout,
		async:    func(f func()) { go f() },
		inFlight: map[string]int{},
	}
	// The same guard as connectors' calls: every dial is checked (so DNS
	// rebinding can't slip past the save-time check), and no redirect is
	// followed — a 3xx is the app's answer, and not a 2xx.
	s.client = netguard.NewClient(netguard.Options{
		Timeout:         appClickTimeout,
		AllowPrivate:    func() bool { return s.allowPrivate },
		InternalDomains: func() []string { return s.internalDomains },
	})
	s.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	messages.SetAppClicker(s)
	return s
}

func appName(wh *model.IncomingWebhook) string {
	if wh.Username != "" && wh.Username != "webhook" {
		return wh.Username
	}
	return wh.Title
}

// Click sends userID's click on an app button to the app and applies its
// answer. A slow or failing app costs the clicker a notice, never an error:
// nothing else changes.
func (s *InteractionService) Click(ctx context.Context, msg *model.Message, parentType string, button model.BlockElement, blockID, userID string, value RawValue) (*AppClickResult, error) {
	if !msg.AppButtons {
		return nil, apperr.Reject(ErrAppNotSetUp, "this app isn't set up for buttons")
	}
	wh, err := s.webhooks.store.Get(ctx, msg.WebhookID)
	if err != nil || wh.InteractivityURL == "" {
		return nil, apperr.Reject(ErrAppNotSetUp, "this app isn't set up for buttons")
	}
	if err := s.checkAvailable(ctx, wh); err != nil {
		return nil, err
	}
	if ok, err := s.limiter.AllowClick(ctx, "click:"+wh.ID+":"+userID); err == nil && !ok {
		return nil, apperr.Reject(ErrClickRateLimited, "too many clicks, try again shortly")
	}
	// Checked once the click is within budget: a pick can cost lookups.
	action, err := s.actionFor(ctx, button, blockID, value, s.pickableUser(ctx))
	if err != nil {
		return nil, err
	}
	if !s.acquire(wh.ID) {
		return nil, apperr.Reject(ErrAppBusy, "%s is busy, try again shortly", appName(wh))
	}
	defer s.release(wh.ID)

	payload := s.clickPayload(ctx, wh, msg, parentType, action, userID)
	reply, status, latency, sendErr := s.send(ctx, wh, payload)
	entry := model.InteractionEntry{At: s.now(), Kind: model.InteractionClick, UserID: userID, ActionID: button.ActionID, Status: status, LatencyMs: latency.Milliseconds()}
	if sendErr != nil || status < 200 || status > 299 {
		entry.Result, entry.Error = failureOf(sendErr, status)
		s.noteFailure(ctx, wh, entry)
		return &AppClickResult{Notice: fmt.Sprintf("%s didn't respond. Try again.", appName(wh)), Failed: true}, nil
	}
	if err := s.state.NoteAppSuccess(ctx, wh.ID); err != nil {
		slog.WarnContext(ctx, "interactions: note app success failed", "app", wh.ID, "error", err)
	}
	result := &AppClickResult{}
	if resp, ok := parseAppResponse(reply); ok {
		rec := model.ResponseURLRecord{WebhookID: wh.ID, ParentID: msg.ParentID, ParentType: parentType, MessageID: msg.ID, UserID: userID}
		result.Message, err = s.apply(ctx, wh, rec, resp)
		if err != nil {
			entry.Error = err.Error()
			result.Notice = fmt.Sprintf("%s's answer couldn't be shown.", appName(wh))
			result.Failed = true
		}
		// An answer that posted a new message left the clicked card as it was.
		if result.Message != nil && result.Message.ID != msg.ID {
			result.Message = nil
		}
		if resp.Notice != "" {
			result.Notice = notice(resp.Notice)
		}
	} else if len(bytes.TrimSpace(reply)) > 0 {
		entry.Error = "the reply isn't a JSON answer; ignored"
	}
	entry.Result = model.InteractionOK
	s.record(ctx, wh.ID, entry)
	return result, nil
}

// checkAvailable refuses a paused app: an admin's pause, or its failures'.
func (s *InteractionService) checkAvailable(ctx context.Context, wh *model.IncomingWebhook) error {
	if wh.AdminPaused {
		return apperr.Reject(ErrAppUnavailable, "%s is paused by an admin", appName(wh))
	}
	if paused, err := s.state.AppPausedFor(ctx, wh.ID); err == nil && paused > 0 {
		return apperr.Reject(ErrAppUnavailable, "%s is unavailable right now, try again in a few minutes", appName(wh))
	}
	return nil
}

func (s *InteractionService) acquire(webhookID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight[webhookID] >= maxAppClicksInFlight {
		return false
	}
	s.inFlight[webhookID]++
	return true
}

func (s *InteractionService) release(webhookID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight[webhookID]--; s.inFlight[webhookID] <= 0 {
		delete(s.inFlight, webhookID)
	}
}

// noteFailure counts a failed click towards pausing the app and records it.
func (s *InteractionService) noteFailure(ctx context.Context, wh *model.IncomingWebhook, entry model.InteractionEntry) {
	if paused, err := s.state.NoteAppFailure(ctx, wh.ID, appFailureThreshold, appFailurePause); err != nil {
		slog.WarnContext(ctx, "interactions: note app failure failed", "app", wh.ID, "error", err)
	} else if paused > 0 {
		slog.WarnContext(ctx, "interactions: app paused after failing", "app", wh.ID, "for", paused)
	}
	s.record(ctx, wh.ID, entry)
}

func (s *InteractionService) record(ctx context.Context, webhookID string, entry model.InteractionEntry) {
	if err := s.state.RecordInteraction(ctx, webhookID, entry); err != nil {
		slog.WarnContext(ctx, "interactions: record failed", "app", webhookID, "error", err)
	}
}

func failureOf(err error, status int) (result, reason string) {
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Client.Timeout") {
			return model.InteractionTimeout, "no answer within 3 seconds"
		}
		return model.InteractionFailed, err.Error()
	}
	return model.InteractionFailed, "answered " + strconv.Itoa(status)
}

// notice keeps a clicker's notice short and plain.
func notice(text string) string {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) > maxNoticeChars {
		text = string([]rune(text)[:maxNoticeChars-1]) + "…"
	}
	return text
}

// parseAppResponse reads an answer from a reply body; an empty or non-JSON
// body is no answer.
func parseAppResponse(body []byte) (AppResponse, bool) {
	var resp AppResponse
	if len(bytes.TrimSpace(body)) == 0 || json.Unmarshal(body, &resp) != nil {
		return AppResponse{}, false
	}
	return resp, true
}

// ---- the request to the app

type interactionUser struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
}

type interactionChannel struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type interactionContainer struct {
	Type      string `json:"type"`
	MessageID string `json:"message_id,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	ViewID    string `json:"view_id,omitempty"`
}

type interactionMessage struct {
	ID          string                    `json:"id"`
	Version     int                       `json:"version"`
	Text        string                    `json:"text"`
	Blocks      model.Blocks              `json:"blocks,omitempty"`
	Attachments []model.MessageAttachment `json:"attachments,omitempty"`
}

// interactionAction is the element used and what was picked, in Slack's
// shape: a button's stored value, or a picker's selection — checked against
// the stored element (actionFor).
type interactionAction struct {
	Type            string               `json:"type"`
	ActionID        string               `json:"action_id"`
	BlockID         string               `json:"block_id"`
	Value           string               `json:"value,omitempty"`
	Text            *model.TextObject    `json:"text,omitempty"`
	SelectedOption  *model.SelectOption  `json:"selected_option,omitempty"`
	SelectedOptions []model.SelectOption `json:"selected_options,omitempty"`
	SelectedDate    *string              `json:"selected_date,omitempty"`
	SelectedTime    *string              `json:"selected_time,omitempty"`
	SelectedUser    *string              `json:"selected_user,omitempty"`
	SelectedUsers   []string             `json:"selected_users,omitempty"`
	ActionAt        time.Time            `json:"action_at"`
}

// actionFor is the action an element's use sends the app. A button sends
// its stored value; a picker sends what was picked, refused unless it is a
// value the stored element can hold. A single choice can't be empty; a list
// (checkboxes, multi-selects) can — everything unticked.
func (s *InteractionService) actionFor(ctx context.Context, el model.BlockElement, blockID string, raw RawValue, users userCheck) (interactionAction, error) {
	a := interactionAction{Type: el.Type, ActionID: el.ActionID, BlockID: blockID, ActionAt: s.now().UTC()}
	if el.Type == model.ElementButton {
		a.Value, a.Text = el.Value, el.Text
		return a, nil
	}
	v, empty, problem := readValue(el, raw, users)
	if problem == "" && empty && !model.IsMultiValue(el.Type) {
		problem = emptyProblem(el.Type)
	}
	if problem != "" {
		return interactionAction{}, apperr.Invalid("%s", problem)
	}
	if v.Value != nil {
		a.Value = *v.Value
	}
	a.SelectedOption, a.SelectedOptions, a.SelectedDate, a.SelectedTime, a.SelectedUser, a.SelectedUsers =
		v.SelectedOption, v.SelectedOptions, v.SelectedDate, v.SelectedTime, v.SelectedUser, v.SelectedUsers
	return a, nil
}

type blockActionsPayload struct {
	Type          string               `json:"type"`
	InteractionID string               `json:"interaction_id"`
	Test          bool                 `json:"test,omitempty"`
	User          interactionUser      `json:"user"`
	Channel       *interactionChannel  `json:"channel,omitempty"`
	Container     interactionContainer `json:"container"`
	Message       *interactionMessage  `json:"message,omitempty"`
	View          *submittedView       `json:"view,omitempty"`
	Actions       []interactionAction  `json:"actions"`
	ResponseURL   string               `json:"response_url,omitempty"`
	TriggerID     string               `json:"trigger_id,omitempty"`
}

// clickPayload is the block_actions request for a click. Everything in it
// comes from ex's own records: the button and its value from the stored
// message, the clicker from the session.
func (s *InteractionService) clickPayload(ctx context.Context, wh *model.IncomingWebhook, msg *model.Message, parentType string, action interactionAction, userID string) blockActionsPayload {
	p := blockActionsPayload{
		Type:          "block_actions",
		InteractionID: "i_" + store.NewID(),
		User:          s.clicker(ctx, wh, userID),
		Channel:       &interactionChannel{ID: msg.ParentID, Name: s.parentName(ctx, msg.ParentID, parentType)},
		Container:     interactionContainer{Type: "message", MessageID: msg.ID, ChannelID: msg.ParentID},
		Message:       &interactionMessage{ID: msg.ID, Version: msg.Version, Text: msg.Body, Blocks: msg.Blocks, Attachments: msg.MessageAttachments},
		Actions:       []interactionAction{action},
	}
	p.ResponseURL = s.mintResponseURL(ctx, model.ResponseURLRecord{WebhookID: wh.ID, ParentID: msg.ParentID, ParentType: parentType, MessageID: msg.ID, UserID: userID})
	p.TriggerID = s.mintTrigger(ctx, model.TriggerRecord{WebhookID: wh.ID, UserID: userID, ClickID: clickIDFrom(ctx), IconEmoji: msg.WebhookIconEmoji})
	return p
}

// clicker is who clicked, as the app sees them; their email only when an
// admin let this app have it.
func (s *InteractionService) clicker(ctx context.Context, wh *model.IncomingWebhook, userID string) interactionUser {
	u := interactionUser{ID: userID}
	if s.webhooks.users == nil {
		return u
	}
	if user, err := s.webhooks.users.GetByID(ctx, userID); err == nil && user != nil {
		u.Name = user.DisplayName
		if wh.EmailSharing {
			u.Email = user.Email
		}
	}
	return u
}

func (s *InteractionService) parentName(ctx context.Context, parentID, parentType string) string {
	if parentType != ParentChannel {
		return ""
	}
	if ch, err := s.webhooks.channels.GetByID(ctx, parentID); err == nil {
		return ch.Name
	}
	return ""
}

// mintResponseURL issues the URL an app can answer a click through later.
// Only the token's hash is kept. Without one (Redis down) the app can still
// answer in its reply.
func (s *InteractionService) mintResponseURL(ctx context.Context, rec model.ResponseURLRecord) string {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := base64.RawURLEncoding.EncodeToString(raw)
	if err := s.state.MintResponseURL(ctx, responseTokenHash(token), rec, responseURLUses, responseURLTTL); err != nil {
		slog.WarnContext(ctx, "interactions: mint response url failed", "app", rec.WebhookID, "error", err)
		return ""
	}
	return s.baseURL + "/api/v1/apps/respond/" + token
}

func responseTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// send POSTs a signed payload to the app's request URL and reads its reply,
// up to maxAppReplyBytes.
func (s *InteractionService) send(ctx context.Context, wh *model.IncomingWebhook, payload any) ([]byte, int, time.Duration, error) {
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, wh.InteractivityURL, bytes.NewReader(body))
	if err != nil {
		return nil, 0, 0, err
	}
	now := s.now()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ex-interactions/1")
	req.Header.Set("X-Ex-Request-Timestamp", strconv.FormatInt(now.Unix(), 10))
	req.Header.Set("X-Ex-Signature", s.signer.SignatureHeader(wh, now.Unix(), body, now))
	start := time.Now()
	res, err := s.client.Do(req)
	if err != nil {
		return nil, 0, time.Since(start), err
	}
	defer func() { _ = res.Body.Close() }()
	reply, err := io.ReadAll(io.LimitReader(res.Body, maxAppReplyBytes))
	return reply, res.StatusCode, time.Since(start), err
}

// ---- applying an app's answer

// apply carries out an app's answer on the message rec names: replace it,
// delete it, or post a new one in its conversation. It returns the message
// as it now is (the replaced one, the tombstone, or the new post), nil when
// the answer changed nothing.
func (s *InteractionService) apply(ctx context.Context, wh *model.IncomingWebhook, rec model.ResponseURLRecord, resp AppResponse) (*model.Message, error) {
	switch {
	case resp.DeleteOriginal:
		return s.deleteOriginal(ctx, wh, rec, resp)
	case resp.ReplaceOriginal:
		return s.replaceOriginal(ctx, wh, rec, resp)
	case resp.postsMessage():
		return s.postNew(ctx, wh, rec, resp)
	}
	return nil, nil
}

// original loads the app's message rec names; another app's, or a deleted
// one, reads as not found.
func (s *InteractionService) original(ctx context.Context, wh *model.IncomingWebhook, rec model.ResponseURLRecord) (*model.Message, error) {
	msg, err := s.messages.messages.GetMessage(ctx, rec.ParentID, rec.MessageID)
	if err != nil || msg.WebhookID != wh.ID || msg.Deleted {
		return nil, apperr.NotFound("message not found")
	}
	return msg, nil
}

func versionConflict(resp AppResponse, msg *model.Message) error {
	if resp.IfVersion != nil && *resp.IfVersion != msg.Version {
		return apperr.Reject(ErrAppVersionConflict, "the message changed: it is at version %d, not %d", msg.Version, *resp.IfVersion)
	}
	return nil
}

func (s *InteractionService) deleteOriginal(ctx context.Context, wh *model.IncomingWebhook, rec model.ResponseURLRecord, resp AppResponse) (*model.Message, error) {
	msg, err := s.original(ctx, wh, rec)
	if err != nil {
		return nil, err
	}
	if err := versionConflict(resp, msg); err != nil {
		return nil, err
	}
	if err := s.messages.deleteLoaded(ctx, msg, "app:"+wh.ID, rec.ParentID, rec.ParentType); err != nil {
		return nil, err
	}
	return msg, nil
}

// replaceOriginal swaps the message's text, blocks and cards for the app's
// new ones. The message is not marked edited and nobody is notified: an
// app's card changing is what it's for. Votes and acknowledgements stay on
// the buttons the new card still has.
func (s *InteractionService) replaceOriginal(ctx context.Context, wh *model.IncomingWebhook, rec model.ResponseURLRecord, resp AppResponse) (*model.Message, error) {
	body, attachments, blocks, err := s.webhooks.appContent(ctx, IncomingWebhookPayload{Text: resp.Text, Blocks: resp.Blocks, Attachments: resp.Attachments})
	if err != nil {
		return nil, err
	}
	for attempt := 1; ; attempt++ {
		stored, err := s.original(ctx, wh, rec)
		if err != nil {
			return nil, err
		}
		if err := versionConflict(resp, stored); err != nil {
			return nil, err
		}
		msg := withOwnTallies(stored)
		msg.Body, msg.Blocks, msg.MessageAttachments = body, blocks, attachments
		msg.AppButtons = true
		kept := msg.ActionTallies[:0]
		for _, t := range msg.ActionTallies {
			if _, ok := ButtonAt(msg, t.BlockID, t.ActionID); ok {
				kept = append(kept, t)
			}
		}
		msg.ActionTallies = kept
		if len(kept) == 0 {
			msg.ActionTallies = nil
		}
		prev := msg.Version
		msg.Version = prev + 1
		err = s.messages.messages.UpdateMessageIfVersion(ctx, msg, prev)
		if errors.Is(err, store.ErrVersionConflict) && resp.IfVersion == nil && attempt < actionAttempts {
			continue
		}
		if errors.Is(err, store.ErrVersionConflict) {
			return nil, apperr.Reject(ErrAppVersionConflict, "the message changed meanwhile")
		}
		if err != nil {
			return nil, fmt.Errorf("interactions: replace message: %w", err)
		}
		s.messages.attachRendered(ctx, msg)
		s.messages.publishEvent(ctx, rec.ParentID, rec.ParentType, events.EventMessageEdited, msg)
		s.messages.indexMessage(ctx, msg, rec.ParentType)
		if s.messages.activity != nil && msg.Body != stored.Body {
			s.messages.activity.MessageEdited(ctx, msg, rec.ParentType)
		}
		return msg, nil
	}
}

// postNew posts the app's answer as a new message in the same conversation,
// as the same bot — in a thread when the answer names a root_id.
func (s *InteractionService) postNew(ctx context.Context, wh *model.IncomingWebhook, rec model.ResponseURLRecord, resp AppResponse) (*model.Message, error) {
	msg, err := s.original(ctx, wh, rec)
	if err != nil {
		return nil, err
	}
	body, attachments, blocks, err := s.webhooks.appContent(ctx, IncomingWebhookPayload{Text: resp.Text, Blocks: resp.Blocks, Attachments: resp.Attachments})
	if err != nil {
		return nil, err
	}
	return s.messages.SendWebhook(ctx, WebhookMessageInput{
		ParentID:        rec.ParentID,
		ParentType:      rec.ParentType,
		AuthorID:        msg.AuthorID,
		Body:            body,
		Username:        msg.WebhookUsername,
		AvatarURL:       msg.WebhookAvatarURL,
		IconEmoji:       msg.WebhookIconEmoji,
		Attachments:     attachments,
		ParentMessageID: strings.TrimSpace(resp.RootID),
		WebhookID:       wh.ID,
		Blocks:          blocks,
		AppButtons:      true,
	})
}

// Respond carries out an answer posted to a response_url. The URL is the
// credential: it stands for one click on one message, for 30 minutes and 5
// uses. A notice goes to the clicker alone.
func (s *InteractionService) Respond(ctx context.Context, token string, resp AppResponse) error {
	rec, left, err := s.state.UseResponseURL(ctx, responseTokenHash(token))
	if err != nil {
		return err
	}
	if rec == nil {
		return apperr.Reject(ErrResponseURLExpired, "this response_url has expired")
	}
	if left < 0 {
		return apperr.Reject(ErrResponseURLUsedUp, "this response_url has been used %d times", responseURLUses)
	}
	wh, err := s.webhooks.store.Get(ctx, rec.WebhookID)
	if err != nil {
		return apperr.Reject(ErrResponseURLExpired, "this response_url's app is gone")
	}
	start := time.Now()
	_, applyErr := s.apply(ctx, wh, *rec, resp)
	entry := model.InteractionEntry{At: s.now(), Kind: model.InteractionResponseURL, UserID: rec.UserID, Result: model.InteractionOK, LatencyMs: time.Since(start).Milliseconds()}
	if applyErr != nil {
		entry.Result, entry.Error = model.InteractionFailed, applyErr.Error()
	}
	s.record(ctx, wh.ID, entry)
	if applyErr != nil {
		return applyErr
	}
	if text := notice(resp.Notice); text != "" {
		events.Publish(ctx, s.publisher, pubsub.UserChannel(rec.UserID), events.EventInteractionNotice, map[string]string{
			"text": text, "messageID": rec.MessageID, "parentID": rec.ParentID,
		})
	}
	return nil
}

// ---- setup (the webhooks panel)

// InteractionStatus is an app's interactivity at a glance: its settings,
// whether it's paused for failing, and its recent interactions.
type InteractionStatus struct {
	Webhook      *model.IncomingWebhook   `json:"webhook"`
	PausedFor    int64                    `json:"pausedForSeconds,omitempty"`
	Interactions []model.InteractionEntry `json:"interactions"`
}

// Status shows the webhook's interactivity to someone who may manage it.
func (s *InteractionService) Status(ctx context.Context, actor WebhookActor, id string) (*InteractionStatus, error) {
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	out := &InteractionStatus{Webhook: wh.Present(), Interactions: []model.InteractionEntry{}}
	if paused, err := s.state.AppPausedFor(ctx, wh.ID); err == nil {
		out.PausedFor = int64(paused.Seconds())
	}
	if list, err := s.state.ListInteractions(ctx, wh.ID); err == nil {
		out.Interactions = list
	}
	return out, nil
}

func (s *InteractionService) manage(ctx context.Context, actor WebhookActor, id string) (*model.IncomingWebhook, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	wh, err := s.webhooks.owned(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if !wh.IsRich() {
		return nil, apperr.Reject(ErrNotRichWebhook, "buttons, forms and bot tokens are for rich webhooks; create a rich webhook for an app")
	}
	return wh, nil
}

func (s *InteractionService) save(ctx context.Context, wh *model.IncomingWebhook) (*model.IncomingWebhook, error) {
	wh.UpdatedAt = s.now()
	if err := s.webhooks.store.Update(ctx, wh); err != nil {
		return nil, fmt.Errorf("interactions: save webhook: %w", err)
	}
	s.webhooks.publishChanged(ctx)
	return wh.Present(), nil
}

// SetRequestURL sets where the app receives clicks; empty turns
// interactivity off (posted buttons stay, disabled).
func (s *InteractionService) SetRequestURL(ctx context.Context, actor WebhookActor, id, raw string) (*model.IncomingWebhook, error) {
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	raw = strings.TrimSpace(raw)
	if raw != "" {
		if err := s.checkRequestURL(ctx, raw); err != nil {
			return nil, err
		}
	}
	wh.InteractivityURL = raw
	return s.save(ctx, wh)
}

// checkRequestURL admits an https address on the public internet — or, for
// a host under the internal domains, 10.0.0.0/8 (as connectors). Every
// request checks again when it connects.
func (s *InteractionService) checkRequestURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > maxRequestURLChars || u.Host == "" || u.User != nil {
		return apperr.Invalid("the request URL must be a full https address")
	}
	if s.allowPrivate {
		if u.Scheme != "https" && u.Scheme != "http" {
			return apperr.Invalid("the request URL must be an http or https address")
		}
		return nil
	}
	if u.Scheme != "https" {
		return apperr.Invalid("the request URL must be an https address")
	}
	host := u.Hostname()
	ips, err := s.lookupIP(ctx, host)
	if err != nil || len(ips) == 0 {
		return apperr.Invalid("the request URL's host %s can't be found", host)
	}
	internal := netguard.InDomains(host, s.internalDomains)
	for _, ip := range ips {
		if netguard.IsPublicIP(ip) {
			continue
		}
		if addr, ok := netip.AddrFromSlice(ip); internal && ok && netip.MustParsePrefix("10.0.0.0/8").Contains(addr.Unmap()) {
			continue
		}
		return apperr.Invalid("the request URL's host %s is on a private network", host)
	}
	return nil
}

// RotateBotToken issues a new bot token, shown once. The old one keeps
// working for a day unless revokeNow.
func (s *InteractionService) RotateBotToken(ctx context.Context, actor WebhookActor, id string, revokeNow bool) (string, *model.IncomingWebhook, error) {
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return "", nil, err
	}
	wh.PrevBotTokenHash, wh.PrevBotTokenUntil = "", nil
	if wh.BotTokenHash != "" && !revokeNow {
		until := s.now().Add(rotationOverlap)
		wh.PrevBotTokenHash, wh.PrevBotTokenUntil = wh.BotTokenHash, &until
	}
	token, hash := newBotToken()
	wh.BotTokenHash = hash
	saved, err := s.save(ctx, wh)
	if err != nil {
		return "", nil, err
	}
	return token, saved, nil
}

// RotateSigningSecret issues a new signing secret, shown once. ex signs with
// the old one too for a day unless revokeNow.
func (s *InteractionService) RotateSigningSecret(ctx context.Context, actor WebhookActor, id string, revokeNow bool) (string, *model.IncomingWebhook, error) {
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return "", nil, err
	}
	wh.PrevSecretUntil = nil
	if wh.SecretVersion > 0 && !revokeNow {
		until := s.now().Add(rotationOverlap)
		wh.PrevSecretUntil = &until
	}
	wh.SecretVersion++
	saved, err := s.save(ctx, wh)
	if err != nil {
		return "", nil, err
	}
	return s.signer.Secret(wh.ID, wh.SecretVersion), saved, nil
}

// SetEmailSharing lets the app see clickers' emails. Workspace admins only:
// any member can own a webhook, but not hand out others' addresses.
func (s *InteractionService) SetEmailSharing(ctx context.Context, actor WebhookActor, id string, on bool) (*model.IncomingWebhook, error) {
	if actor.Role != model.SystemRoleAdmin {
		return nil, apperr.Forbidden("only a workspace admin can share clickers' emails with an app")
	}
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	wh.EmailSharing = on
	return s.save(ctx, wh)
}

// SetAdminPaused stops (or resumes) the app's buttons everywhere. Workspace
// admins only.
func (s *InteractionService) SetAdminPaused(ctx context.Context, actor WebhookActor, id string, paused bool) (*model.IncomingWebhook, error) {
	if actor.Role != model.SystemRoleAdmin {
		return nil, apperr.Forbidden("only a workspace admin can pause an app")
	}
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	wh.AdminPaused = paused
	return s.save(ctx, wh)
}

// TestResult is how the app answered a test interaction.
type TestResult struct {
	OK        bool   `json:"ok"`
	Status    int    `json:"status,omitempty"`
	LatencyMs int64  `json:"latencyMs"`
	Error     string `json:"error,omitempty"`
	Reply     string `json:"reply,omitempty"`
}

// SendTest sends the app a signed sample click ("test": true), so its setup
// can be checked before anyone clicks for real.
func (s *InteractionService) SendTest(ctx context.Context, actor WebhookActor, id string) (*TestResult, error) {
	wh, err := s.manage(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if wh.InteractivityURL == "" || wh.SecretVersion == 0 {
		return nil, apperr.Invalid("set a request URL and issue a signing secret first")
	}
	payload := blockActionsPayload{
		Type:          "block_actions",
		InteractionID: "i_" + store.NewID(),
		Test:          true,
		User:          s.clicker(ctx, wh, actor.ID),
		Channel:       &interactionChannel{ID: wh.ChannelID, Name: wh.ChannelName},
		Container:     interactionContainer{Type: "message", MessageID: "test", ChannelID: wh.ChannelID},
		Message:       &interactionMessage{ID: "test", Text: "Test interaction from ex"},
		Actions:       []interactionAction{{Type: model.ElementButton, ActionID: "test", BlockID: "test", Value: "test", ActionAt: s.now().UTC()}},
	}
	reply, status, latency, sendErr := s.send(ctx, wh, payload)
	out := &TestResult{Status: status, LatencyMs: latency.Milliseconds(), OK: sendErr == nil && status >= 200 && status <= 299}
	if r := strings.TrimSpace(string(reply)); r != "" {
		out.Reply = string([]rune(r)[:min(utf8.RuneCountInString(r), 500)])
	}
	entry := model.InteractionEntry{At: s.now(), Kind: model.InteractionTest, UserID: actor.ID, ActionID: "test", Status: status, LatencyMs: out.LatencyMs, Result: model.InteractionOK}
	if !out.OK {
		entry.Result, out.Error = failureOf(sendErr, status)
		entry.Error = out.Error
	}
	s.record(ctx, wh.ID, entry)
	return out, nil
}
