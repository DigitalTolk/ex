package handler

import (
	"context"
	"encoding/json"
	"errors"
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
	getErr        error
	listErr       error
	lastReadErr   error
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
	if s.getErr != nil {
		return nil, s.getErr
	}
	conv, ok := s.conversations[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return conv, nil
}

func (s *dataConversationStore) ListUserConversations(_ context.Context, userID string) ([]*model.UserConversation, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
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

func (s *dataConversationStore) TouchConversation(_ context.Context, convID string, participantIDs []string, at time.Time) error {
	if conv, ok := s.conversations[convID]; ok {
		conv.UpdatedAt = at
	}
	for _, uid := range participantIDs {
		for _, uc := range s.userConvs[uid] {
			if uc.ConversationID == convID {
				uc.UpdatedAt = at
			}
		}
	}
	return nil
}

func (s *dataConversationStore) IncrementMessageSeq(_ context.Context, convID string) (int64, error) {
	conv, ok := s.conversations[convID]
	if !ok {
		return 0, store.ErrNotFound
	}
	conv.MessageSeq++
	return conv.MessageSeq, nil
}

func (s *dataConversationStore) SetConversationLastRead(_ context.Context, convID, userID string, seq int64) error {
	if s.lastReadErr != nil {
		return s.lastReadErr
	}
	for _, uc := range s.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.LastReadSeq = seq
			return nil
		}
	}
	return store.ErrNotFound
}

func (s *dataConversationStore) SetFavorite(_ context.Context, convID, userID string, favorite bool) error {
	for _, uc := range s.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.Favorite = favorite
			return nil
		}
	}
	return store.ErrNotFound
}

func (s *dataConversationStore) SetCategory(_ context.Context, convID, userID, categoryID string, sidebarPosition *int) error {
	for _, uc := range s.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.CategoryID = categoryID
			if sidebarPosition != nil {
				uc.SidebarPosition = *sidebarPosition
			}
			return nil
		}
	}
	return store.ErrNotFound
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
func (s *dataUserStoreForConv) NotificationSettingsFor(_ context.Context, userIDs []string) (map[string]model.NotificationSettings, error) {
	out := make(map[string]model.NotificationSettings)
	for _, uid := range userIDs {
		if u, ok := s.users[uid]; ok {
			if u.NotificationSettings != nil {
				out[uid] = *u.NotificationSettings
			} else {
				out[uid] = model.DefaultNotificationSettings()
			}
		}
	}
	return out, nil
}

type convHandlerEnv struct {
	handler  *ConversationHandler
	convs       *dataConversationStore
	users       *dataUserStoreForConv
	members     *dataMembershipStore
	messages    *dataMessageStore
	parentIndex *dataParentIndexStore
	jwtMgr      *auth.JWTManager
}

func setupConversationHandlerFull(t *testing.T) *convHandlerEnv {
	t.Helper()

	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	members := newDataMembershipStore()
	messages := newDataMessageStore()
	cache := newMockCache()
	broker := &mockBrokerForHandler{}
	parentIndex := newDataParentIndexStore()

	convSvc := service.NewConversationService(convs, users, cache, broker, nil)
	messageSvc := service.NewMessageService(messages, members, convs, nil, broker)
	messageSvc.SetParentIndex(newParentIndexAdapterFromBacking(parentIndex))
	jwtMgr := auth.NewJWTManager("test-conv-full-secret", 15*time.Minute, 720*time.Hour)

	h := NewConversationHandler(convSvc, messageSvc)
	return &convHandlerEnv{
		handler:     h,
		convs:       convs,
		users:       users,
		members:     members,
		messages:    messages,
		parentIndex: parentIndex,
		jwtMgr:      jwtMgr,
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

func TestConversationHandler_GetThread_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	ctx := middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: "u1"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/c-missing/messages/m1/thread", nil).WithContext(ctx)
	req.SetPathValue("id", "c-missing")
	req.SetPathValue("msgId", "m1")
	rec := httptest.NewRecorder()
	env.handler.GetThread(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403; body=%s", rec.Code, rec.Body.String())
	}
}

func TestConversationHandler_List_ServiceError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.listErr = errors.New("dynamo down")
	user := &model.User{ID: "u-le", Email: "le@x", SystemRole: model.SystemRoleMember}
	token, _ := env.jwtMgr.GenerateAccessToken(user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

func TestConversationHandler_SetNoUnfurl_MissingIDs(t *testing.T) {
	env := setupConversationHandlerFull(t)
	ctx := middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: "u1"})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations//messages//unfurl",
		strings.NewReader(`{"noUnfurl":true}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	env.handler.SetNoUnfurl(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
}

func TestConversationHandler_SetNoUnfurl_BadJSON(t *testing.T) {
	env := setupConversationHandlerFull(t)
	ctx := middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: "u1"})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/c1/messages/m1/unfurl",
		strings.NewReader(`{bad json`)).WithContext(ctx)
	req.SetPathValue("id", "c1")
	req.SetPathValue("msgId", "m1")
	rec := httptest.NewRecorder()
	env.handler.SetNoUnfurl(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestConversationHandler_SetNoUnfurl_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	ctx := middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: "u1"})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/c-missing/messages/m1/unfurl",
		strings.NewReader(`{"noUnfurl":true}`)).WithContext(ctx)
	req.SetPathValue("id", "c-missing")
	req.SetPathValue("msgId", "m1")
	rec := httptest.NewRecorder()
	env.handler.SetNoUnfurl(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403; body=%s", rec.Code, rec.Body.String())
	}
}

func TestConversationHandler_ListFiles_MissingID(t *testing.T) {
	env := setupConversationHandlerFull(t)
	ctx := middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: "u1"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations//files", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	env.handler.ListFiles(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
}

func TestConversationHandler_ListFiles_Forbidden(t *testing.T) {
	env := setupConversationHandlerFull(t)
	ctx := middleware.ContextWithClaims(context.Background(), &model.TokenClaims{UserID: "u1"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/c-missing/files", nil).WithContext(ctx)
	req.SetPathValue("id", "c-missing")
	rec := httptest.NewRecorder()
	env.handler.ListFiles(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403; body=%s", rec.Code, rec.Body.String())
	}
}

func TestConversationHandler_MarkRead_ClearsSharedUnread(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{
		ID:         "u-read",
		Email:      "read@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token, _ := env.jwtMgr.GenerateAccessToken(user)
	env.convs.conversations["conv-read"] = &model.Conversation{
		ID:             "conv-read",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-read", "u-other"},
		Activated:      true,
	}
	env.convs.conversations["conv-read"].MessageSeq = 3
	env.convs.userConvs["u-read"] = []*model.UserConversation{{
		UserID:         "u-read",
		ConversationID: "conv-read",
		Type:           model.ConversationTypeDM,
		DisplayName:    "Other",
		Activated:      true,
	}}

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.MarkRead))
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/conv-read/read", nil)
	req.SetPathValue("id", "conv-read")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	// Read catches the user up to the conversation's current MessageSeq.
	if got := env.convs.userConvs["u-read"][0].LastReadSeq; got != 3 {
		t.Fatalf("LastReadSeq = %d, want 3 (caught up)", got)
	}
}

func TestConversationHandler_MarkRead_Errors(t *testing.T) {
	env := setupConversationHandlerFull(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/conv/read", nil)
	req.SetPathValue("id", "conv")
	rec := httptest.NewRecorder()
	env.handler.MarkRead(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	user := &model.User{ID: "u-read", Email: "read@example.com", SystemRole: model.SystemRoleMember}
	token, _ := env.jwtMgr.GenerateAccessToken(user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.MarkRead))

	req = httptest.NewRequest(http.MethodPut, "/api/v1/conversations//read", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing id status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/conversations/missing/read", nil)
	req.SetPathValue("id", "missing")
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing conversation status = %d, want %d", rec.Code, http.StatusNotFound)
	}

	env.convs.conversations["conv-read"] = &model.Conversation{
		ID:             "conv-read",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-read"},
		Activated:      true,
	}
	env.convs.userConvs["u-read"] = []*model.UserConversation{{
		UserID:         "u-read",
		ConversationID: "conv-read",
		Type:           model.ConversationTypeDM,
		DisplayName:    "Self",
		Activated:      true,
	}}
	env.convs.lastReadErr = errors.New("dynamo down")
	req = httptest.NewRequest(http.MethodPut, "/api/v1/conversations/conv-read/read", nil)
	req.SetPathValue("id", "conv-read")
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("read error status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestConversationHandler_List_IncludesSharedUnread(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-list", Email: "list@example.com", SystemRole: model.SystemRoleMember}
	token, _ := env.jwtMgr.GenerateAccessToken(user)
	env.convs.conversations["conv-unread"] = &model.Conversation{
		ID:             "conv-unread",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-list", "u-other"},
		Activated:      true,
		MessageSeq:     1,
	}
	env.convs.userConvs["u-list"] = []*model.UserConversation{{
		UserID:         "u-list",
		ConversationID: "conv-unread",
		Type:           model.ConversationTypeDM,
		DisplayName:    "Unread",
		Activated:      true,
	}}

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.List))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got []model.UserConversation
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 1 || !got[0].Unread {
		t.Fatalf("unread conversation missing from response: %+v", got)
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

func TestConvHandlerFull_CreateSelfDM(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-solo"] = &model.User{ID: "u-solo", Email: "solo@test.com", DisplayName: "Solo"}
	user := &model.User{ID: "u-solo", Email: "solo@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	// participantIDs == [self] → personal-notepad self-DM.
	body := `{"type":"dm","participantIDs":["u-solo"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("self-DM status = %d; body: %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateGroup_SingleOtherBecomesDM(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-x"] = &model.User{ID: "u-x", Email: "x@test.com", DisplayName: "X"}
	env.users.users["u-y"] = &model.User{ID: "u-y", Email: "y@test.com", DisplayName: "Y"}
	user := &model.User{ID: "u-x", Email: "x@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	// A "group" with exactly one other participant collapses to a DM.
	body := `{"type":"group","participantIDs":["u-y"],"name":"ignored"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("group→DM status = %d; body: %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateGroup_SelfOnlyBecomesSelfDM(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-s"] = &model.User{ID: "u-s", Email: "s@test.com", DisplayName: "S"}
	user := &model.User{ID: "u-s", Email: "s@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	// A "group" whose only participant is the caller collapses to a self-DM.
	body := `{"type":"group","participantIDs":["u-s"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("group self-only status = %d; body: %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateDM_ServiceError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-real"] = &model.User{ID: "u-real", Email: "real@test.com", DisplayName: "Real"}
	user := &model.User{ID: "u-real", Email: "real@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	// DM with a participant that doesn't exist → service rejects → dm_error.
	body := `{"type":"dm","participantIDs":["u-ghost"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("dm service-error status = %d; body: %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandlerFull_CreateGroup_ServiceError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.users.users["u-creator"] = &model.User{ID: "u-creator", Email: "c@test.com", DisplayName: "C"}
	user := &model.User{ID: "u-creator", Email: "c@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	// Group with ghost participants → GetOrCreateGroup rejects → group_error.
	body := `{"type":"group","participantIDs":["u-ghost1","u-ghost2"],"name":"Ghosts"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("group service-error status = %d; body: %s", rec.Code, rec.Body.String())
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

func TestConvHandlerFull_SendMessage_ClearsDraftByScope(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["conv-msg"] = &model.Conversation{
		ID: "conv-msg", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-sender", "u-receiver"},
	}
	fake := &fakeDraftClearer{done: make(chan struct{}, 1)}
	env.handler.SetDraftClearer(fake)
	user := &model.User{ID: "u-sender", Email: "sender@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	h := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv-msg/messages", strings.NewReader(`{"body":"hi","clientTs":99}`))
	req.SetPathValue("id", "conv-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	fake.waitForCall(t)
	if len(fake.calls) != 1 || fake.calls[0] != (draftClearCall{"u-sender", "conv-msg", service.ParentConversation, "", 99}) {
		t.Fatalf("clear call = %+v", fake.calls)
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
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestConversationHandler_Get_ServerError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.getErr = errors.New("dynamodb unavailable")
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Get))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/c-err", nil)
	req.SetPathValue("id", "c-err")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusInternalServerError, rec.Body.String())
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

func TestConvHandlerFull_ListFiles(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-files", Email: "f@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	env.convs.conversations["conv-files"] = &model.Conversation{
		ID:             "conv-files",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-files", "other"},
	}
	now := time.Now()
	env.messages.messages["conv-files#m-1"] = &model.Message{
		ID: "m-1", ParentID: "conv-files", AuthorID: "u-files",
		AttachmentIDs: []string{"a-1"}, CreatedAt: now,
	}
	// Mirror the production write: Send populates the FILE# index.
	// ListFiles reads exclusively from there.
	_ = env.parentIndex.SetFileIndex(context.Background(), "conv-files", "a-1", "m-1", "u-files", now)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListFiles))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/conv-files/files", nil)
	req.SetPathValue("id", "conv-files")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"a-1"`) {
		t.Errorf("body missing attachment id; got %s", rec.Body.String())
	}
}

func TestConvHandlerFull_ListFiles_MissingID(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u", Email: "u@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListFiles))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conversations//files", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestChannelHandlerFull_ListFiles_MissingID(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u", Email: "u@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListFiles))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels//files", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestChannelHandlerFull_ListFiles_NotMember(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "stranger", Email: "s@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListFiles))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/private/files", nil)
	req.SetPathValue("id", "private")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestConvHandlerFull_SetNoUnfurl(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u-nu", Email: "n@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	env.convs.conversations["conv-nu"] = &model.Conversation{
		ID: "conv-nu", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-nu", "other"},
	}
	env.messages.messages["conv-nu#m-1"] = &model.Message{
		ID: "m-1", ParentID: "conv-nu", AuthorID: "u-nu", Body: "see https://x",
	}
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetNoUnfurl))
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations/conv-nu/messages/m-1/no-unfurl",
		strings.NewReader(`{"noUnfurl": true}`))
	req.SetPathValue("id", "conv-nu")
	req.SetPathValue("msgId", "m-1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !env.messages.messages["conv-nu#m-1"].NoUnfurl {
		t.Error("expected NoUnfurl=true after handler call")
	}
}

func TestConvHandlerFull_SetNoUnfurl_MissingIDs(t *testing.T) {
	env := setupConversationHandlerFull(t)
	user := &model.User{ID: "u", Email: "u@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SetNoUnfurl))
	req := httptest.NewRequest(http.MethodPut, "/api/v1/conversations//messages//no-unfurl",
		strings.NewReader(`{"noUnfurl": true}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
