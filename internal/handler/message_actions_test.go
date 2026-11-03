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

func asUser(r *http.Request, userID string, role model.SystemRole) *http.Request {
	return r.WithContext(middleware.ContextWithClaims(r.Context(), &model.TokenClaims{UserID: userID, SystemRole: role}))
}

func clickRequest(t *testing.T, parentID, msgID, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/"+parentID+"/messages/"+msgID+"/actions", strings.NewReader(body))
	req.SetPathValue("id", parentID)
	req.SetPathValue("msgId", msgID)
	return asUser(req, "u-1", model.SystemRoleMember)
}

func ackCard(parentID string) *model.Message {
	return &model.Message{ID: "m1", ParentID: parentID, AuthorID: service.WebhookAuthorID, Body: "card", Blocks: model.Blocks{
		{Type: model.BlockActions, BlockID: "row", Elements: []model.BlockElement{
			{Type: model.ElementButton, ActionID: "ack", ExAction: model.ExActionAck, Text: &model.TextObject{Type: model.TextPlain, Text: "Ack"}},
			{Type: model.ElementButton, ActionID: "app", Text: &model.TextObject{Type: model.TextPlain, Text: "App"}},
		}},
	}}
}

func TestChannelHandler_Act(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-a#u-1"] = &model.ChannelMembership{ChannelID: "ch-a", UserID: "u-1", Role: model.ChannelRoleMember}
	env.messages.messages["ch-a#m1"] = ackCard("ch-a")

	rec := httptest.NewRecorder()
	env.handler.Act(rec, clickRequest(t, "ch-a", "m1", `{"blockID":"row","actionID":"ack"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("ack: %d %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Message model.Message `json:"message"`
		Notice  string        `json:"notice"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil || len(res.Message.ActionTallies) != 1 || res.Message.ActionTallies[0].UserIDs[0] != "u-1" || res.Notice != "" {
		t.Fatalf("ack result: %#v %v", res, err)
	}

	// An app button without an app: a 409 the client shows as a notice.
	rec = httptest.NewRecorder()
	env.handler.Act(rec, clickRequest(t, "ch-a", "m1", `{"blockID":"row","actionID":"app"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"app_not_set_up"`) {
		t.Fatalf("app button: %d %s", rec.Code, rec.Body.String())
	}
	// A button no longer on the card.
	rec = httptest.NewRecorder()
	env.handler.Act(rec, clickRequest(t, "ch-a", "m1", `{"blockID":"row","actionID":"gone"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"card_changed"`) {
		t.Fatalf("changed card: %d %s", rec.Code, rec.Body.String())
	}
}

func TestChannelHandler_ActBadRequests(t *testing.T) {
	env := setupChannelHandlerFull(t)
	for _, c := range []struct{ parent, msg, body string }{
		{"", "m1", `{"blockID":"b","actionID":"a"}`},
		{"ch", "", `{"blockID":"b","actionID":"a"}`},
		{"ch", "m1", `{`},
		{"ch", "m1", `{"blockID":"b"}`},
		{"ch", "m1", `{"actionID":"a"}`},
	} {
		rec := httptest.NewRecorder()
		env.handler.Act(rec, clickRequest(t, c.parent, c.msg, c.body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%+v: status %d", c, rec.Code)
		}
	}
}

func TestConversationHandler_Act(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	env.messages.messages["dm-1#m1"] = ackCard("dm-1")
	rec := httptest.NewRecorder()
	env.handler.Act(rec, clickRequest(t, "dm-1", "m1", `{"blockID":"row","actionID":"ack"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("conversation ack: %d %s", rec.Code, rec.Body.String())
	}
	// Someone outside the conversation can't click.
	other := httptest.NewRecorder()
	req := clickRequest(t, "dm-1", "m1", `{"blockID":"row","actionID":"ack"}`)
	env.handler.Act(other, asUser(req, "u-9", model.SystemRoleMember))
	if other.Code < 400 {
		t.Fatalf("outsider clicked: %d", other.Code)
	}
}

func TestWebhookHandler_Preview(t *testing.T) {
	general := &model.Channel{ID: "ch-general", Name: "General", Slug: "general"}
	channels := handlerWebhookChannels{byID: map[string]*model.Channel{general.ID: general}, bySlug: map[string]*model.Channel{general.Slug: general}}
	messages := &handlerWebhookMessageStore{messages: map[string]*model.Message{}}
	svc := service.NewIncomingWebhookService(&handlerWebhookStore{}, channels, service.NewMessageService(messages, nil, nil, nil, nil), handlerWebhookImageProxy{}, "")
	h := NewWebhookHandler(svc)
	preview := func(body string, role model.SystemRole) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/webhooks/preview", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.Preview(rec, asUser(req, "u-1", role))
		return rec
	}

	rec := preview(`{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"**hi**"}}]}`, model.SystemRoleMember)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"block_id":"b1"`) || !strings.Contains(rec.Body.String(), `"type":"markdown"`) {
		t.Fatalf("preview: %d %s", rec.Code, rec.Body.String())
	}
	if len(messages.messages) != 0 {
		t.Fatal("a preview posted")
	}
	if rec := preview(`{"blocks":[{"type":"header"}]}`, model.SystemRoleMember); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_blocks"`) {
		t.Fatalf("invalid blocks: %d %s", rec.Code, rec.Body.String())
	}
	if rec := preview(`{"blocks":[{"type":"actions","elements":[{"type":"button","text":"not an object"}]}]}`, model.SystemRoleMember); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_payload"`) {
		t.Fatalf("malformed payload: %d %s", rec.Code, rec.Body.String())
	}
	if rec := preview(`{"text":"hi"}`, model.SystemRoleGuest); rec.Code != http.StatusForbidden {
		t.Fatalf("guest preview: %d", rec.Code)
	}
}
