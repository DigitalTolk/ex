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
	"github.com/DigitalTolk/ex/internal/store"
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
	if err := stateSvc.MarkThreadNotificationUnread(ctx, userID, "ch-1", "channel", "root-1"); err != nil {
		t.Fatalf("MarkThreadNotificationUnread: %v", err)
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
	if len(got.ThreadNotifications) != 1 || got.ThreadNotifications[0] != "root-1" {
		t.Fatalf("thread notifications = %#v", got.ThreadNotifications)
	}

	clientSeenAt := time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)
	beforeSeen := time.Now()
	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch-1/root-1/seen", bytes.NewBufferString(`{"seenAt":"`+clientSeenAt.Format(time.RFC3339Nano)+`"}`), userID)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-1")
	req.SetPathValue("threadRootID", "root-1")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("MarkThreadSeen status = %d body=%s", rec.Code, rec.Body.String())
	}
	afterSeen := time.Now()
	seenRow := stateStore.rows[stateStore.key(userID, model.UserStateThreadSeen, "root-1")]
	if seenRow == nil || seenRow.SeenAt == nil {
		t.Fatal("expected thread seen row")
	}
	if seenRow.SeenAt.Equal(clientSeenAt) {
		t.Fatal("server must not persist client-supplied seenAt")
	}
	if seenRow.SeenAt.Before(beforeSeen) || seenRow.SeenAt.After(afterSeen) {
		t.Fatalf("seenAt = %s, want server time between %s and %s", seenRow.SeenAt, beforeSeen, afterSeen)
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

	rec := httptest.NewRecorder()
	handler.Get(rec, httptest.NewRequest(http.MethodGet, "/api/v1/user-state", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Get unauth status = %d", rec.Code)
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

	req = httptest.NewRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch/root/seen", nil)
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch")
	req.SetPathValue("threadRootID", "root")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("MarkThreadSeen unauth status = %d", rec.Code)
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels//root/seen", nil, "u-1")
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("threadRootID", "root")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("MarkThreadSeen missing parent status = %d", rec.Code)
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch-denied/root/seen", nil, "u-1")
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-denied")
	req.SetPathValue("threadRootID", "root")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	// Membership denials carry service.ErrForbidden, so a non-member is a
	// 403 (it used to fall through to a 500 because the handler couldn't
	// recognize the denial).
	if rec.Code != http.StatusForbidden {
		t.Fatalf("MarkThreadSeen denied status = %d, want 403", rec.Code)
	}

	stateStore = newMockUserStateStoreForHandler()
	stateStore.setErr = errors.New("seen boom")
	handler = NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)
	// Membership must exist so CheckAccess passes and the request actually
	// reaches the failing state store — without it this case asserted the
	// (previously indistinguishable) membership denial instead.
	_ = members.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch", UserID: "u-1", Role: model.ChannelRoleMember},
		&model.UserChannel{ChannelID: "ch", UserID: "u-1"})
	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch/root/seen", nil, "u-1")
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch")
	req.SetPathValue("threadRootID", "root")
	rec = httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("MarkThreadSeen set error status = %d", rec.Code)
	}

	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/conversations/conv-missing/hidden", nil, "u-1")
	req.SetPathValue("id", "conv-missing")
	rec = httptest.NewRecorder()
	handler.HideConversation(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("HideConversation missing status = %d", rec.Code)
	}

	stateStore = newMockUserStateStoreForHandler()
	stateStore.listErr = errors.New("list boom")
	handler = NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)
	rec = httptest.NewRecorder()
	handler.Get(rec, userStateAuthedRequest(http.MethodGet, "/api/v1/user-state", nil, "u-1"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("Get list error status = %d", rec.Code)
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

func TestUserStateHandler_MarkThreadSeen_Success(t *testing.T) {
	stateStore := newMockUserStateStoreForHandler()
	members := newDataMembershipStore()
	convs := newDataConversationStore()
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	msgSvc := service.NewMessageService(messages, members, convs, nil, broker)
	convSvc := service.NewConversationService(convs, newDataUserStoreForConv(), nil, broker, nil)
	// Caller is a member of the channel → CheckAccess passes.
	_ = members.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember},
		&model.UserChannel{ChannelID: "ch-1", UserID: "u-1"})
	handler := NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)

	req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/threads/channels/ch-1/root-1/seen", nil, "u-1")
	req.SetPathValue("parentType", "channels")
	req.SetPathValue("parentID", "ch-1")
	req.SetPathValue("threadRootID", "root-1")
	rec := httptest.NewRecorder()
	handler.MarkThreadSeen(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserStateHandler_SetConversationHidden_Branches(t *testing.T) {
	stateStore := newMockUserStateStoreForHandler()
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	members := newDataMembershipStore()
	messages := newDataMessageStore()
	broker := &mockBrokerForHandler{}
	msgSvc := service.NewMessageService(messages, members, convs, nil, broker)
	convSvc := service.NewConversationService(convs, users, nil, broker, nil)
	convs.conversations["conv-1"] = &model.Conversation{ID: "conv-1", ParticipantIDs: []string{"u-1"}}
	handler := NewUserStateHandler(service.NewUserStateService(stateStore, nil), msgSvc, convSvc)

	// Unauthenticated → 401.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/user-state/conversations/conv-1/hidden", nil)
	req.SetPathValue("id", "conv-1")
	handler.HideConversation(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d", rec.Code)
	}

	// Missing conversation ID → 400.
	rec = httptest.NewRecorder()
	handler.HideConversation(rec, userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/conversations//hidden", nil, "u-1"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing id status = %d", rec.Code)
	}

	// Unhide (the hidden=false branch) succeeds → 204.
	rec = httptest.NewRecorder()
	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/conversations/conv-1/hidden", nil, "u-1")
	req.SetPathValue("id", "conv-1")
	handler.UnhideConversation(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unhide status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Unhide store error → 500.
	errStore := newMockUserStateStoreForHandler()
	errStore.deleteErr = errors.New("unhide boom")
	handler = NewUserStateHandler(service.NewUserStateService(errStore, nil), msgSvc, convSvc)
	rec = httptest.NewRecorder()
	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/conversations/conv-1/hidden", nil, "u-1")
	req.SetPathValue("id", "conv-1")
	handler.UnhideConversation(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unhide error status = %d", rec.Code)
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

// failingUserStateStore errors on every write — the 500 arm.
type failingUserStateStore struct{}

func (failingUserStateStore) SetUserState(context.Context, *model.UserStateItem) error {
	return errors.New("dynamo down")
}
func (failingUserStateStore) DeleteUserState(context.Context, string, model.UserStateKind, string) error {
	return errors.New("dynamo down")
}
func (failingUserStateStore) ListUserState(context.Context, string) ([]*model.UserStateItem, error) {
	return nil, errors.New("dynamo down")
}

// visibleSkillStub satisfies the handler's skillLookup seam.
type visibleSkillStub struct{ err error }

func (s visibleSkillStub) GetVisibleSkill(_ context.Context, _, id string) (*model.Skill, error) {
	if s.err != nil {
		return nil, s.err
	}
	return &model.Skill{ID: id}, nil
}

func TestUserStateHandler_SkillHiddenToggle(t *testing.T) {
	stateStore := newMockUserStateStoreForHandler()
	stateSvc := service.NewUserStateService(stateStore, nil)
	handler := NewUserStateHandler(stateSvc, nil, nil)
	handler.SetSkillLookup(visibleSkillStub{})
	const userID = "u-1"

	req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/skills/sk-1/hidden", nil, userID)
	req.SetPathValue("id", "sk-1")
	rec := httptest.NewRecorder()
	handler.HideSkill(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("HideSkill status = %d body=%s", rec.Code, rec.Body.String())
	}
	state, err := stateSvc.List(context.Background(), userID)
	if err != nil || len(state.HiddenSkills) != 1 || state.HiddenSkills[0] != "sk-1" {
		t.Fatalf("hidden skills after PUT = %#v err=%v", state, err)
	}

	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/skills/sk-1/hidden", nil, userID)
	req.SetPathValue("id", "sk-1")
	rec = httptest.NewRecorder()
	handler.UnhideSkill(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("UnhideSkill status = %d body=%s", rec.Code, rec.Body.String())
	}
	if state, _ := stateSvc.List(context.Background(), userID); len(state.HiddenSkills) != 0 {
		t.Fatalf("hidden skills after DELETE = %#v", state.HiddenSkills)
	}
}

func TestUserStateHandler_SkillHiddenErrors(t *testing.T) {
	stateSvc := service.NewUserStateService(newMockUserStateStoreForHandler(), nil)
	handler := NewUserStateHandler(stateSvc, nil, nil)

	// Unauthenticated.
	rec := httptest.NewRecorder()
	handler.HideSkill(rec, httptest.NewRequest(http.MethodPut, "/api/v1/user-state/skills/sk-1/hidden", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d", rec.Code)
	}
	// Missing id.
	req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/skills//hidden", nil, "u-1")
	rec = httptest.NewRecorder()
	handler.HideSkill(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing id status = %d", rec.Code)
	}
	// A skill the caller cannot see refuses to hide (existence never leaks).
	handler.SetSkillLookup(visibleSkillStub{err: store.ErrNotFound})
	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/skills/sk-x/hidden", nil, "u-1")
	req.SetPathValue("id", "sk-x")
	rec = httptest.NewRecorder()
	handler.HideSkill(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("invisible skill status = %d", rec.Code)
	}
	// Unhide skips the lookup — clearing a stale row must always work.
	req = userStateAuthedRequest(http.MethodDelete, "/api/v1/user-state/skills/sk-x/hidden", nil, "u-1")
	req.SetPathValue("id", "sk-x")
	rec = httptest.NewRecorder()
	handler.UnhideSkill(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unhide status = %d", rec.Code)
	}
	// Store failure surfaces as 500.
	failing := service.NewUserStateService(failingUserStateStore{}, nil)
	broken := NewUserStateHandler(failing, nil, nil)
	req = userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/skills/sk-1/hidden", nil, "u-1")
	req.SetPathValue("id", "sk-1")
	rec = httptest.NewRecorder()
	broken.HideSkill(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("store failure status = %d", rec.Code)
	}
}

// categoryListerStub satisfies the handler's categoryLister seam.
type categoryListerStub struct {
	cats []*model.UserChannelCategory
	err  error
}

func (s categoryListerStub) List(context.Context, string) ([]*model.UserChannelCategory, error) {
	return s.cats, s.err
}

func TestUserStateHandler_SetSidebarSort(t *testing.T) {
	stateSvc := service.NewUserStateService(newMockUserStateStoreForHandler(), nil)
	handler := NewUserStateHandler(stateSvc, nil, nil)
	handler.SetCategoryLister(categoryListerStub{cats: []*model.UserChannelCategory{{ID: "cat-1"}}})
	put := func(section, body string) int {
		req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/sidebar-sorts/"+section, bytes.NewBufferString(body), "u-1")
		req.SetPathValue("section", section)
		rec := httptest.NewRecorder()
		handler.SetSidebarSort(rec, req)
		return rec.Code
	}

	// A built-in section and one of the caller's categories are remembered.
	if code := put("__channels__", `{"sort":"recent"}`); code != http.StatusNoContent {
		t.Fatalf("built-in section status = %d", code)
	}
	if code := put("cat-1", `{"sort":"az"}`); code != http.StatusNoContent {
		t.Fatalf("own category status = %d", code)
	}
	state, err := stateSvc.List(context.Background(), "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := map[string]model.SidebarSort{"__channels__": model.SidebarSortRecent, "cat-1": model.SidebarSortAZ}
	if len(state.SidebarSorts) != 2 || state.SidebarSorts["__channels__"] != want["__channels__"] || state.SidebarSorts["cat-1"] != want["cat-1"] {
		t.Fatalf("sidebar sorts = %#v", state.SidebarSorts)
	}
	// Changing a section's sort replaces its row.
	if code := put("__channels__", `{"sort":"az"}`); code != http.StatusNoContent {
		t.Fatalf("change status = %d", code)
	}
	if state, _ := stateSvc.List(context.Background(), "u-1"); state.SidebarSorts["__channels__"] != model.SidebarSortAZ {
		t.Fatalf("changed sort = %#v", state.SidebarSorts)
	}

	// Only the two sorts, in a readable body.
	for _, body := range []string{`{"sort":"newest"}`, `{}`, `not json`} {
		if code := put("__channels__", body); code != http.StatusBadRequest {
			t.Fatalf("body %q status = %d", body, code)
		}
	}
	// Somebody else's (or a deleted) category is not a section of yours.
	if code := put("cat-other", `{"sort":"recent"}`); code != http.StatusNotFound {
		t.Fatalf("unknown section status = %d", code)
	}
	// A failing category lookup surfaces as 500.
	handler.SetCategoryLister(categoryListerStub{err: errors.New("dynamo down")})
	if code := put("cat-1", `{"sort":"recent"}`); code != http.StatusInternalServerError {
		t.Fatalf("lookup failure status = %d", code)
	}

	// Unauthenticated.
	rec := httptest.NewRecorder()
	handler.SetSidebarSort(rec, httptest.NewRequest(http.MethodPut, "/api/v1/user-state/sidebar-sorts/__channels__", bytes.NewBufferString(`{"sort":"az"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d", rec.Code)
	}
	// A store failure surfaces as 500.
	broken := NewUserStateHandler(service.NewUserStateService(failingUserStateStore{}, nil), nil, nil)
	req := userStateAuthedRequest(http.MethodPut, "/api/v1/user-state/sidebar-sorts/__dms__", bytes.NewBufferString(`{"sort":"az"}`), "u-1")
	req.SetPathValue("section", "__dms__")
	rec = httptest.NewRecorder()
	broken.SetSidebarSort(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("store failure status = %d", rec.Code)
	}
}
