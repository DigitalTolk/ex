package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

func TestReadWebhookPayloadSupportsMattermostAndSlackForms(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/hooks/abc", strings.NewReader(`payload={"text":"hello","channel":"#general","type":"custom_x","props":{"ignored":true},"priority":{"priority":"important"}}`))
	req.Header.Set("Content-Type", "text/plain")
	payload, err := readWebhookPayload(req)
	if err != nil {
		t.Fatalf("readWebhookPayload: %v", err)
	}
	if payload.Text != "hello" || payload.Channel != "#general" {
		t.Fatalf("payload = %#v", payload)
	}

	req = httptest.NewRequest(http.MethodPost, "/hooks/abc", strings.NewReader(`payload=%7B%22text%22%3A%22form%22%7D`))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	payload, err = readWebhookPayload(req)
	if err != nil {
		t.Fatalf("read form payload: %v", err)
	}
	if payload.Text != "form" {
		t.Fatalf("form payload text = %q", payload.Text)
	}

	req = httptest.NewRequest(http.MethodPost, "/hooks/abc", strings.NewReader(`text=plain&channel=%23general&username=bot&icon_url=https%3A%2F%2Fcdn.example%2Fa.png`))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	payload, err = readWebhookPayload(req)
	if err != nil {
		t.Fatalf("read basic form payload: %v", err)
	}
	if payload.Text != "plain" || payload.Channel != "#general" || payload.Username != "bot" || payload.IconURL == "" {
		t.Fatalf("basic form payload = %#v", payload)
	}

	req = httptest.NewRequest(http.MethodPost, "/hooks/abc", strings.NewReader(`{"text":"json"}`))
	req.Header.Set("Content-Type", "application/json")
	payload, err = readWebhookPayload(req)
	if err != nil {
		t.Fatalf("read JSON payload: %v", err)
	}
	if payload.Text != "json" {
		t.Fatalf("JSON payload text = %q", payload.Text)
	}
}

func TestWebhookHandlerAdminCRUDAndExecute(t *testing.T) {
	ctx := context.Background()
	general := &model.Channel{ID: "ch-general", Name: "General", Slug: "general"}
	channels := handlerWebhookChannels{
		byID:   map[string]*model.Channel{general.ID: general},
		bySlug: map[string]*model.Channel{general.Slug: general},
	}
	webhooks := &handlerWebhookStore{}
	messages := &handlerWebhookMessageStore{messages: map[string]*model.Message{}}
	msgSvc := service.NewMessageService(messages, nil, nil, nil, nil)
	svc := service.NewIncomingWebhookService(webhooks, channels, msgSvc, handlerWebhookImageProxy{}, "https://chat.example")
	h := NewWebhookHandler(svc)

	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/webhooks", strings.NewReader(`{
		"title":"CI",
		"description":"Build notifications",
		"channelID":"ch-general",
		"username":"ci-bot",
		"profileImageURL":"https://cdn.example/avatar.png"
	}`))
	createReq = createReq.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	createRes := httptest.NewRecorder()
	h.Create(createRes, createReq)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("Create status = %d body=%s", createRes.Code, createRes.Body.String())
	}
	var created webhookResponse
	if err := json.Unmarshal(createRes.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.ID == "" || created.CreatedBy != "admin-1" || created.URL != "https://chat.example/hooks/"+created.ID {
		t.Fatalf("unexpected create response: %#v", created)
	}
	if created.ProfileImageURL != "proxied:https://cdn.example/avatar.png" {
		t.Fatalf("profile image URL = %q", created.ProfileImageURL)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/webhooks", nil)
	listReq = listReq.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	listRes := httptest.NewRecorder()
	h.List(listRes, listReq)
	if listRes.Code != http.StatusOK {
		t.Fatalf("List status = %d body=%s", listRes.Code, listRes.Body.String())
	}
	var listed []webhookResponse
	if err := json.Unmarshal(listRes.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("listed webhooks = %#v", listed)
	}

	executeReq := httptest.NewRequest(http.MethodPost, "/hooks/"+created.ID, strings.NewReader(`{
		"text":"deploy <https://example.com/build|build> <!channel>",
		"attachments":[{"title":"Result","text":"passed","image_url":"https://cdn.example/result.png"}],
		"type":"ignored",
		"props":{"ignored":true},
		"priority":{"priority":"important"}
	}`))
	executeReq.SetPathValue("id", created.ID)
	executeRes := httptest.NewRecorder()
	h.Execute(executeRes, executeReq)
	if executeRes.Code != http.StatusOK {
		t.Fatalf("Execute status = %d body=%s", executeRes.Code, executeRes.Body.String())
	}
	if executeRes.Body.String() != "ok" {
		t.Fatalf("Execute body = %q", executeRes.Body.String())
	}
	if len(messages.messages) != 1 {
		t.Fatalf("stored messages = %d", len(messages.messages))
	}
	for _, msg := range messages.messages {
		if msg.Body != "deploy [build](https://example.com/build) @all" {
			t.Fatalf("message body = %q", msg.Body)
		}
		if msg.WebhookUsername != "ci-bot" || msg.WebhookAvatarURL != "proxied:https://cdn.example/avatar.png" {
			t.Fatalf("message webhook identity = %#v", msg)
		}
		if len(msg.MessageAttachments) != 1 || msg.MessageAttachments[0].ImageURL != "proxied:https://cdn.example/result.png" {
			t.Fatalf("message attachments = %#v", msg.MessageAttachments)
		}
	}

	updateReq := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/webhooks/"+created.ID, strings.NewReader(`{
		"title":"CI Renamed",
		"channelID":"ch-general",
		"lockToChannel":true,
		"username":"ci-bot"
	}`))
	updateReq.SetPathValue("id", created.ID)
	updateReq = updateReq.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	updateRes := httptest.NewRecorder()
	h.Update(updateRes, updateReq)
	if updateRes.Code != http.StatusOK {
		t.Fatalf("Update status = %d body=%s", updateRes.Code, updateRes.Body.String())
	}
	var updated webhookResponse
	if err := json.Unmarshal(updateRes.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if updated.Title != "CI Renamed" || !updated.LockToChannel || updated.ID != created.ID {
		t.Fatalf("updated webhook = %#v", updated)
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/webhooks/"+created.ID, nil)
	deleteReq.SetPathValue("id", created.ID)
	deleteReq = deleteReq.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	deleteRes := httptest.NewRecorder()
	h.Delete(deleteRes, deleteReq)
	if deleteRes.Code != http.StatusNoContent {
		t.Fatalf("Delete status = %d body=%s", deleteRes.Code, deleteRes.Body.String())
	}
	if _, err := webhooks.Get(ctx, created.ID); !strings.Contains(err.Error(), store.ErrNotFound.Error()) {
		t.Fatalf("Get after delete err = %v", err)
	}
}

func TestWebhookHandlerErrorPaths(t *testing.T) {
	ctx := context.Background()
	general := &model.Channel{ID: "ch-general", Name: "General", Slug: "general"}
	channels := handlerWebhookChannels{
		byID:   map[string]*model.Channel{general.ID: general},
		bySlug: map[string]*model.Channel{general.Slug: general},
	}
	webhooks := &handlerWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", Title: "CI", ChannelID: general.ID, ChannelName: general.Name, ChannelSlug: general.Slug, Username: "ci-bot"},
	}}
	messages := &handlerWebhookMessageStore{messages: map[string]*model.Message{}}
	msgSvc := service.NewMessageService(messages, nil, nil, nil, nil)
	h := NewWebhookHandler(service.NewIncomingWebhookService(webhooks, channels, msgSvc, nil, ""))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/webhooks", nil)
	res := httptest.NewRecorder()
	h.List(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("List without admin status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/webhooks", strings.NewReader(`{`))
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.Create(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Create invalid JSON status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/admin/webhooks/", nil)
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.Delete(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Delete missing id status = %d", res.Code)
	}

	// Update requires admin.
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/webhooks/wh", strings.NewReader(`{}`))
	req.SetPathValue("id", "wh")
	res = httptest.NewRecorder()
	h.Update(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("Update without admin status = %d", res.Code)
	}

	// Update rejects invalid JSON.
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/webhooks/wh", strings.NewReader(`{`))
	req.SetPathValue("id", "wh")
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.Update(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Update invalid JSON status = %d", res.Code)
	}

	// Update on a missing webhook is a 404.
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/webhooks/missing", strings.NewReader(`{"title":"x","channelID":"ch-general"}`))
	req.SetPathValue("id", "missing")
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.Update(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("Update missing webhook status = %d", res.Code)
	}

	// Update store failure surfaces as a 400.
	updateErrStore := &handlerWebhookStore{
		items:     map[string]*model.IncomingWebhook{"wh": {ID: "wh", Title: "CI", ChannelID: general.ID}},
		updateErr: assertErr("update failed"),
	}
	hUpd := NewWebhookHandler(service.NewIncomingWebhookService(updateErrStore, channels, msgSvc, nil, ""))
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/webhooks/wh", strings.NewReader(`{"title":"x","channelID":"ch-general"}`))
	req.SetPathValue("id", "wh")
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	hUpd.Update(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Update store error status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/hooks/wh", strings.NewReader(`{`))
	req.SetPathValue("id", "wh")
	res = httptest.NewRecorder()
	h.Execute(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Execute invalid payload status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/hooks/missing", strings.NewReader(`{"text":"hello"}`))
	req.SetPathValue("id", "missing")
	res = httptest.NewRecorder()
	h.Execute(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("Execute missing webhook status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/hooks/wh", strings.NewReader(`{"text":"hello","channel":"@alice"}`))
	req.SetPathValue("id", "wh")
	res = httptest.NewRecorder()
	h.Execute(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Execute DM override status = %d", res.Code)
	}

	errorStore := &handlerWebhookStore{listErr: assertErr("list failed"), createErr: assertErr("create failed"), deleteErr: assertErr("delete failed")}
	h = NewWebhookHandler(service.NewIncomingWebhookService(errorStore, channels, msgSvc, nil, ""))

	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/webhooks", nil)
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.List(res, req)
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("List service error status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/webhooks", strings.NewReader(`{"title":"CI","channelID":"ch-general"}`))
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.Create(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Create service error status = %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/admin/webhooks/wh", nil)
	req.SetPathValue("id", "wh")
	req = req.WithContext(middleware.ContextWithClaims(ctx, &model.TokenClaims{UserID: "admin-1", SystemRole: model.SystemRoleAdmin}))
	res = httptest.NewRecorder()
	h.Delete(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("Delete service error status = %d", res.Code)
	}
}

type handlerWebhookStore struct {
	items     map[string]*model.IncomingWebhook
	createErr error
	listErr   error
	updateErr error
	deleteErr error
}

func (s *handlerWebhookStore) Create(_ context.Context, wh *model.IncomingWebhook) error {
	if s.createErr != nil {
		return s.createErr
	}
	if s.items == nil {
		s.items = map[string]*model.IncomingWebhook{}
	}
	if _, exists := s.items[wh.ID]; exists {
		return store.ErrAlreadyExists
	}
	cp := *wh
	s.items[wh.ID] = &cp
	return nil
}

func (s *handlerWebhookStore) Get(_ context.Context, id string) (*model.IncomingWebhook, error) {
	if wh, ok := s.items[id]; ok {
		cp := *wh
		return &cp, nil
	}
	return nil, store.ErrNotFound
}

func (s *handlerWebhookStore) List(context.Context) ([]*model.IncomingWebhook, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	out := make([]*model.IncomingWebhook, 0, len(s.items))
	for _, wh := range s.items {
		cp := *wh
		out = append(out, &cp)
	}
	return out, nil
}

func (s *handlerWebhookStore) Update(_ context.Context, wh *model.IncomingWebhook) error {
	if s.updateErr != nil {
		return s.updateErr
	}
	if s.items == nil {
		s.items = map[string]*model.IncomingWebhook{}
	}
	cp := *wh
	s.items[wh.ID] = &cp
	return nil
}

func (s *handlerWebhookStore) Delete(_ context.Context, id string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.items, id)
	return nil
}

type assertErr string

func (e assertErr) Error() string { return string(e) }

type handlerWebhookChannels struct {
	byID   map[string]*model.Channel
	bySlug map[string]*model.Channel
}

func (c handlerWebhookChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	if ch, ok := c.byID[id]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

func (c handlerWebhookChannels) GetBySlug(_ context.Context, slug string) (*model.Channel, error) {
	if ch, ok := c.bySlug[slug]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

type handlerWebhookImageProxy struct{}

func (handlerWebhookImageProxy) ProxyImageURL(_ context.Context, rawURL string) string {
	return "proxied:" + rawURL
}

func (handlerWebhookImageProxy) ProxyImageWithSize(_ context.Context, rawURL string) (string, int, int) {
	return "proxied:" + rawURL, 0, 0
}

type handlerWebhookMessageStore struct {
	messages map[string]*model.Message
}

func (s *handlerWebhookMessageStore) CreateMessage(_ context.Context, msg *model.Message) error {
	cp := *msg
	s.messages[msg.ParentID+"#"+msg.ID] = &cp
	return nil
}

func (s *handlerWebhookMessageStore) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	msg, ok := s.messages[parentID+"#"+msgID]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *msg
	return &cp, nil
}

func (s *handlerWebhookMessageStore) UpdateMessage(_ context.Context, msg *model.Message) error {
	cp := *msg
	s.messages[msg.ParentID+"#"+msg.ID] = &cp
	return nil
}

func (s *handlerWebhookMessageStore) DeleteMessage(_ context.Context, parentID, msgID string) error {
	delete(s.messages, parentID+"#"+msgID)
	return nil
}

func (s *handlerWebhookMessageStore) ListMessages(_ context.Context, parentID string, _ string, _ int) ([]*model.Message, bool, error) {
	out := []*model.Message{}
	for _, msg := range s.messages {
		if msg.ParentID == parentID {
			cp := *msg
			out = append(out, &cp)
		}
	}
	return out, false, nil
}

func (s *handlerWebhookMessageStore) ListThreadReplies(_ context.Context, threadRootID string) ([]*model.Message, error) {
	out := []*model.Message{}
	for _, msg := range s.messages {
		if msg.ParentMessageID == threadRootID {
			cp := *msg
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *handlerWebhookMessageStore) ListMessagesAfter(ctx context.Context, parentID, _ string, limit int) ([]*model.Message, bool, error) {
	return s.ListMessages(ctx, parentID, "", limit)
}

func (s *handlerWebhookMessageStore) ListMessagesAround(ctx context.Context, parentID, _ string, _, _ int) ([]*model.Message, bool, bool, error) {
	msgs, _, err := s.ListMessages(ctx, parentID, "", 0)
	return msgs, false, false, err
}

func (s *handlerWebhookMessageStore) IncrementReplyMetadata(_ context.Context, parentID, msgID string, replyTime time.Time, replyAuthorID string) (*model.Message, error) {
	msg, ok := s.messages[parentID+"#"+msgID]
	if !ok {
		return nil, store.ErrNotFound
	}
	msg.ReplyCount++
	msg.LastReplyAt = &replyTime
	msg.RecentReplyAuthorIDs = []string{replyAuthorID}
	return msg, nil
}
