package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// POST /api/v1/conversations/{id}/convert: a group message becomes a
// private channel.

type handlerConverter struct {
	convs map[string]*model.Conversation
}

func (c *handlerConverter) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if conv, ok := c.convs[id]; ok {
		return conv, nil
	}
	return nil, store.ErrNotFound
}

func (c *handlerConverter) GetUserConversations(context.Context, string, []string) (map[string]*model.UserConversation, error) {
	return map[string]*model.UserConversation{}, nil
}

func (c *handlerConverter) ConvertGroupToChannel(_ context.Context, ch *model.Channel, _ []store.ConvertedMember, _ time.Time) error {
	c.convs[ch.ID].ConvertedToChannelID = ch.ID
	return nil
}

func TestChannelHandler_ConvertConversation(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.handler.channelSvc.SetConversationConverter(&handlerConverter{convs: map[string]*model.Conversation{
		"g-1": {ID: "g-1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-a", "u-b"}},
	}}, nil)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.ConvertConversation))
	call := func(userID, convID, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/convert", strings.NewReader(body))
		req.SetPathValue("id", convID)
		if userID != "" {
			req.Header.Set("Authorization", "Bearer "+makeTokenForUser(env.jwtMgr, &model.User{ID: userID, SystemRole: model.SystemRoleMember}))
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	for _, tc := range []struct {
		name, user, conv, body string
		want                   int
	}{
		{"no body", "u-a", "g-1", `{`, http.StatusBadRequest},
		{"no name", "u-a", "g-1", `{}`, http.StatusBadRequest},
		{"not in it", "u-x", "g-1", `{"name":"ops"}`, http.StatusForbidden},
		{"no such group", "u-a", "g-none", `{"name":"ops"}`, http.StatusNotFound},
		{"converted", "u-a", "g-1", `{"name":"ops"}`, http.StatusCreated},
		{"converted again", "u-b", "g-1", `{"name":"ops-2"}`, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rec := call(tc.user, tc.conv, tc.body); rec.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
	// The handler itself turns away a request with no signed-in user (the
	// auth middleware normally does first).
	rec := httptest.NewRecorder()
	env.handler.ConvertConversation(rec, httptest.NewRequest(http.MethodPost, "/api/v1/conversations/g-1/convert", strings.NewReader(`{"name":"ops"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d", rec.Code)
	}
}
