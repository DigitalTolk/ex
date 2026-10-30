package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

var (
	// ErrInvalidAuth: no bot token, or one that is no app's.
	ErrInvalidAuth = errors.New("invalid auth")
	// ErrAppRateLimited: the app made too many calls this minute (see
	// RateLimitedError).
	ErrAppRateLimited = errors.New("ratelimited")
	// ErrTriggerExpired: a trigger_id older than 3 seconds, used, or
	// another app's.
	ErrTriggerExpired = errors.New("expired trigger id")
	// ErrViewNotFound: the form is closed, or isn't this app's (or person's).
	ErrViewNotFound = errors.New("view not found")
	// ErrDuplicateExternalID: another of the app's open forms has this
	// external_id; it must name one form, or updates by it go astray.
	ErrDuplicateExternalID = errors.New("duplicate external id")
	// ErrHashConflict: views.update named a hash the form has moved past.
	ErrHashConflict = errors.New("hash conflict")
	// ErrCantUpdateMessage: messages.update on a message another app (or a
	// person) posted.
	ErrCantUpdateMessage = errors.New("cant update message")
	// ErrIdempotencyInProgress: a call with this Idempotency-Key is still
	// running.
	ErrIdempotencyInProgress = errors.New("idempotency key in progress")
)

const (
	// triggerTTL is how long an app has to open a form after a click.
	triggerTTL = 3 * time.Second
	// viewTTL is how long an open form is kept: past it, submitting tells
	// the person the form has closed. Every update starts it again.
	viewTTL = 2 * time.Hour
	// idempotencyTTL is how long an app's Idempotency-Key is remembered.
	idempotencyTTL     = 24 * time.Hour
	maxIdempotencyKey  = 255
	maxFieldErrorChars = 300
)

// RateLimitedError refuses an app's call over its budget, saying when the
// next one would be admitted (the Retry-After header).
type RateLimitedError struct{ RetryAfter time.Duration }

func (e *RateLimitedError) Error() string { return "too many calls, slow down" }
func (e *RateLimitedError) Unwrap() error { return ErrAppRateLimited }

// clickIDKey carries the clicking browser tab's ID: a form the app opens in
// answer goes to that tab alone, not to every tab the person has open.
type clickIDKey struct{}

// WithClickID notes which browser tab a click came from.
func WithClickID(ctx context.Context, clickID string) context.Context {
	return context.WithValue(ctx, clickIDKey{}, clickID)
}

func clickIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(clickIDKey{}).(string)
	return id
}

// mintTrigger issues the trigger_id an app opens a form with: good once,
// for triggerTTL, for this person on this app. Without one (Redis down)
// the app can still answer the click any other way.
func (s *InteractionService) mintTrigger(ctx context.Context, rec model.TriggerRecord) string {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := "t_" + hex.EncodeToString(raw)
	if err := s.state.MintTrigger(ctx, responseTokenHash(token), rec, triggerTTL); err != nil {
		slog.WarnContext(ctx, "interactions: mint trigger failed", "app", rec.WebhookID, "error", err)
		return ""
	}
	return token
}

func newViewHash() string {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

// ViewApp is who a form is from, for its dialog's header.
type ViewApp struct {
	Name      string `json:"name"`
	AvatarURL string `json:"avatarURL,omitempty"`
	IconEmoji string `json:"iconEmoji,omitempty"`
}

// ViewEvent opens or updates a form in a person's client. ClickID names the
// tab that clicked: only it shows the form.
type ViewEvent struct {
	View    model.View `json:"view"`
	App     ViewApp    `json:"app"`
	ClickID string     `json:"clickID,omitempty"`
}

func viewApp(wh *model.IncomingWebhook, iconEmoji string) ViewApp {
	return ViewApp{Name: appName(wh), AvatarURL: wh.ProfileImageURL, IconEmoji: iconEmoji}
}

// ---- the app's side

// AuthenticateApp finds the app a bot token belongs to and spends one of
// its calls this minute. The token is compared in constant time against
// each app's current and (during a rotation) previous token.
func (s *InteractionService) AuthenticateApp(ctx context.Context, token string) (*model.IncomingWebhook, error) {
	if token == "" {
		return nil, apperr.Reject(ErrInvalidAuth, "send the app's bot token as Authorization: Bearer <token>")
	}
	list, err := s.webhooks.store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("interactions: list apps: %w", err)
	}
	now := s.now()
	for _, wh := range list {
		if botTokenMatches(wh, token, now) {
			ok, retry, err := s.limiter.AllowAppCall(ctx, wh.ID)
			if err == nil && !ok {
				return nil, &RateLimitedError{RetryAfter: retry}
			}
			return wh, nil
		}
	}
	return nil, apperr.Reject(ErrInvalidAuth, "that bot token isn't any app's")
}

// Idempotent runs an app's call once per Idempotency-Key: a retry with the
// same key (after a timeout, say) gets the first call's answer instead of
// doing it again. A call that fails releases the key. No key: just run.
func (s *InteractionService) Idempotent(ctx context.Context, wh *model.IncomingWebhook, method, key string, run func() (any, error)) ([]byte, error) {
	if key == "" {
		out, err := run()
		if err != nil {
			return nil, err
		}
		return json.Marshal(out)
	}
	if utf8.RuneCountInString(key) > maxIdempotencyKey {
		return nil, apperr.Invalid("the Idempotency-Key can be at most %d characters", maxIdempotencyKey)
	}
	scope := wh.ID + ":" + method
	prev, claimed, err := s.state.ClaimIdempotencyKey(ctx, scope, key, idempotencyTTL)
	if err != nil {
		slog.WarnContext(ctx, "interactions: idempotency unavailable", "app", wh.ID, "error", err)
		claimed = true // Redis down: run the call rather than refuse it
	}
	if !claimed {
		if len(prev) == 0 {
			return nil, apperr.Reject(ErrIdempotencyInProgress, "a call with this Idempotency-Key is still running")
		}
		return prev, nil
	}
	out, runErr := run()
	var answer []byte
	if runErr == nil {
		if answer, runErr = json.Marshal(out); runErr != nil {
			answer = nil
		}
	}
	if err := s.state.FinishIdempotencyKey(ctx, scope, key, answer, idempotencyTTL); err != nil {
		slog.WarnContext(ctx, "interactions: finish idempotency key failed", "app", wh.ID, "error", err)
	}
	return answer, runErr
}

// recordCall adds an app's call to its history.
func (s *InteractionService) recordCall(ctx context.Context, wh *model.IncomingWebhook, method, userID string, start time.Time, err error) {
	entry := model.InteractionEntry{At: s.now(), Kind: model.InteractionAPI, UserID: userID, ActionID: method, Result: model.InteractionOK, LatencyMs: time.Since(start).Milliseconds()}
	if err != nil {
		entry.Result, entry.Error = model.InteractionFailed, err.Error()
	}
	s.record(ctx, wh.ID, entry)
}

// OpenView opens a form for the person whose click (or submission) minted
// triggerID, in the tab they clicked from (views.open).
func (s *InteractionService) OpenView(ctx context.Context, wh *model.IncomingWebhook, triggerID string, in model.View) (_ *model.View, err error) {
	start := s.now()
	var userID string
	defer func() { s.recordCall(ctx, wh, "views.open", userID, start, err) }()
	if err := s.checkAvailable(ctx, wh); err != nil {
		return nil, err
	}
	rec, err := s.state.UseTrigger(ctx, responseTokenHash(triggerID))
	if err != nil {
		return nil, fmt.Errorf("interactions: use trigger: %w", err)
	}
	if rec == nil || rec.WebhookID != wh.ID {
		return nil, apperr.Reject(ErrTriggerExpired, "the trigger_id has expired or been used; open forms within 3 seconds of the click")
	}
	userID = rec.UserID
	view, err := s.webhooks.blockNormalizer(ctx, s.webhooks.newRefs()).view(ctx, in)
	if err != nil {
		return nil, err
	}
	if err := s.checkExternalIDFree(ctx, wh.ID, view.ExternalID, ""); err != nil {
		return nil, err
	}
	view.ID, view.Hash = "V"+store.NewID(), newViewHash()
	sv := &model.StoredView{View: view, WebhookID: wh.ID, UserID: rec.UserID, ClickID: rec.ClickID, IconEmoji: rec.IconEmoji, OpenedAt: s.now()}
	if err := s.state.SaveView(ctx, sv, viewTTL); err != nil {
		return nil, fmt.Errorf("interactions: save view: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(rec.UserID), events.EventViewOpened, ViewEvent{View: view, App: viewApp(wh, rec.IconEmoji), ClickID: rec.ClickID})
	return &view, nil
}

// UpdateView replaces an open form — named by its ID or the app's
// external_id — while the person has it open (views.update). With a hash,
// only if nothing changed the form since the app last saw it.
func (s *InteractionService) UpdateView(ctx context.Context, wh *model.IncomingWebhook, viewID, externalID, hash string, in model.View) (_ *model.View, err error) {
	start := s.now()
	var userID string
	defer func() { s.recordCall(ctx, wh, "views.update", userID, start, err) }()
	if viewID == "" && externalID != "" {
		if viewID, err = s.state.ViewIDByExternalID(ctx, wh.ID, externalID); err != nil {
			return nil, fmt.Errorf("interactions: find view: %w", err)
		}
	}
	sv, err := s.ownView(ctx, viewID, func(sv *model.StoredView) bool { return sv.WebhookID == wh.ID })
	if err != nil {
		return nil, err
	}
	userID = sv.UserID
	if hash != "" && hash != sv.View.Hash {
		return nil, apperr.Reject(ErrHashConflict, "the form changed since that hash; read it again")
	}
	view, err := s.replaceView(ctx, sv, in)
	if err != nil {
		return nil, err
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(sv.UserID), events.EventViewUpdated, ViewEvent{View: *view, App: viewApp(wh, sv.IconEmoji), ClickID: sv.ClickID})
	return view, nil
}

// ownView loads an open form that passes owns; a missing or foreign one
// reads as closed.
func (s *InteractionService) ownView(ctx context.Context, viewID string, owns func(*model.StoredView) bool) (*model.StoredView, error) {
	if viewID == "" {
		return nil, apperr.Reject(ErrViewNotFound, "this form has closed")
	}
	sv, err := s.state.GetView(ctx, viewID)
	if err != nil {
		return nil, fmt.Errorf("interactions: get view: %w", err)
	}
	if sv == nil || !owns(sv) {
		return nil, apperr.Reject(ErrViewNotFound, "this form has closed")
	}
	return sv, nil
}

// replaceView swaps an open form for the app's new one: same ID, a new
// hash, and the old external_id unless the new form names its own.
func (s *InteractionService) replaceView(ctx context.Context, sv *model.StoredView, in model.View) (*model.View, error) {
	view, err := s.webhooks.blockNormalizer(ctx, s.webhooks.newRefs()).view(ctx, in)
	if err != nil {
		return nil, err
	}
	view.ID, view.Hash = sv.View.ID, newViewHash()
	if view.ExternalID == "" {
		view.ExternalID = sv.View.ExternalID
	}
	if err := s.checkExternalIDFree(ctx, sv.WebhookID, view.ExternalID, sv.View.ID); err != nil {
		return nil, err
	}
	oldExternalID := sv.View.ExternalID
	sv.View = view
	// Save first: a failed save leaves the form as it was, still open.
	if err := s.state.SaveView(ctx, sv, viewTTL); err != nil {
		return nil, fmt.Errorf("interactions: save view: %w", err)
	}
	if oldExternalID != view.ExternalID {
		if err := s.state.DropViewExternalID(ctx, sv.WebhookID, oldExternalID, sv.View.ID); err != nil {
			slog.WarnContext(ctx, "interactions: drop old external id failed", "app", sv.WebhookID, "error", err)
		}
	}
	return &view, nil
}

// checkExternalIDFree refuses an external_id another of the app's open forms
// (not self) holds. One that names a closed or expired form is free.
func (s *InteractionService) checkExternalIDFree(ctx context.Context, webhookID, externalID, self string) error {
	if externalID == "" {
		return nil
	}
	id, err := s.state.ViewIDByExternalID(ctx, webhookID, externalID)
	if err != nil {
		return fmt.Errorf("interactions: find view: %w", err)
	}
	if id == "" || id == self {
		return nil
	}
	other, err := s.state.GetView(ctx, id)
	if err != nil {
		return fmt.Errorf("interactions: get view: %w", err)
	}
	if other != nil {
		return apperr.Reject(ErrDuplicateExternalID, "another open form has external_id %q", externalID)
	}
	return nil
}

// MessageUpdate is messages.update's input: which message, its new
// content, and optionally the version it must still be at.
type MessageUpdate struct {
	ChannelID   string                    `json:"channel_id"`
	MessageID   string                    `json:"message_id"`
	Text        string                    `json:"text"`
	Blocks      model.Blocks              `json:"blocks"`
	Attachments []model.MessageAttachment `json:"attachments"`
	IfVersion   *int                      `json:"if_version"`
}

// UpdateMessage replaces one of the app's own messages at any time
// (messages.update) — as replace_original does, without a click: live for
// everyone, no "edited" label, nobody notified.
func (s *InteractionService) UpdateMessage(ctx context.Context, wh *model.IncomingWebhook, in MessageUpdate) (_ *model.Message, err error) {
	start := s.now()
	defer func() { s.recordCall(ctx, wh, "messages.update", "", start, err) }()
	if in.ChannelID == "" || in.MessageID == "" {
		return nil, apperr.Invalid("channel_id and message_id are required")
	}
	msg, err := s.messages.messages.GetMessage(ctx, in.ChannelID, in.MessageID)
	if err != nil || msg.Deleted {
		return nil, apperr.NotFound("message not found")
	}
	if msg.WebhookID != wh.ID {
		return nil, apperr.Reject(ErrCantUpdateMessage, "that message isn't this app's")
	}
	parentType := ParentChannel
	if _, err := s.webhooks.channels.GetByID(ctx, in.ChannelID); errors.Is(err, store.ErrNotFound) {
		parentType = ParentConversation
	} else if err != nil {
		return nil, fmt.Errorf("interactions: find channel: %w", err)
	}
	rec := model.ResponseURLRecord{WebhookID: wh.ID, ParentID: in.ChannelID, ParentType: parentType, MessageID: in.MessageID}
	return s.replaceOriginal(ctx, wh, rec, AppResponse{ReplaceOriginal: true, Text: in.Text, Blocks: in.Blocks, Attachments: in.Attachments, IfVersion: in.IfVersion})
}

// ---- the person's side

// ViewSubmitResult is what a submission came to, for the form's dialog:
// close it, show errors under fields, show the app's next form, or keep it
// open (the app didn't answer). A notice is for the person alone.
type ViewSubmitResult struct {
	Action string            `json:"action"`
	Errors map[string]string `json:"errors,omitempty"`
	View   *model.View       `json:"view,omitempty"`
	Notice string            `json:"notice,omitempty"`
	Failed bool              `json:"failed,omitempty"`
}

// Submission outcomes.
const (
	ViewClose  = "close"
	ViewErrors = "errors"
	ViewUpdate = "update"
	ViewKeep   = "keep"
)

// viewAnswer is an app's answer to a submission.
type viewAnswer struct {
	ResponseAction string            `json:"response_action"`
	Errors         map[string]string `json:"errors"`
	View           *model.View       `json:"view"`
	Notice         string            `json:"notice"`
}

type submittedView struct {
	ID              string                                     `json:"id"`
	CallbackID      string                                     `json:"callback_id,omitempty"`
	PrivateMetadata string                                     `json:"private_metadata,omitempty"`
	ExternalID      string                                     `json:"external_id,omitempty"`
	Hash            string                                     `json:"hash"`
	State           map[string]map[string]map[string]ViewValue `json:"state"`
}

type viewSubmissionPayload struct {
	Type          string          `json:"type"`
	InteractionID string          `json:"interaction_id"`
	User          interactionUser `json:"user"`
	View          submittedView   `json:"view"`
	TriggerID     string          `json:"trigger_id,omitempty"`
}

// SubmitView sends a person's form to the app, once ex has checked it
// against the stored form, and carries out the app's answer.
func (s *InteractionService) SubmitView(ctx context.Context, userID, viewID string, raw map[string]map[string]string) (*ViewSubmitResult, error) {
	sv, err := s.ownView(ctx, viewID, func(sv *model.StoredView) bool { return sv.UserID == userID })
	if err != nil {
		return nil, err
	}
	wh, err := s.webhooks.store.Get(ctx, sv.WebhookID)
	if err != nil {
		return nil, apperr.Reject(ErrViewNotFound, "this form's app is gone")
	}
	if err := s.checkAvailable(ctx, wh); err != nil {
		return nil, err
	}
	values, problems := readSubmission(sv.View, raw)
	if problems != nil {
		return &ViewSubmitResult{Action: ViewErrors, Errors: problems}, nil
	}
	if ok, err := s.limiter.AllowClick(ctx, "click:"+wh.ID+":"+userID); err == nil && !ok {
		return nil, apperr.Reject(ErrClickRateLimited, "too many clicks, try again shortly")
	}
	if !s.acquire(wh.ID) {
		return nil, apperr.Reject(ErrAppBusy, "%s is busy, try again shortly", appName(wh))
	}
	defer s.release(wh.ID)

	payload := viewSubmissionPayload{
		Type:          "view_submission",
		InteractionID: "i_" + store.NewID(),
		User:          s.clicker(ctx, wh, userID),
		View: submittedView{
			ID: sv.View.ID, CallbackID: sv.View.CallbackID, PrivateMetadata: sv.View.PrivateMetadata,
			ExternalID: sv.View.ExternalID, Hash: sv.View.Hash, State: map[string]map[string]map[string]ViewValue{"values": values},
		},
		TriggerID: s.mintTrigger(ctx, model.TriggerRecord{WebhookID: wh.ID, UserID: userID, ClickID: sv.ClickID, IconEmoji: sv.IconEmoji}),
	}
	reply, status, latency, sendErr := s.send(ctx, wh, payload)
	entry := model.InteractionEntry{At: s.now(), Kind: model.InteractionSubmission, UserID: userID, ActionID: sv.View.CallbackID, Status: status, LatencyMs: latency.Milliseconds()}
	if sendErr != nil || status < 200 || status > 299 {
		entry.Result, entry.Error = failureOf(sendErr, status)
		s.noteFailure(ctx, wh, entry)
		return &ViewSubmitResult{Action: ViewKeep, Notice: fmt.Sprintf("%s didn't respond. Try again.", appName(wh)), Failed: true}, nil
	}
	if err := s.state.NoteAppSuccess(ctx, wh.ID); err != nil {
		slog.WarnContext(ctx, "interactions: note app success failed", "app", wh.ID, "error", err)
	}
	entry.Result = model.InteractionOK
	result := s.answerSubmission(ctx, wh, sv, reply, &entry)
	s.record(ctx, wh.ID, entry)
	if result.Action == ViewClose {
		if err := s.state.DeleteView(ctx, sv); err != nil {
			slog.WarnContext(ctx, "interactions: delete view failed", "app", wh.ID, "error", err)
		}
	}
	return result, nil
}

// answerSubmission reads the app's answer to a submission: nothing (or no
// response_action) closes the form, as does "clear"; "errors" keeps it open
// with messages under the fields named; "update" (or "push", which ex shows
// in place) swaps in the next form. An answer ex can't use keeps the form
// open with the person's input, and tells them.
func (s *InteractionService) answerSubmission(ctx context.Context, wh *model.IncomingWebhook, sv *model.StoredView, reply []byte, entry *model.InteractionEntry) *ViewSubmitResult {
	unusable := func(reason string) *ViewSubmitResult {
		entry.Error = reason
		return &ViewSubmitResult{Action: ViewKeep, Notice: fmt.Sprintf("%s's answer couldn't be shown.", appName(wh)), Failed: true}
	}
	var ans viewAnswer
	if trimmed := strings.TrimSpace(string(reply)); trimmed != "" && json.Unmarshal(reply, &ans) != nil {
		return unusable("the reply isn't a JSON answer")
	}
	out := &ViewSubmitResult{Notice: notice(ans.Notice)}
	switch ans.ResponseAction {
	case "", "clear":
		out.Action = ViewClose
	case "errors":
		fields := inputBlockIDs(sv.View)
		out.Action, out.Errors = ViewErrors, map[string]string{}
		for id, msg := range ans.Errors {
			if fields[id] && strings.TrimSpace(msg) != "" {
				out.Errors[id] = truncateRunes(strings.TrimSpace(msg), maxFieldErrorChars)
			}
		}
		if len(out.Errors) == 0 {
			names := slices.Sorted(maps.Keys(ans.Errors))
			return unusable("errors name no field of the form with a message: " + strings.Join(names, ", "))
		}
	case "update", "push":
		if ans.View == nil {
			return unusable(ans.ResponseAction + " without a view")
		}
		view, err := s.replaceView(ctx, sv, *ans.View)
		if err != nil {
			return unusable(err.Error())
		}
		out.Action, out.View = ViewUpdate, view
	default:
		return unusable("unknown response_action " + ans.ResponseAction)
	}
	return out
}

func inputBlockIDs(v model.View) map[string]bool {
	ids := map[string]bool{}
	for _, b := range v.Blocks {
		if b.Type == model.BlockInput {
			ids[b.BlockID] = true
		}
	}
	return ids
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// CloseView forgets a form its person closed. Closing one already gone is
// fine.
func (s *InteractionService) CloseView(ctx context.Context, userID, viewID string) error {
	sv, err := s.ownView(ctx, viewID, func(sv *model.StoredView) bool { return sv.UserID == userID })
	if errors.Is(err, ErrViewNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.state.DeleteView(ctx, sv); err != nil {
		return fmt.Errorf("interactions: close view: %w", err)
	}
	return nil
}
