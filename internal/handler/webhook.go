package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
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
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
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
		writeError(w, http.StatusBadRequest, "create_error", err.Error())
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
		if strings.Contains(err.Error(), store.ErrNotFound.Error()) {
			writeError(w, http.StatusNotFound, "not_found", "webhook not found")
			return
		}
		writeError(w, http.StatusBadRequest, "update_error", err.Error())
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
		writeError(w, http.StatusBadRequest, "delete_error", err.Error())
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
	if err := h.svc.Execute(r.Context(), id, payload); err != nil {
		if strings.Contains(err.Error(), "direct-message") {
			writeError(w, http.StatusBadRequest, "unsupported_channel", err.Error())
			return
		}
		if strings.Contains(err.Error(), store.ErrNotFound.Error()) {
			writeError(w, http.StatusNotFound, "not_found", "webhook or channel not found")
			return
		}
		writeError(w, http.StatusBadRequest, "webhook_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok"))
}

func readWebhookPayload(r *http.Request) (service.IncomingWebhookPayload, error) {
	var payload service.IncomingWebhookPayload
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
