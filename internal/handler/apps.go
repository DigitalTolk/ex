package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// The calls apps make to ex (/api/v1/apps/<method>), authenticated by the
// app's bot token, answered in Slack's shape: {"ok": true, …} or
// {"ok": false, "error": "<code>", "message": "…"}.

// ViewsOpen opens a form for the person whose click minted the trigger_id.
// Body: {"trigger_id", "view"}.
func (h *InteractionHandler) ViewsOpen(w http.ResponseWriter, r *http.Request) {
	h.appCall(w, r, "views.open", func(ctx context.Context, wh *model.IncomingWebhook, body []byte) (any, error) {
		var in struct {
			TriggerID string     `json:"trigger_id"`
			View      model.View `json:"view"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			return nil, apperr.Invalid("the body isn't a views.open request: %v", err)
		}
		view, err := h.svc.OpenView(ctx, wh, in.TriggerID, in.View)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "view": view}, nil
	})
}

// ViewsPush stacks a form on the one the person is in. Body:
// {"trigger_id" (from that form), "view"}.
func (h *InteractionHandler) ViewsPush(w http.ResponseWriter, r *http.Request) {
	h.appCall(w, r, "views.push", func(ctx context.Context, wh *model.IncomingWebhook, body []byte) (any, error) {
		var in struct {
			TriggerID string     `json:"trigger_id"`
			View      model.View `json:"view"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			return nil, apperr.Invalid("the body isn't a views.push request: %v", err)
		}
		view, err := h.svc.PushView(ctx, wh, in.TriggerID, in.View)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "view": view}, nil
	})
}

// ViewsUpdate changes an open form. Body: {"view_id" or "external_id",
// optional "hash", "view"}.
func (h *InteractionHandler) ViewsUpdate(w http.ResponseWriter, r *http.Request) {
	h.appCall(w, r, "views.update", func(ctx context.Context, wh *model.IncomingWebhook, body []byte) (any, error) {
		var in struct {
			ViewID     string     `json:"view_id"`
			ExternalID string     `json:"external_id"`
			Hash       string     `json:"hash"`
			View       model.View `json:"view"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			return nil, apperr.Invalid("the body isn't a views.update request: %v", err)
		}
		view, err := h.svc.UpdateView(ctx, wh, in.ViewID, in.ExternalID, in.Hash, in.View)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "view": view}, nil
	})
}

// MessagesUpdate replaces one of the app's messages. Body: {"channel_id",
// "message_id", "text"/"blocks"/"attachments", optional "if_version"}.
func (h *InteractionHandler) MessagesUpdate(w http.ResponseWriter, r *http.Request) {
	h.appCall(w, r, "messages.update", func(ctx context.Context, wh *model.IncomingWebhook, body []byte) (any, error) {
		var in service.MessageUpdate
		if err := json.Unmarshal(body, &in); err != nil {
			return nil, apperr.Invalid("the body isn't a messages.update request: %v", err)
		}
		msg, err := h.svc.UpdateMessage(ctx, wh, in)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "channel_id": msg.ParentID, "message_id": msg.ID, "version": msg.Version}, nil
	})
}

// appCall authenticates the app, reads its body (JSON, or a form whose
// JSON-valued fields — view, blocks, attachments — are JSON text), and runs
// the method at most once per Idempotency-Key.
func (h *InteractionHandler) appCall(w http.ResponseWriter, r *http.Request, method string, run func(context.Context, *model.IncomingWebhook, []byte) (any, error)) {
	ctx := r.Context()
	wh, err := h.svc.AuthenticateApp(ctx, bearerToken(r))
	if err != nil {
		writeAppError(w, r, err)
		return
	}
	body, err := readAppBody(r)
	if err != nil {
		writeAppError(w, r, apperr.Invalid("%s", err.Error()))
		return
	}
	answer, err := h.svc.Idempotent(ctx, wh, method, r.Header.Get("Idempotency-Key"), func() (any, error) {
		return run(ctx, wh, body)
	})
	if err != nil {
		writeAppError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(answer)
}

// readAppBody returns an app's request body as JSON, at most 1 MB.
func readAppBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxWebhookBodyBytes))
	if err != nil {
		return nil, errors.New("the body is larger than 1 MB")
	}
	if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/x-www-form-urlencoded" {
		return raw, nil
	}
	form, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, errors.New("the form body can't be read")
	}
	fields := map[string]json.RawMessage{}
	for k := range form {
		v := form.Get(k)
		if t := strings.TrimSpace(v); (strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[")) && json.Valid([]byte(t)) {
			fields[k] = json.RawMessage(t)
		} else if n, err := strconv.Atoi(v); err == nil && k == "if_version" {
			fields[k], _ = json.Marshal(n)
		} else {
			fields[k], _ = json.Marshal(v)
		}
	}
	return json.Marshal(fields)
}

// writeAppError answers an app in Slack's error shape; a rate limit also
// says when to try again.
func writeAppError(w http.ResponseWriter, r *http.Request, err error) {
	status, code := appError(err)
	if status == http.StatusInternalServerError {
		writeServiceError(w, r, err)
		return
	}
	var limited *service.RateLimitedError
	if errors.As(err, &limited) {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(limited.RetryAfter.Seconds()))))
	}
	writeJSON(w, status, map[string]any{"ok": false, "error": code, "message": err.Error()})
}

func appError(err error) (int, string) {
	for _, e := range []struct {
		kind   error
		status int
		code   string
	}{
		{service.ErrInvalidAuth, http.StatusUnauthorized, "invalid_auth"},
		{service.ErrAppRateLimited, http.StatusTooManyRequests, "ratelimited"},
		{service.ErrTriggerExpired, http.StatusBadRequest, "expired_trigger_id"},
		{service.ErrInvalidView, http.StatusBadRequest, "invalid_view"},
		{service.ErrInvalidBlocks, http.StatusBadRequest, "invalid_blocks"},
		{service.ErrViewNotFound, http.StatusNotFound, "view_not_found"},
		{service.ErrHashConflict, http.StatusConflict, "hash_conflict"},
		{service.ErrDuplicateExternalID, http.StatusConflict, "duplicate_external_id"},
		{service.ErrCantUpdateMessage, http.StatusForbidden, "cant_update_message"},
		{service.ErrAppVersionConflict, http.StatusConflict, "version_conflict"},
		{service.ErrAppUnavailable, http.StatusConflict, "app_unavailable"},
		{service.ErrIdempotencyInProgress, http.StatusConflict, "idempotency_in_progress"},
		{service.ErrPushNotAllowed, http.StatusBadRequest, "push_not_allowed"},
		{apperr.ErrNotFound, http.StatusNotFound, "message_not_found"},
		{apperr.ErrValidation, http.StatusBadRequest, "invalid_arguments"},
	} {
		if errors.Is(err, e.kind) {
			return e.status, e.code
		}
	}
	return http.StatusInternalServerError, ""
}

// ---- the person's side of a form

// SubmitView sends a person's form to its app. Body: {"values":
// {block_id: {action_id: <raw value>}}} — text as typed, a date as
// YYYY-MM-DD, a time as HH:MM, an option's value or a user ID; a list of
// them for multi-selects and checkboxes.
func (h *InteractionHandler) SubmitView(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Values map[string]map[string]service.RawValue `json:"values"`
	}
	if err := readJSONLimit(r, &body, maxFormBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	res, err := h.svc.SubmitView(r.Context(), middleware.UserIDFromContext(r.Context()), pathParam(r, "id"), body.Values)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// CloseView forgets a form its person closed. Body (optional): {"all":
// true} closes its whole stack; "values" is what was entered, for an app
// that asked to hear about closing.
func (h *InteractionHandler) CloseView(w http.ResponseWriter, r *http.Request) {
	var body struct {
		All    bool                                   `json:"all"`
		Values map[string]map[string]service.RawValue `json:"values"`
	}
	if r.ContentLength != 0 {
		if err := readJSONLimit(r, &body, maxFormBodyBytes); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
			return
		}
	}
	if err := h.svc.CloseView(r.Context(), middleware.UserIDFromContext(r.Context()), pathParam(r, "id"), body.All, body.Values); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ViewAction sends a change in a person's form to its app. Body:
// {"blockID", "actionID", "value" (string or list), "values" (the form as
// it stands, like a submission's)}.
func (h *InteractionHandler) ViewAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BlockID  string                                 `json:"blockID"`
		ActionID string                                 `json:"actionID"`
		Value    service.RawValue                       `json:"value"`
		Values   map[string]map[string]service.RawValue `json:"values"`
	}
	if err := readJSONLimit(r, &body, maxFormBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.BlockID == "" || body.ActionID == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "blockID and actionID are required")
		return
	}
	res, err := h.svc.ViewAction(r.Context(), middleware.UserIDFromContext(r.Context()), pathParam(r, "id"), body.BlockID, body.ActionID, body.Value, body.Values)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// PreviewView answers with a form as ex would draw it, for the webhooks
// panel's builder. Body: a view.
func (h *InteractionHandler) PreviewView(w http.ResponseWriter, r *http.Request) {
	var view model.View
	r.Body = http.MaxBytesReader(nil, r.Body, maxWebhookBodyBytes)
	if err := readJSON(r, &view); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	out, err := h.svc.PreviewView(r.Context(), webhookActor(r), view)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// maxFormBodyBytes bounds what a browser sends for a form or a pick: a full
// form of the largest fields (100 × 3,000 characters) fits within it.
const maxFormBodyBytes = 512 << 10

// clickIDPattern is a browser tab's click ID: short and plain, since it is
// echoed back in live events.
var clickIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
