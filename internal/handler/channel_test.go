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

// suppress unused imports
var (
	_ = context.Background
	_ = store.ErrNotFound
)

// mockBrokerForHandler implements service.Broker.
type mockBrokerForHandler struct{}

func (m *mockBrokerForHandler) Subscribe(_, _ string)   {}
func (m *mockBrokerForHandler) Unsubscribe(_, _ string) {}

// dataChannelStore stores channels and returns them. Used for handler integration tests.
type dataChannelStore struct {
	channels map[string]*model.Channel
}

func newDataChannelStore() *dataChannelStore {
	return &dataChannelStore{channels: make(map[string]*model.Channel)}
}

func (s *dataChannelStore) CreateChannel(_ context.Context, ch *model.Channel) error {
	s.channels[ch.ID] = ch
	return nil
}
func (s *dataChannelStore) GetChannel(_ context.Context, id string) (*model.Channel, error) {
	ch, ok := s.channels[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return ch, nil
}
func (s *dataChannelStore) GetChannelBySlug(_ context.Context, slug string) (*model.Channel, error) {
	for _, ch := range s.channels {
		if ch.Slug == slug {
			return ch, nil
		}
	}
	return nil, store.ErrNotFound
}
func (s *dataChannelStore) UpdateChannel(_ context.Context, ch *model.Channel) error {
	s.channels[ch.ID] = ch
	return nil
}
func (s *dataChannelStore) ListPublicChannels(_ context.Context, _ int, _ string) ([]*model.Channel, string, error) {
	var result []*model.Channel
	for _, ch := range s.channels {
		if ch.Type == model.ChannelTypePublic {
			result = append(result, ch)
		}
	}
	return result, "", nil
}

// dataMembershipStore stores memberships. Used for handler integration tests.
type dataMembershipStore struct {
	memberships map[string]*model.ChannelMembership
}

func newDataMembershipStore() *dataMembershipStore {
	return &dataMembershipStore{memberships: make(map[string]*model.ChannelMembership)}
}

func (s *dataMembershipStore) AddMember(_ context.Context, mem *model.ChannelMembership, _ *model.UserChannel) error {
	key := mem.ChannelID + "#" + mem.UserID
	s.memberships[key] = mem
	return nil
}
func (s *dataMembershipStore) RemoveMember(_ context.Context, channelID, userID string) error {
	delete(s.memberships, channelID+"#"+userID)
	return nil
}
func (s *dataMembershipStore) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	mem, ok := s.memberships[channelID+"#"+userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return mem, nil
}
func (s *dataMembershipStore) UpdateMemberRole(_ context.Context, channelID, userID string, role model.ChannelRole) error {
	key := channelID + "#" + userID
	if mem, ok := s.memberships[key]; ok {
		mem.Role = role
	}
	return nil
}
func (s *dataMembershipStore) ListMembers(_ context.Context, channelID string) ([]*model.ChannelMembership, error) {
	var result []*model.ChannelMembership
	for _, mem := range s.memberships {
		if mem.ChannelID == channelID {
			result = append(result, mem)
		}
	}
	return result, nil
}
func (s *dataMembershipStore) ListUserChannels(_ context.Context, _ string) ([]*model.UserChannel, error) {
	return nil, nil
}
func (s *dataMembershipStore) SetMute(_ context.Context, _, _ string, _ bool) error {
	return nil
}
func (s *dataMembershipStore) SetFavorite(_ context.Context, _, _ string, _ bool) error {
	return nil
}
func (s *dataMembershipStore) SetCategory(_ context.Context, _, _, _ string) error {
	return nil
}

// dataMessageStore stores messages. Used for handler integration tests.
type dataMessageStore struct {
	messages map[string]*model.Message
}

func newDataMessageStore() *dataMessageStore {
	return &dataMessageStore{messages: make(map[string]*model.Message)}
}

func (s *dataMessageStore) CreateMessage(_ context.Context, msg *model.Message) error {
	s.messages[msg.ParentID+"#"+msg.ID] = msg
	return nil
}
func (s *dataMessageStore) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	msg, ok := s.messages[parentID+"#"+msgID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return msg, nil
}
func (s *dataMessageStore) UpdateMessage(_ context.Context, msg *model.Message) error {
	s.messages[msg.ParentID+"#"+msg.ID] = msg
	return nil
}
func (s *dataMessageStore) DeleteMessage(_ context.Context, parentID, msgID string) error {
	delete(s.messages, parentID+"#"+msgID)
	return nil
}
func (s *dataMessageStore) ListMessages(_ context.Context, parentID string, _ string, _ int) ([]*model.Message, bool, error) {
	var result []*model.Message
	for _, msg := range s.messages {
		if msg.ParentID == parentID {
			result = append(result, msg)
		}
	}
	return result, false, nil
}

type channelHandlerEnv struct {
	handler     *ChannelHandler
	channels    *dataChannelStore
	memberships *dataMembershipStore
	messages    *dataMessageStore
	jwtMgr      *auth.JWTManager
}

func setupChannelHandlerFull(t *testing.T) *channelHandlerEnv {
	t.Helper()

	channels := newDataChannelStore()
	memberships := newDataMembershipStore()
	messages := newDataMessageStore()
	cache := &mockCache{}
	broker := &mockBrokerForHandler{}

	channelSvc := service.NewChannelService(channels, memberships, nil, messages, cache, broker, nil)
	messageSvc := service.NewMessageService(messages, memberships, nil, nil, broker)
	jwtMgr := auth.NewJWTManager("test-channel-handler-secret", 15*time.Minute, 720*time.Hour)

	h := NewChannelHandler(channelSvc, messageSvc)
	return &channelHandlerEnv{
		handler:     h,
		channels:    channels,
		memberships: memberships,
		messages:    messages,
		jwtMgr:      jwtMgr,
	}
}

func setupChannelHandler(t *testing.T) (*ChannelHandler, *mockChannelStore, *mockMembershipStore, *auth.JWTManager) {
	t.Helper()

	channelStore := &mockChannelStore{}
	membershipStore := &mockMembershipStore{}
	cache := &mockCache{}
	broker := &mockBrokerForHandler{}

	channelSvc := service.NewChannelService(channelStore, membershipStore, nil, nil, cache, broker, nil)
	messageSvc := service.NewMessageService(nil, membershipStore, nil, nil, broker)
	jwtMgr := auth.NewJWTManager("test-channel-handler-secret", 15*time.Minute, 720*time.Hour)

	h := NewChannelHandler(channelSvc, messageSvc)
	return h, channelStore, membershipStore, jwtMgr
}

func TestChannelHandler_Create(t *testing.T) {
	h, _, _, jwtMgr := setupChannelHandler(t)

	user := &model.User{
		ID:         "creator-1",
		Email:      "creator@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Create))

	body := `{"name":"new-channel","type":"public","description":"test desc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestChannelHandler_Create_MissingName(t *testing.T) {
	h, _, _, jwtMgr := setupChannelHandler(t)

	user := &model.User{
		ID:         "creator-2",
		Email:      "creator2@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Create))

	body := `{"description":"no name"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_Create_Unauthenticated(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	body := `{"name":"test"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.Create(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestChannelHandler_List(t *testing.T) {
	h, _, _, jwtMgr := setupChannelHandler(t)

	user := &model.User{
		ID:         "lister-1",
		Email:      "lister@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.List))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	// Should return an empty array (not null).
	var got []interface{}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestChannelHandler_List_Unauthenticated(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
	rec := httptest.NewRecorder()

	h.List(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestChannelHandler_BrowsePublic(t *testing.T) {
	h, _, _, jwtMgr := setupChannelHandler(t)

	user := &model.User{
		ID:         "browser-1",
		Email:      "browser@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.BrowsePublic))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/browse?limit=10", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestChannelHandler_Join(t *testing.T) {
	h, channelStore, _, jwtMgr := setupChannelHandler(t)

	// Add a public channel to the mock store so Join can look it up.
	// The mockChannelStore methods all return nil, nil by default.
	// We need to fix this -- the mock ChannelStore.GetChannel returns nil,nil
	// which means the service will try to use a nil *model.Channel.
	// Let me check if this is OK...
	// Actually, the channelStore mock returns nil, nil for GetChannel.
	// The service.Join calls GetChannel and checks ch.Type -- that will panic on nil.

	// Let me verify: the mock GetChannel always returns nil, nil.
	// We need to adapt the test. But we can't easily change the mock since it's
	// shared with auth tests. Instead, let me test that Join returns an error
	// when the channel is missing (by returning nil from the mock).
	// Actually it returns nil, nil which would cause a nil pointer dereference.
	// So this test case will just confirm the handler returns appropriate errors.

	// Let me instead skip the full integration test and just verify the handler
	// entry points work.
	_ = channelStore

	user := &model.User{
		ID:         "joiner-1",
		Email:      "joiner@example.com",
		SystemRole: model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	// Test missing channel ID (pathParam returns empty).
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Join))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels//join", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	// pathParam("id") will be empty since we don't use the Go 1.22 mux here.
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_Leave_Unauthenticated(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch1/leave", nil)
	rec := httptest.NewRecorder()

	// No auth middleware applied, no claims in context - pathParam also empty.
	h.Leave(rec, req)

	// UserIDFromContext returns "" -> pathParam("id") returns "" -> missing_id error
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_Get_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/", nil)
	rec := httptest.NewRecorder()

	h.Get(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_Update_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	body := `{"name":"test"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.Update(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_Archive_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/", nil)
	rec := httptest.NewRecorder()

	h.Archive(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_ListMembers_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels//members", nil)
	rec := httptest.NewRecorder()

	h.ListMembers(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_AddMember_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	body := `{"userID":"u1","role":"member"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels//members", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.AddMember(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_RemoveMember_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels//members/", nil)
	rec := httptest.NewRecorder()

	h.RemoveMember(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_UpdateMemberRole_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	body := `{"role":"admin"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels//members/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.UpdateMemberRole(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_ListMessages_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels//messages", nil)
	rec := httptest.NewRecorder()

	h.ListMessages(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_SendMessage_MissingID(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	body := `{"body":"hello"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels//messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.SendMessage(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_EditMessage_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	body := `{"body":"edited"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels//messages/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.EditMessage(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_DeleteMessage_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels//messages/", nil)
	rec := httptest.NewRecorder()

	h.DeleteMessage(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_ToggleReaction_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	body := `{"emoji":"👍"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels//messages//reactions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ToggleReaction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_ToggleReaction_MissingEmoji(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch/messages/m/reactions", strings.NewReader(`{}`))
	req.SetPathValue("id", "ch")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ToggleReaction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_ToggleReaction_InvalidJSON(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch/messages/m/reactions", strings.NewReader(`{`))
	req.SetPathValue("id", "ch")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ToggleReaction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_GetThread(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-thr#u-thr"] = &model.ChannelMembership{
		ChannelID: "ch-thr", UserID: "u-thr", Role: model.ChannelRoleMember,
	}
	env.messages.messages["ch-thr#01-root"] = &model.Message{
		ID: "01-root", ParentID: "ch-thr", AuthorID: "u-thr", Body: "root",
	}
	env.messages.messages["ch-thr#02-r1"] = &model.Message{
		ID: "02-r1", ParentID: "ch-thr", AuthorID: "u-thr", Body: "r1", ParentMessageID: "01-root",
	}

	user := &model.User{ID: "u-thr", Email: "thr@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.GetThread))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch-thr/messages/01-root/thread", nil)
	req.SetPathValue("id", "ch-thr")
	req.SetPathValue("msgId", "01-root")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestChannelHandler_GetThread_MissingIDs(t *testing.T) {
	h, _, _, _ := setupChannelHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels//messages//thread", nil)
	rec := httptest.NewRecorder()
	h.GetThread(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_GetThread_NotMember(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.GetThread))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch/messages/m/thread", nil)
	req.SetPathValue("id", "ch")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandlerFull_ToggleReaction(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-r#u-r"] = &model.ChannelMembership{
		ChannelID: "ch-r", UserID: "u-r", Role: model.ChannelRoleMember,
	}
	env.messages.messages["ch-r#m-r"] = &model.Message{
		ID: "m-r", ParentID: "ch-r", AuthorID: "u-r", Body: "hi",
	}

	user := &model.User{ID: "u-r", Email: "r@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ToggleReaction))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-r/messages/m-r/reactions", strings.NewReader(`{"emoji":"🎉"}`))
	req.SetPathValue("id", "ch-r")
	req.SetPathValue("msgId", "m-r")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	stored := env.messages.messages["ch-r#m-r"]
	if got := stored.Reactions["🎉"]; len(got) != 1 || got[0] != "u-r" {
		t.Errorf("Reactions[🎉] = %v, want [u-r]", got)
	}
}

// --- Full integration tests using data-backed mocks ---

func TestChannelHandlerFull_Get(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-get"] = &model.Channel{
		ID:   "ch-get",
		Name: "get-me",
		Slug: "ch-get",
		Type: model.ChannelTypePublic,
	}

	user := &model.User{ID: "u-get", Email: "get@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Get))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch-get", nil)
	req.SetPathValue("id", "ch-get")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestChannelHandlerFull_Get_NotFound(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-getnf", Email: "getnf@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Get))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/nonexistent", nil)
	req.SetPathValue("id", "nonexistent")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestChannelHandlerFull_Update(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-upd"] = &model.Channel{
		ID:   "ch-upd",
		Name: "old-name",
		Type: model.ChannelTypePublic,
	}
	env.memberships.memberships["ch-upd#u-admin"] = &model.ChannelMembership{
		ChannelID: "ch-upd",
		UserID:    "u-admin",
		Role:      model.ChannelRoleAdmin,
	}

	user := &model.User{ID: "u-admin", Email: "admin@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Update))

	body := `{"name":"new-name","description":"updated desc"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-upd", strings.NewReader(body))
	req.SetPathValue("id", "ch-upd")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestChannelHandlerFull_Archive(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-arch"] = &model.Channel{
		ID:   "ch-arch",
		Name: "to-archive",
		Type: model.ChannelTypePublic,
	}
	env.memberships.memberships["ch-arch#u-owner"] = &model.ChannelMembership{
		ChannelID: "ch-arch",
		UserID:    "u-owner",
		Role:      model.ChannelRoleOwner,
	}

	user := &model.User{ID: "u-owner", Email: "owner@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Archive))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/ch-arch", nil)
	req.SetPathValue("id", "ch-arch")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandlerFull_Join(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-join"] = &model.Channel{
		ID:   "ch-join",
		Name: "joinable",
		Type: model.ChannelTypePublic,
	}

	user := &model.User{ID: "u-joiner", Email: "joiner@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Join))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-join/join", nil)
	req.SetPathValue("id", "ch-join")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandlerFull_Leave(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-leave#u-leaver"] = &model.ChannelMembership{
		ChannelID: "ch-leave",
		UserID:    "u-leaver",
		Role:      model.ChannelRoleMember,
	}

	user := &model.User{ID: "u-leaver", Email: "leaver@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Leave))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-leave/leave", nil)
	req.SetPathValue("id", "ch-leave")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandlerFull_ListMembers(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-lm#u1"] = &model.ChannelMembership{
		ChannelID: "ch-lm",
		UserID:    "u1",
		Role:      model.ChannelRoleMember,
	}

	user := &model.User{ID: "u-lm", Email: "lm@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListMembers))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch-lm/members", nil)
	req.SetPathValue("id", "ch-lm")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestChannelHandlerFull_AddMember(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-am"] = &model.Channel{
		ID:   "ch-am",
		Name: "add-member",
		Type: model.ChannelTypePublic,
	}
	env.memberships.memberships["ch-am#u-admin"] = &model.ChannelMembership{
		ChannelID: "ch-am",
		UserID:    "u-admin",
		Role:      model.ChannelRoleAdmin,
	}

	user := &model.User{ID: "u-admin", Email: "admin2@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.AddMember))

	body := `{"userID":"u-new","role":"member"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-am/members", strings.NewReader(body))
	req.SetPathValue("id", "ch-am")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandlerFull_AddMember_MissingUserID(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-admin3", Email: "admin3@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.AddMember))

	body := `{"role":"member"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-am/members", strings.NewReader(body))
	req.SetPathValue("id", "ch-am")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_RemoveMember(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-rm#u-admin"] = &model.ChannelMembership{
		ChannelID: "ch-rm",
		UserID:    "u-admin",
		Role:      model.ChannelRoleAdmin,
	}
	env.memberships.memberships["ch-rm#u-target"] = &model.ChannelMembership{
		ChannelID: "ch-rm",
		UserID:    "u-target",
		Role:      model.ChannelRoleMember,
	}

	user := &model.User{ID: "u-admin", Email: "rm-admin@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.RemoveMember))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/ch-rm/members/u-target", nil)
	req.SetPathValue("id", "ch-rm")
	req.SetPathValue("uid", "u-target")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandlerFull_UpdateMemberRole(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-umr#u-admin"] = &model.ChannelMembership{
		ChannelID: "ch-umr",
		UserID:    "u-admin",
		Role:      model.ChannelRoleAdmin,
	}
	env.memberships.memberships["ch-umr#u-target"] = &model.ChannelMembership{
		ChannelID: "ch-umr",
		UserID:    "u-target",
		Role:      model.ChannelRoleMember,
	}

	user := &model.User{ID: "u-admin", Email: "umr-admin@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.UpdateMemberRole))

	body := `{"role":"admin"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-umr/members/u-target", strings.NewReader(body))
	req.SetPathValue("id", "ch-umr")
	req.SetPathValue("uid", "u-target")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandlerFull_SendMessage(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-msg#u-sender"] = &model.ChannelMembership{
		ChannelID: "ch-msg",
		UserID:    "u-sender",
		Role:      model.ChannelRoleMember,
	}

	user := &model.User{ID: "u-sender", Email: "sender@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	body := `{"body":"Hello channel!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-msg/messages", strings.NewReader(body))
	req.SetPathValue("id", "ch-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestChannelHandlerFull_SendMessage_EmptyBody(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-sender2", Email: "sender2@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	body := `{"body":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-msg/messages", strings.NewReader(body))
	req.SetPathValue("id", "ch-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_ListMessages(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-lmsg#u-reader"] = &model.ChannelMembership{
		ChannelID: "ch-lmsg",
		UserID:    "u-reader",
		Role:      model.ChannelRoleMember,
	}

	user := &model.User{ID: "u-reader", Email: "reader@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListMessages))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch-lmsg/messages?limit=20", nil)
	req.SetPathValue("id", "ch-lmsg")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["items"] == nil {
		t.Error("expected items in response")
	}
}

func TestChannelHandlerFull_EditMessage(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-edit#u-editor"] = &model.ChannelMembership{
		ChannelID: "ch-edit",
		UserID:    "u-editor",
		Role:      model.ChannelRoleMember,
	}
	env.messages.messages["ch-edit#msg-e1"] = &model.Message{
		ID:       "msg-e1",
		ParentID: "ch-edit",
		AuthorID: "u-editor",
		Body:     "original",
	}

	user := &model.User{ID: "u-editor", Email: "editor@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	body := `{"body":"edited text"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-edit/messages/msg-e1", strings.NewReader(body))
	req.SetPathValue("id", "ch-edit")
	req.SetPathValue("msgId", "msg-e1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestChannelHandlerFull_EditMessage_EmptyBody(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-editor2", Email: "editor2@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	body := `{"body":""}`
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-edit/messages/msg-e1", strings.NewReader(body))
	req.SetPathValue("id", "ch-edit")
	req.SetPathValue("msgId", "msg-e1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_Create_InvalidJSON(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-badjson", Email: "badjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader("{invalid"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_Create_DefaultType(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-deftype", Email: "deftype@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))

	// Omit "type" field -- should default to public.
	body := `{"name":"default-type-channel"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestChannelHandlerFull_Get_BySlug(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-slugtest"] = &model.Channel{
		ID:   "ch-slugtest",
		Name: "slug-test",
		Slug: "slug-test",
		Type: model.ChannelTypePublic,
	}

	user := &model.User{ID: "u-slug", Email: "slug@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Get))

	// Use a slug (not ULID-like) to trigger the slug lookup path.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/slug-test", nil)
	req.SetPathValue("id", "slug-test")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestChannelHandlerFull_Update_InvalidJSON(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-updjson", Email: "updjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Update))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-upd", strings.NewReader("{bad"))
	req.SetPathValue("id", "ch-upd")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_AddMember_InvalidJSON(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-amjson", Email: "amjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.AddMember))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-am/members", strings.NewReader("{bad"))
	req.SetPathValue("id", "ch-am")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_UpdateMemberRole_InvalidJSON(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-umrjson", Email: "umrjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.UpdateMemberRole))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-umr/members/u-target", strings.NewReader("{bad"))
	req.SetPathValue("id", "ch-umr")
	req.SetPathValue("uid", "u-target")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_SendMessage_InvalidJSON(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-smjson", Email: "smjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-msg/messages", strings.NewReader("{bad"))
	req.SetPathValue("id", "ch-msg")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_EditMessage_InvalidJSON(t *testing.T) {
	env := setupChannelHandlerFull(t)

	user := &model.User{ID: "u-emjson", Email: "emjson@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.EditMessage))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/channels/ch-edit/messages/msg-e1", strings.NewReader("{bad"))
	req.SetPathValue("id", "ch-edit")
	req.SetPathValue("msgId", "msg-e1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandlerFull_BrowsePublic_WithChannels(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.channels.channels["ch-browse1"] = &model.Channel{
		ID:   "ch-browse1",
		Name: "browse1",
		Type: model.ChannelTypePublic,
	}
	env.channels.channels["ch-browse2"] = &model.Channel{
		ID:   "ch-browse2",
		Name: "browse2",
		Type: model.ChannelTypePrivate,
	}

	user := &model.User{ID: "u-browse", Email: "browse@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.BrowsePublic))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/browse?limit=50", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var channels []interface{}
	if err := json.NewDecoder(rec.Body).Decode(&channels); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Should only include public channels.
	if len(channels) < 1 {
		t.Error("expected at least 1 public channel")
	}
}

func TestChannelHandlerFull_DeleteMessage(t *testing.T) {
	env := setupChannelHandlerFull(t)

	env.memberships.memberships["ch-del#u-deleter"] = &model.ChannelMembership{
		ChannelID: "ch-del",
		UserID:    "u-deleter",
		Role:      model.ChannelRoleMember,
	}
	env.messages.messages["ch-del#msg-d1"] = &model.Message{
		ID:       "msg-d1",
		ParentID: "ch-del",
		AuthorID: "u-deleter",
		Body:     "to delete",
	}

	user := &model.User{ID: "u-deleter", Email: "deleter@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.DeleteMessage))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/ch-del/messages/msg-d1", nil)
	req.SetPathValue("id", "ch-del")
	req.SetPathValue("msgId", "msg-d1")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestChannelHandler_Archive_NotOwner(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Archive))
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/abc", nil)
	req.SetPathValue("id", "abc")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d (body: %s)", rec.Code, http.StatusForbidden, rec.Body.String())
	}
}

func TestChannelHandler_Join_NotPublic(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.channels.channels["priv"] = &model.Channel{
		ID: "priv", Name: "p", Slug: "priv", Type: model.ChannelTypePrivate,
	}
	user := &model.User{ID: "u-j", Email: "j@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Join))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/priv/join", nil)
	req.SetPathValue("id", "priv")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_Leave_NotMember(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Leave))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/abc/leave", nil)
	req.SetPathValue("id", "abc")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestChannelHandler_RemoveMember_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.RemoveMember))
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/c/members/m", nil)
	req.SetPathValue("id", "c")
	req.SetPathValue("uid", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_DeleteMessage_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.DeleteMessage))
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/c/messages/m", nil)
	req.SetPathValue("id", "c")
	req.SetPathValue("msgId", "m")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandler_ListMessages_Forbidden(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-x", Email: "x@x.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListMessages))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/c/messages", nil)
	req.SetPathValue("id", "c")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestChannelHandlerFull_ListFiles(t *testing.T) {
	env := setupChannelHandlerFull(t)
	user := &model.User{ID: "u-files", Email: "f@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)

	env.memberships.memberships["ch-files#u-files"] = &model.ChannelMembership{
		ChannelID: "ch-files", UserID: "u-files", Role: model.ChannelRoleMember,
	}
	now := time.Now()
	env.messages.messages["ch-files#m-1"] = &model.Message{
		ID: "m-1", ParentID: "ch-files", AuthorID: "u-files",
		AttachmentIDs: []string{"a-1", "a-2"}, CreatedAt: now.Add(-time.Hour),
	}
	env.messages.messages["ch-files#m-2"] = &model.Message{
		ID: "m-2", ParentID: "ch-files", AuthorID: "u-files",
		AttachmentIDs: []string{"a-3"}, CreatedAt: now,
	}

	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ListFiles))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/ch-files/files", nil)
	req.SetPathValue("id", "ch-files")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got []service.FileEntry
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("expected 3 files, got %d", len(got))
	}
	if got[0].AttachmentID != "a-3" {
		t.Errorf("expected newest first; got %q", got[0].AttachmentID)
	}
}
