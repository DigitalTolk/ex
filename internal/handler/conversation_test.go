package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// dataConversationStore stores conversations. Used for handler integration tests.
type dataConversationStore struct {
	conversations map[string]*model.Conversation
	userConvs     map[string][]*model.UserConversation
}

func newDataConversationStore() *dataConversationStore {
	return &dataConversationStore{
		conversations: make(map[string]*model.Conversation),
		userConvs:     make(map[string][]*model.UserConversation),
	}
}

func (s *dataConversationStore) CreateConversation(_ context.Context, conv *model.Conversation, userConvs []*model.UserConversation) error {
	if _, exists := s.conversations[conv.ID]; exists {
		return store.ErrAlreadyExists
	}
	s.conversations[conv.ID] = conv
	for _, uc := range userConvs {
		s.userConvs[uc.UserID] = append(s.userConvs[uc.UserID], uc)
	}
	return nil
}

func (s *dataConversationStore) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	conv, ok := s.conversations[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return conv, nil
}

func (s *dataConversationStore) ListUserConversations(_ context.Context, userID string) ([]*model.UserConversation, error) {
	return s.userConvs[userID], nil
}

func (s *dataConversationStore) ActivateConversation(_ context.Context, convID string, participantIDs []string) error {
	if conv, ok := s.conversations[convID]; ok {
		conv.Activated = true
	}
	for _, uid := range participantIDs {
		for _, uc := range s.userConvs[uid] {
			if uc.ConversationID == convID {
				uc.Activated = true
			}
		}
	}
	return nil
}

// dataUserStoreForConv stores users for conversation tests.
type dataUserStoreForConv struct {
	users      map[string]*model.User
	emailIndex map[string]*model.User
}

func newDataUserStoreForConv() *dataUserStoreForConv {
	return &dataUserStoreForConv{
		users:      make(map[string]*model.User),
		emailIndex: make(map[string]*model.User),
	}
}

func (s *dataUserStoreForConv) CreateUser(_ context.Context, u *model.User) error {
	s.users[u.ID] = u
	s.emailIndex[u.Email] = u
	return nil
}
func (s *dataUserStoreForConv) GetUser(_ context.Context, id string) (*model.User, error) {
	u, ok := s.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}
func (s *dataUserStoreForConv) GetUserByEmail(_ context.Context, email string) (*model.User, error) {
	u, ok := s.emailIndex[email]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}
func (s *dataUserStoreForConv) UpdateUser(_ context.Context, u *model.User) error {
	s.users[u.ID] = u
	s.emailIndex[u.Email] = u
	return nil
}
func (s *dataUserStoreForConv) ListUsers(_ context.Context, _ int, _ string) ([]*model.User, string, error) {
	return nil, "", nil
}
func (s *dataUserStoreForConv) HasUsers(_ context.Context) (bool, error) { return true, nil }

type convHandlerEnv struct {
	handler  *ConversationHandler
	convs    *dataConversationStore
	users    *dataUserStoreForConv
	members  *dataMembershipStore
	messages *dataMessageStore
	jwtMgr   *auth.JWTManager
}

func setupConversationHandlerFull(t *testing.T) *convHandlerEnv {
	t.Helper()

	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	members := newDataMembershipStore()
	messages := newDataMessageStore()
	cache := &mockCache{}
	broker := &mockBrokerForHandler{}

	convSvc := service.NewConversationService(convs, users, cache, broker, nil)
	messageSvc := service.NewMessageService(messages, members, convs, nil, broker)
	jwtMgr := auth.NewJWTManager("test-conv-full-secret", 15*time.Minute, 720*time.Hour)

	h := NewConversationHandler(convSvc, messageSvc)
	return &convHandlerEnv{
		handler:  h,
		convs:    convs,
		users:    users,
		members:  members,
		messages: messages,
		jwtMgr:   jwtMgr,
	}
}

// --- Simple handler tests ---

func setupConversationHandler(t *testing.T) (*ConversationHandler, *auth.JWTManager) {
	t.Helper()

	userStore := newMockUserStore()
	cache := &mockCache{}
	broker := &mockBrokerForHandler{}
	convMock := &dataConversationStore{
		conversations: make(map[string]*model.Conversation),
		userConvs:     make(map[string][]*model.UserConversation),
	}
	convSvc := service.NewConversationService(convMock, userStore, cache, broker, nil)
	messageSvc := service.NewMessageService(nil, &mockMembershipStore{}, convMock, nil, broker)

	jwtMgr := auth.NewJWTManager("test-conv-handler-secret", 15*time.Minute, 720*time.Hour)

	h := NewConversationHandler(convSvc, messageSvc)
	return h, jwtMgr
}

func TestConversationHandler_Create_Unauthenticated(t *testing.T) {
	h, _ := setupConversationHandler(t)

	body := `{"type":"dm","participantIDs":["u1"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.Create(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestConversationHandler_List_Unauthenticated(t *testing.T) {
	h, _ := setupConversationHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	rec := httptest.NewRecorder()

	h.List(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestConversationHandler_List_Authenticated(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)

	user := &model.User{
		ID:         "conv-user-1",
		Email:      "conv@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token, _ := jwtMgr.GenerateAccessToken(user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestConversationHandler_Get_MissingID(t *testing.T) {
	h, _ := setupConversationHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/", nil)
	rec := httptest.NewRecorder()

	h.Get(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_ListMessages_MissingID(t *testing.T) {
	h, _ := setupConversationHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations//messages", nil)
	rec := httptest.NewRecorder()

	h.ListMessages(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_SendMessage_MissingID(t *testing.T) {
	h, _ := setupConversationHandler(t)

	body := `{"body":"test"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations//messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.SendMessage(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_EditMessage_MissingIDs(t *testing.T) {
	h, _ := setupConversationHandler(t)

	body := `{"body":"edited"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations//messages/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.EditMessage(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_DeleteMessage_MissingIDs(t *testing.T) {
	h, _ := setupConversationHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations//messages/", nil)
	rec := httptest.NewRecorder()

	h.DeleteMessage(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_ToggleReaction_MissingIDs(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations//messages//reactions", strings.NewReader(`{"emoji":"👍"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ToggleReaction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_ToggleReaction_MissingEmoji(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/c/messages/m/reactions", strings.NewReader(`{}`))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ToggleReaction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConversationHandler_ToggleReaction_InvalidJSON(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/c/messages/m/reactions", strings.NewReader(`{`))
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ToggleReaction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_GetThread(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-thr"] = &model.Conversation{
		ID: "conv-thr", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-thr", "u-other"},
	}
	env.messages.messages["conv-thr#01-root"] = &model.Message{
		ID: "01-root", ParentID: "conv-thr", AuthorID: "u-thr", Body: "root",
	}
	env.messages.messages["conv-thr#02-r1"] = &model.Message{
		ID: "02-r1", ParentID: "conv-thr", AuthorID: "u-other", Body: "r1", ParentMessageID: "01-root",
	}

	user := &model.User{ID: "u-thr", Email: "thr@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.GetThread))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/conv-thr/messages/01-root/thread", nil)
	req.SetPathValue("id", "conv-thr")
	req.SetPathValue("msgId", "01-root")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestConversationHandler_GetThread_MissingIDs(t *testing.T) {
	h, _ := setupConversationHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations//messages//thread", nil)
	rec := httptest.NewRecorder()
	h.GetThread(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_ToggleReaction(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-r"] = &model.Conversation{
		ID: "conv-r", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-r", "u-z"},
	}
	env.messages.messages["conv-r#m-r"] = &model.Message{
		ID: "m-r", ParentID: "conv-r", AuthorID: "u-z", Body: "hi",
	}

	user := &model.User{ID: "u-r", Email: "r@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ToggleReaction))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv-r/messages/m-r/reactions", strings.NewReader(`{"emoji":"❤️"}`))
	req.SetPathValue("id", "conv-r")
	req.SetPathValue("msgId", "m-r")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	stored := env.messages.messages["conv-r#m-r"]
	if got := stored.Reactions["❤️"]; len(got) != 1 || got[0] != "u-r" {
		t.Errorf("Reactions[❤️] = %v, want [u-r]", got)
	}
}

// --- Full integration tests using data-backed mocks ---

func TestConvHandlerFull_CreateDM(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.users.users["u-a"] = &model.User{ID: "u-a", Email: "a@test.com", DisplayName: "User A"}
	env.users.users["u-b"] = &model.User{ID: "u-b", Email: "b@test.com", DisplayName: "User B"}

	user := &model.User{ID: "u-a", Email: "a@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"dm","participantIDs":["u-b"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateGroup(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.users.users["u-g1"] = &model.User{ID: "u-g1", Email: "g1@test.com", DisplayName: "G1"}
	env.users.users["u-g2"] = &model.User{ID: "u-g2", Email: "g2@test.com", DisplayName: "G2"}
	env.users.users["u-g3"] = &model.User{ID: "u-g3", Email: "g3@test.com", DisplayName: "G3"}

	user := &model.User{ID: "u-g1", Email: "g1@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"group","participantIDs":["u-g2","u-g3"],"name":"Test Group"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateInvalidType(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-inv", Email: "inv@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"invalid","participantIDs":["u-2"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_CreateDM_WrongParticipantCount(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-dm-err", Email: "dm-err@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	body := `{"type":"dm","participantIDs":["u-1","u-2"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_Get(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-get"] = &model.Conversation{
		ID:             "conv-get",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-get1", "u-get2"},
	}

	user := &model.User{ID: "u-get1", Email: "get1@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Get))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/conv-get", nil)
	req.SetPathValue("id", "conv-get")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestConvHandlerFull_SendMessage(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-msg"] = &model.Conversation{
		ID:             "conv-msg",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-sender", "u-receiver"},
	}

	user := &model.User{ID: "u-sender", Email: "sender@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	body := `{"body":"Hi from DM!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv-msg/messages", strings.NewReader(body))
	req.SetPathValue("id", "conv-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestConvHandlerFull_SendMessage_EmptyBody(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-sender2", Email: "sender2@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	body := `{"body":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv-msg/messages", strings.NewReader(body))
	req.SetPathValue("id", "conv-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_ListMessages(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-lm"] = &model.Conversation{
		ID:             "conv-lm",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-reader", "u-other"},
	}

	user := &model.User{ID: "u-reader", Email: "reader-c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListMessages))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/conv-lm/messages", nil)
	req.SetPathValue("id", "conv-lm")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["items"] == nil {
		t.Error("expected items in response")
	}
}

func TestConvHandlerFull_EditMessage(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-edit"] = &model.Conversation{
		ID:             "conv-edit",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-editor", "u-other"},
	}
	env.messages.messages["conv-edit#msg-ce1"] = &model.Message{
		ID:       "msg-ce1",
		ParentID: "conv-edit",
		AuthorID: "u-editor",
		Body:     "original msg",
	}

	user := &model.User{ID: "u-editor", Email: "editor-c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	body := `{"body":"edited msg"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/conv-edit/messages/msg-ce1", strings.NewReader(body))
	req.SetPathValue("id", "conv-edit")
	req.SetPathValue("msgId", "msg-ce1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestConvHandlerFull_EditMessage_EmptyBody(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-editor2", Email: "editor2-c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	body := `{"body":""}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/conv-edit/messages/msg-ce1", strings.NewReader(body))
	req.SetPathValue("id", "conv-edit")
	req.SetPathValue("msgId", "msg-ce1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_SendMessage_InvalidJSON(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-smjson", Email: "smjson-c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv-msg/messages", strings.NewReader("{bad"))
	req.SetPathValue("id", "conv-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_EditMessage_InvalidJSON(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-emjson", Email: "emjson-c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/conv-edit/messages/msg-ce1", strings.NewReader("{bad"))
	req.SetPathValue("id", "conv-edit")
	req.SetPathValue("msgId", "msg-ce1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_Create_InvalidJSON(t *testing.T) {
	env := setupConversationHandlerFull(t)

	user := &model.User{ID: "u-cjson", Email: "cjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader("{bad"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestConvHandlerFull_DeleteMessage(t *testing.T) {
	env := setupConversationHandlerFull(t)

	env.convs.conversations["conv-del"] = &model.Conversation{
		ID:             "conv-del",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-deleter", "u-other"},
	}
	env.messages.messages["conv-del#msg-cd1"] = &model.Message{
		ID:       "msg-cd1",
		ParentID: "conv-del",
		AuthorID: "u-deleter",
		Body:     "to delete",
	}

	user := &model.User{ID: "u-deleter", Email: "deleter-c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.DeleteMessage))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/conv-del/messages/msg-cd1", nil)
	req.SetPathValue("id", "conv-del")
	req.SetPathValue("msgId", "msg-cd1")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestConversationHandler_Get_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["c-priv"] = &model.Conversation{
		ID: "c-priv", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"someone-else"},
	}
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Get))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/c-priv", nil)
	req.SetPathValue("id", "c-priv")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestConversationHandler_DeleteMessage_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.DeleteMessage))
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/c/messages/m", nil)
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestConversationHandler_Create_BadJSON(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	user := &model.User{ID: "u", Email: "u@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(jwtMgr, user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Create))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}
