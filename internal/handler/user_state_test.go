package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

func TestUserStateHandler_GetAndMutations(t *testing.T) {
	ctx := context.Background()
	stateStore := newMockUserStateStoreForHandler()
	stateSvc := service.NewUserStateService(stateStore, nil)
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	members := newDataMembershipStore()
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	msgSvc := service.NewMessageService(messages, members, convs, nil, broker)
	convSvc := service.NewConversationService(convs, users, nil, broker, nil)
	handler := NewUserStateHandler(stateSvc, msgSvc, convSvc)
	userID := "u-1"

	convs.conversations["conv-1"] = &model.Conversation{ID: "conv-1", ParticipantIDs: []string{userID, "u-2"}}
	members.memberships["ch-1#"+userID] = &model.ChannelMembership{ChannelID: "ch-1", UserID: userID}
	messages.messages["ch-1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch-1", AuthorID: "u-2", CreatedAt: time.Now()}
	if err := stateSvc.MarkChannelNotificationUnread(ctx, userID, "ch-1"); err != nil {
		t.Fatalf("MarkChannelNotificationUnread: %v", err)
	}

	req := userStateAuthedRequest(http.MethodGet, "/api/v1/user-state", nil, userID)
	rec := httptest.NewRecorder()
	handler.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("Get status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got model.UserState
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if len(got.ChannelNotifications) != 1 || got.ChannelNotifications[0] != "ch-1" {
		t.Fatalf("channel notifications = %#v", got.ChannelNotifications)
	}

	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/channels/ch-1/notification", nil, userID)
	req.SetPathValue("id", "ch-1")
	rec = httptest.NewRecorder()
	handler.ClearChannelNotification(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("ClearChannelNotification status = %d body=%s", rec.Code, rec.Body.String())
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch-1/root-1/seen", bytes.NewBufferString(`{"seenAt":"2026-05-04T10:00:00Z"}`), userID)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-1")
	req.SetPathValue("threadRootID", "root-1")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("MarkThreadSeen status = %d body=%s", rec.Code, rec.Body.String())
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/conversations/conv-1/root-2/seen", nil, userID)
	req.SetPathValue("parentType", "conversations")
	req.SetPathValue("parentID", "conv-1")
	req.SetPathValue("threadRootID", "root-2")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("MarkThreadSeen conversation status = %d body=%s", rec.Code, rec.Body.String())
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/conversations/conv-1/hidden", nil, userID)
	req.SetPathValue("id", "conv-1")
	rec = httptest.NewRecorder()
	handler.HideConversation(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("HideConversation status = %d body=%s", rec.Code, rec.Body.String())
	}
	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/conversations/conv-1/hidden", nil, userID)
	req.SetPathValue("id", "conv-1")
	rec = httptest.NewRecorder()
	handler.UnhideConversation(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("UnhideConversation status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserStateHandler_Errors(t *testing.T) {
	stateSvc := service.NewUserStateService(newMockUserStateStoreForHandler(), nil)
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	members := newDataMembershipStore()
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	msgSvc := service.NewMessageService(messages, members, convs, nil, broker)
	convSvc := service.NewConversationService(convs, users, nil, broker, nil)
	handler := NewUserStateHandler(stateSvc, msgSvc, convSvc)

	rec := httptest.NewRecorder()
	handler.Get(rec, httptest.NewRequest(http.MethodGet, "/api/v1/user-state", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Get unauth status = %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	handler.ClearChannelNotification(rec, userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/channels//notification", nil, "u-1"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ClearChannelNotification missing id status = %d", rec.Code)
	}

	req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/bogus/ch/root/seen", nil, "u-1")
	req.SetPathValue("parentType", "bogus")
	req.SetPathValue("parentID", "ch")
	req.SetPathValue("threadRootID", "root")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("MarkThreadSeen bad parent type status = %d", rec.Code)
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch/root/seen", bytes.NewBufferString(`{"seenAt":"bad"}`), "u-1")
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch")
	req.SetPathValue("threadRootID", "root")
	members.memberships["ch#u-1"] = &model.ChannelMembership{ChannelID: "ch", UserID: "u-1"}
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("MarkThreadSeen bad date status = %d", rec.Code)
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/conversations/conv-missing/hidden", nil, "u-1")
	req.SetPathValue("id", "conv-missing")
	rec = httptest.NewRecorder()
	handler.HideConversation(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("HideConversation missing status = %d", rec.Code)
	}

	stateStore := newMockUserStateStoreForHandler()
	stateStore.listErr = errors.New("list boom")
	handler = NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)
	rec = httptest.NewRecorder()
	handler.Get(rec, userStateAuthedRequest(http.MethodGet, "/api/v1/user-state", nil, "u-1"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("Get list error status = %d", rec.Code)
	}

	stateStore = newMockUserStateStoreForHandler()
	stateStore.deleteErr = errors.New("delete boom")
	handler = NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)
	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/channels/ch/notification", nil, "u-1")
	req.SetPathValue("id", "ch")
	rec = httptest.NewRecorder()
	handler.ClearChannelNotification(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("ClearChannelNotification delete error status = %d", rec.Code)
	}

	stateStore = newMockUserStateStoreForHandler()
	stateStore.setErr = errors.New("set boom")
	handler = NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)
	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/conversations/conv-err/hidden", nil, "u-1")
	req.SetPathValue("id", "conv-err")
	convs.conversations["conv-err"] = &model.Conversation{ID: "conv-err", ParticipantIDs: []string{"u-1"}}
	rec = httptest.NewRecorder()
	handler.HideConversation(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("HideConversation set error status = %d", rec.Code)
	}
}

func userStateAuthedRequest(method, target string, body io.Reader, userID string) *http.Request {
	if body == nil {
		body = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, body)
	req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: userID}))
	return req
}

type mockUserStateStoreForHandler struct {
	rows      map[string]*model.UserStateItem
	setErr    error
	deleteErr error
	listErr   error
}

func newMockUserStateStoreForHandler() *mockUserStateStoreForHandler {
	return &mockUserStateStoreForHandler{rows: map[string]*model.UserStateItem{}}
}

func (m *mockUserStateStoreForHandler) key(userID string, kind model.UserStateKind, targetID string) string {
	return userID + "#" + string(kind) + "#" + targetID
}

func (m *mockUserStateStoreForHandler) SetUserState(_ context.Context, item *model.UserStateItem) error {
	if m.setErr != nil {
		return m.setErr
	}
	cp := *item
	m.rows[m.key(item.UserID, item.Kind, item.TargetID)] = &cp
	return nil
}

func (m *mockUserStateStoreForHandler) DeleteUserState(_ context.Context, userID string, kind model.UserStateKind, targetID string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.rows, m.key(userID, kind, targetID))
	return nil
}

func (m *mockUserStateStoreForHandler) ListUserState(_ context.Context, userID string) ([]*model.UserStateItem, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	out := make([]*model.UserStateItem, 0)
	for _, row := range m.rows {
		if row.UserID != userID {
			continue
		}
		cp := *row
		out = append(out, &cp)
	}
	return out, nil
}
