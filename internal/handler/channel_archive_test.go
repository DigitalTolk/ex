package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// archivedHandlerEnv: an archived channel "ch-ro" with an owner and a member,
// holding one message posted before it was archived.
func archivedHandlerEnv(t *testing.T) (*channelHandlerEnv, string) {
	t.Helper()
	env := setupChannelHandlerFull(t)
	env.handler.messageSvc.SetChannelReader(env.channels)
	env.channels.channels["ch-ro"] = &model.Channel{ID: "ch-ro", Name: "read-only", Slug: "read-only", Type: model.ChannelTypePublic}
	env.memberships.memberships["ch-ro#u-owner"] = &model.ChannelMembership{ChannelID: "ch-ro", UserID: "u-owner", Role: model.ChannelRoleOwner}
	env.memberships.memberships["ch-ro#u-mem"] = &model.ChannelMembership{ChannelID: "ch-ro", UserID: "u-mem", Role: model.ChannelRoleMember}
	msg, err := env.handler.messageSvc.Send(t.Context(), "u-owner", "ch-ro", service.ParentChannel, "history", "")
	if err != nil {
		t.Fatalf("seed message: %v", err)
	}
	env.channels.channels["ch-ro"].Archived = true
	return env, msg.ID
}

func serveAs(env *channelHandlerEnv, userID string, h http.HandlerFunc, method, target, body string, path map[string]string) *httptest.ResponseRecorder {
	token := makeTokenForUser(env.jwtMgr, &model.User{ID: userID, Email: userID + "@test.com", SystemRole: model.SystemRoleMember})
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range path {
		req.SetPathValue(k, v)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	middleware.Auth(env.jwtMgr)(h).ServeHTTP(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return body.Error.Code
}

// Every write into an archived channel answers 409 channel_archived, whichever
// error helper the route uses.
func TestChannelHandler_ArchivedChannelWritesAre409(t *testing.T) {
	env, msgID := archivedHandlerEnv(t)
	h := env.handler
	cases := []struct {
		name   string
		fn     http.HandlerFunc
		method string
		body   string
		path   map[string]string
	}{
		{"send", h.SendMessage, http.MethodPost, `{"body":"new"}`, map[string]string{"id": "ch-ro"}},
		{"delete", h.DeleteMessage, http.MethodDelete, ``, map[string]string{"id": "ch-ro", "msgId": msgID}},
		{"pin", h.SetPinned, http.MethodPut, `{"pinned":true}`, map[string]string{"id": "ch-ro", "msgId": msgID}},
		{"no-unfurl", h.SetNoUnfurl, http.MethodPut, `{"noUnfurl":true}`, map[string]string{"id": "ch-ro", "msgId": msgID}},
		{"add-member", h.AddMember, http.MethodPost, `{"userID":"u-new","role":"member"}`, map[string]string{"id": "ch-ro"}},
	}
	for _, c := range cases {
		rec := serveAs(env, "u-owner", c.fn, c.method, "/api/v1/channels/ch-ro", c.body, c.path)
		if rec.Code != http.StatusConflict || errorCode(t, rec) != "channel_archived" {
			t.Errorf("%s: status %d body %s, want 409 channel_archived", c.name, rec.Code, rec.Body.String())
		}
	}
	// Join of a non-member: the archived channel cannot be joined.
	rec := serveAs(env, "u-new", h.Join, http.MethodPost, "/api/v1/channels/ch-ro/join", ``, map[string]string{"id": "ch-ro"})
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "channel_archived" {
		t.Errorf("join: status %d body %s, want 409 channel_archived", rec.Code, rec.Body.String())
	}
}

func TestChannelHandler_Unarchive(t *testing.T) {
	env, _ := archivedHandlerEnv(t)

	missing := httptest.NewRecorder()
	env.handler.Unarchive(missing, httptest.NewRequest(http.MethodPost, "/api/v1/channels//unarchive", nil))
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing id: status %d, want 400", missing.Code)
	}

	denied := serveAs(env, "u-mem", env.handler.Unarchive, http.MethodPost, "/api/v1/channels/ch-ro/unarchive", ``, map[string]string{"id": "ch-ro"})
	if denied.Code != http.StatusForbidden || errorCode(t, denied) != "unarchive_error" {
		t.Fatalf("member unarchive: status %d body %s, want 403 unarchive_error", denied.Code, denied.Body.String())
	}

	ok := serveAs(env, "u-owner", env.handler.Unarchive, http.MethodPost, "/api/v1/channels/ch-ro/unarchive", ``, map[string]string{"id": "ch-ro"})
	if ok.Code != http.StatusNoContent {
		t.Fatalf("owner unarchive: status %d body %s, want 204", ok.Code, ok.Body.String())
	}
	if env.channels.channels["ch-ro"].Archived {
		t.Fatal("channel still archived")
	}
	// Writable again.
	send := serveAs(env, "u-owner", env.handler.SendMessage, http.MethodPost, "/api/v1/channels/ch-ro/messages", `{"body":"back"}`, map[string]string{"id": "ch-ro"})
	if send.Code != http.StatusCreated {
		t.Fatalf("send after unarchive: status %d body %s", send.Code, send.Body.String())
	}
}

func TestWebhookHandlerExecute_ArchivedChannelIs409(t *testing.T) {
	archived := &model.Channel{ID: "ch-old", Name: "Old", Slug: "old", Archived: true}
	channels := handlerWebhookChannels{
		byID:   map[string]*model.Channel{archived.ID: archived},
		bySlug: map[string]*model.Channel{archived.Slug: archived},
	}
	webhooks := &handlerWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", Title: "CI", ChannelID: archived.ID, LockToChannel: true},
	}}
	msgSvc := service.NewMessageService(&handlerWebhookMessageStore{messages: map[string]*model.Message{}}, nil, nil, nil, nil)
	h := NewWebhookHandler(service.NewIncomingWebhookService(webhooks, channels, msgSvc, nil, ""))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/wh", strings.NewReader(`{"text":"alert"}`))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "wh")
	res := httptest.NewRecorder()
	h.Execute(res, req)
	if res.Code != http.StatusConflict || !strings.Contains(res.Body.String(), "channel_archived") {
		t.Fatalf("Execute into archived channel: status %d body %s, want 409 channel_archived", res.Code, res.Body.String())
	}
}
