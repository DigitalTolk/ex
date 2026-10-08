package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

// The sender's X-Client-Nonce comes back on the created message (so its
// optimistic row can be swapped for the real one); a malformed one is dropped.
func TestSendMessage_EchoesClientNonce(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-msg#u-sender"] = &model.ChannelMembership{ChannelID: "ch-msg", UserID: "u-sender", Role: model.ChannelRoleMember}
	token := makeTokenForUser(env.jwtMgr, &model.User{ID: "u-sender", Email: "s@test.com", SystemRole: model.SystemRoleMember})
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage))

	send := func(nonce string) model.Message {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-msg/messages", strings.NewReader(`{"body":"hi"}`))
		req.SetPathValue("id", "ch-msg")
		req.Header.Set("Authorization", "Bearer "+token)
		if nonce != "" {
			req.Header.Set(clientNonceHeader, nonce)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		var msg model.Message
		if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &msg) != nil {
			t.Fatalf("send = %d %s", rec.Code, rec.Body.String())
		}
		return msg
	}
	if got := send("pending_01J9-abc").ClientNonce; got != "pending_01J9-abc" {
		t.Fatalf("clientNonce = %q, want the request's", got)
	}
	for _, bad := range []string{"", "has space", strings.Repeat("x", 65)} {
		if got := send(bad).ClientNonce; got != "" {
			t.Errorf("nonce %q echoed as %q, want dropped", bad, got)
		}
	}
}

func TestConversationSendMessage_EchoesClientNonce(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.conversations["dm-n"] = &model.Conversation{ID: "dm-n", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-n"}}
	token := makeTokenForUser(env.jwtMgr, &model.User{ID: "u-n", Email: "n@test.com", SystemRole: model.SystemRoleMember})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/dm-n/messages", strings.NewReader(`{"body":"note"}`))
	req.SetPathValue("id", "dm-n")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(clientNonceHeader, "n-1")
	rec := httptest.NewRecorder()
	middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.SendMessage)).ServeHTTP(rec, req)
	var msg model.Message
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &msg) != nil || msg.ClientNonce != "n-1" {
		t.Fatalf("send = %d %s", rec.Code, rec.Body.String())
	}
}
