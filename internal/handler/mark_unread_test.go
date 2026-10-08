package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// fakeSeq is an in-memory UnreadSeqStore for the mark-unread handlers.
type fakeSeq struct {
	current  int64
	lastRead map[string]int64
}

func (f *fakeSeq) IncrementMessageSeq(context.Context, string) (int64, error) {
	f.current++
	return f.current, nil
}
func (f *fakeSeq) CurrentMessageSeq(context.Context, string) (int64, error) { return f.current, nil }
func (f *fakeSeq) SetLastRead(_ context.Context, parentID, userID string, seq int64) error {
	f.lastRead[parentID+"#"+userID] = seq
	return nil
}

type markUnreadEnv struct {
	channel *ChannelHandler
	conv    *ConversationHandler
	msgSvc  *service.MessageService
	seq     *fakeSeq
	jwt     *auth.JWTManager
	token   string
}

func setupMarkUnread(t *testing.T) *markUnreadEnv {
	t.Helper()
	memberships := newDataMembershipStore()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1"}
	convs := newDataConversationStore()
	convs.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1"}}
	messages := newDataMessageStore()
	messages.messages["ch-1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-1", AuthorID: "u-2", Body: "hi"}
	messages.messages["dm-1#m-2"] = &model.Message{ID: "m-2", ParentID: "dm-1", AuthorID: "u-1", Body: "note"}
	broker := &mockBrokerForHandler{}
	msgSvc := service.NewMessageService(messages, memberships, convs, nil, broker)
	seq := &fakeSeq{current: 10, lastRead: map[string]int64{}}
	msgSvc.SetChannelSeqStore(seq)
	msgSvc.SetConversationSeqStore(seq)
	jwt := auth.NewJWTManager("test-mark-unread-secret", 15*time.Minute, 720*time.Hour)
	return &markUnreadEnv{
		channel: NewChannelHandler(service.NewChannelService(newDataChannelStore(), memberships, nil, messages, &mockCache{}, broker, nil), msgSvc),
		conv:    NewConversationHandler(service.NewConversationService(convs, newDataUserStoreForConv(), newMockCache(), broker, nil), msgSvc),
		msgSvc:  msgSvc,
		seq:     seq,
		jwt:     jwt,
		token:   makeTokenForUser(jwt, &model.User{ID: "u-1", Email: "u1@test.com", SystemRole: model.SystemRoleMember}),
	}
}

func (e *markUnreadEnv) put(h http.HandlerFunc, kind, id, msgID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPut, "/api/v1/"+kind+"/"+id+"/messages/"+msgID+"/unread", nil)
	req.SetPathValue("id", id)
	req.SetPathValue("msgId", msgID)
	req.Header.Set("Authorization", "Bearer "+e.token)
	rec := httptest.NewRecorder()
	middleware.Auth(e.jwt)(h).ServeHTTP(rec, req)
	return rec
}

func TestMarkUnreadHandlers(t *testing.T) {
	env := setupMarkUnread(t)

	rec := env.put(env.channel.MarkUnread, "channels", "ch-1", "m-1")
	var res model.MarkUnreadResult
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil || res.ParentType != service.ParentChannel || res.UnreadCount == 0 {
		t.Fatalf("channel mark unread = %d %s", rec.Code, rec.Body.String())
	}
	if env.seq.lastRead["ch-1#u-1"] >= env.seq.current {
		t.Fatalf("watermark %d not rewound below %d", env.seq.lastRead["ch-1#u-1"], env.seq.current)
	}

	rec = env.put(env.conv.MarkUnread, "conversations", "dm-1", "m-2")
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil || res.ParentType != service.ParentConversation {
		t.Fatalf("self-DM mark unread = %d %s", rec.Code, rec.Body.String())
	}

	for _, c := range []struct {
		name       string
		kind, id   string
		msgID      string
		wantStatus int
	}{
		{"missing ids", "channels", "", "", http.StatusBadRequest},
		{"not a member", "channels", "ch-2", "m-1", http.StatusForbidden},
		{"no such message", "channels", "ch-1", "m-404", http.StatusNotFound},
	} {
		if rec := env.put(env.channel.MarkUnread, c.kind, c.id, c.msgID); rec.Code != c.wantStatus {
			t.Errorf("%s: status = %d, want %d (%s)", c.name, rec.Code, c.wantStatus, rec.Body.String())
		}
	}

	env.msgSvc.SetConversationSeqStore(nil)
	if rec := env.put(env.conv.MarkUnread, "conversations", "dm-1", "m-2"); rec.Code != http.StatusInternalServerError {
		t.Errorf("unwired read state: status = %d, want 500", rec.Code)
	}
}
