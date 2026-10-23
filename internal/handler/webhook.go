package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

type WebhookHandler struct {
	svc *service.IncomingWebhookService
}

func NewWebhookHandler(svc *service.IncomingWebhookService) *WebhookHandler {
	return &WebhookHandler{svc: svc}
}

type webhookResponse struct {
	*model.IncomingWebhook
	URL string `json:"url,omitempty"`
}

func (h *WebhookHandler) List(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	items, err := h.svc.List(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	out := make([]webhookResponse, 0, len(items))
	for _, wh := range items {
		out = append(out, webhookResponse{IncomingWebhook: wh, URL: h.svc.URL(wh)})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *WebhookHandler) Create(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body model.IncomingWebhook
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	wh, err := h.svc.Create(r.Context(), middleware.UserIDFromContext(r.Context()), &body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, webhookResponse{IncomingWebhook: wh, URL: h.svc.URL(wh)})
}

func (h *WebhookHandler) Update(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body model.IncomingWebhook
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	wh, err := h.svc.Update(r.Context(), pathParam(r, "id"), &body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, webhookResponse{IncomingWebhook: wh, URL: h.svc.URL(wh)})
}

func (h *WebhookHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := pathParam(r, "id")
	if err := h.svc.Delete(r.Context(), id); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WebhookHandler) Execute(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	payload, err := readWebhookPayload(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	msg, err := h.svc.ExecuteMessage(r.Context(), id, payload)
	if err != nil {
		// This is an UNAUTHENTICATED ingress: internal error text never goes
		// to the caller — the table answers with fixed or user-facing texts
		// only (a retryable 503 for a throttled store), a generic 500 for the
		// rest. The log names the webhook by fingerprint: its id is the secret.
		slog.WarnContext(r.Context(), "webhook execute failed", "webhook", middleware.SecretFingerprint(id), "error", err)
		writeServiceError(w, r, err)
		return
	}
	// Mattermost-compatible callers get the plain "ok"; a caller that asks for
	// JSON gets the message id, which it can send back as root_id to reply in
	// this message's thread.
	if strings.Contains(strings.ToLower(r.Header.Get("Accept")), "application/json") {
		writeJSON(w, http.StatusOK, map[string]string{"id": msg.ID})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok"))
}

// maxWebhookBodyBytes caps the unauthenticated webhook ingress body so the JSON
// branch's io.ReadAll can't be used for a memory-exhaustion DoS (the form
// branch previously got Go's default 10 MiB cap, the JSON branch had none).
const maxWebhookBodyBytes int64 = 1 << 20 // 1 MiB

func readWebhookPayload(r *http.Request) (service.IncomingWebhookPayload, error) {
	var payload service.IncomingWebhookPayload
	r.Body = http.MaxBytesReader(nil, r.Body, maxWebhookBodyBytes)
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.Contains(ct, "application/x-www-form-urlencoded") || strings.Contains(ct, "multipart/form-data") {
		if err := r.ParseForm(); err != nil {
			return payload, err
		}
		raw := r.FormValue("payload")
		if raw == "" {
			payload.Text = r.FormValue("text")
			payload.Channel = r.FormValue("channel")
			payload.Username = r.FormValue("username")
			payload.IconURL = r.FormValue("icon_url")
			payload.RootID = r.FormValue("root_id")
			return payload, nil
		}
		raw = strings.TrimPrefix(raw, "payload=")
		err := json.Unmarshal([]byte(raw), &payload)
		return payload, err
	}
	raw, err := readBodyString(r)
	if err != nil {
		return payload, err
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "payload=") {
		raw = strings.TrimPrefix(raw, "payload=")
		if decoded, err := url.QueryUnescape(raw); err == nil {
			raw = decoded
		}
	}
	err = json.Unmarshal([]byte(raw), &payload)
	return payload, err
}

func readBodyString(r *http.Request) (string, error) {
	body, err := io.ReadAll(r.Body)
	return string(body), err
}
