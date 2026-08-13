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
)

// The interactive-action endpoint. The behaviour behind it lives in
// internal/service; this covers the HTTP contract — authentication, the arguments
// forwarded to the service, and the status code each failure maps to.

// fakeActionInvoker records its call and returns a programmed outcome.
type fakeActionInvoker struct {
	result service.ActionResult
	err    error

	gotUserID     string
	gotParentID   string
	gotParentType string
	gotMessageID  string
	gotActionID   string
	gotSelected   string
}

func (f *fakeActionInvoker) InvokeMessageAction(
	_ context.Context,
	userID, parentID, parentType, messageID, actionID string,
	selectedOption string,
) (service.ActionResult, error) {
	f.gotUserID, f.gotParentID, f.gotParentType = userID, parentID, parentType
	f.gotMessageID, f.gotActionID, f.gotSelected = messageID, actionID, selectedOption
	return f.result, f.err
}

func setupMessageActionHandler(t *testing.T) (*MessageActionHandler, *fakeActionInvoker, *auth.JWTManager) {
	t.Helper()
	invoker := &fakeActionInvoker{}
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", time.Minute, time.Hour)
	return NewMessageActionHandler(invoker), invoker, jwtMgr
}

// actionRequest builds a request with the path values the router would supply.
func actionRequest(parentPath, parentID, msgID, actionID, body string) *http.Request {
	var req *http.Request
	target := "/api/v1/" + parentPath + "/" + parentID + "/messages/" + msgID + "/actions/" + actionID
	if body == "" {
		req = httptest.NewRequest(http.MethodPost, target, nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	}
	req.SetPathValue("id", parentID)
	req.SetPathValue("msgId", msgID)
	req.SetPathValue("actionId", actionID)
	return req
}

// callAsMember runs one request through the auth middleware as an ordinary member.
func callAsMember(t *testing.T, jwtMgr *auth.JWTManager, h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	token := makeTokenForUser(jwtMgr, &model.User{ID: "u1", SystemRole: model.SystemRoleMember})
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(h).ServeHTTP(rec, req)
	return rec
}

func TestMessageActionHandler_RequiresAuthentication(t *testing.T) {
	h, invoker, _ := setupMessageActionHandler(t)
	rec := httptest.NewRecorder()
	// No auth middleware in front → no claims in context.
	h.Invoke(service.ParentChannel)(rec, actionRequest("channels", "ch1", "m1", "act1", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if invoker.gotActionID != "" {
		t.Error("the service was called for an unauthenticated request")
	}
}

func TestMessageActionHandler_ForwardsTheInvocation(t *testing.T) {
	h, invoker, jwtMgr := setupMessageActionHandler(t)
	invoker.result = service.ActionResult{EphemeralText: "Approved"}

	rec := callAsMember(t, jwtMgr, h.Invoke(service.ParentChannel),
		actionRequest("channels", "ch1", "m1", "act1", `{"selected_option":"prod"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if invoker.gotUserID != "u1" || invoker.gotParentID != "ch1" ||
		invoker.gotParentType != service.ParentChannel || invoker.gotMessageID != "m1" ||
		invoker.gotActionID != "act1" || invoker.gotSelected != "prod" {
		t.Errorf("service received %+v, want the path values and the chosen option", invoker)
	}
	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["ephemeral_text"] != "Approved" {
		t.Errorf("ephemeral_text = %v", got["ephemeral_text"])
	}
}

// The conversation variant is registered separately, like every other message
// route, so it forwards its own parent type.
func TestMessageActionHandler_ConversationParentType(t *testing.T) {
	h, invoker, jwtMgr := setupMessageActionHandler(t)
	rec := callAsMember(t, jwtMgr, h.Invoke(service.ParentConversation),
		actionRequest("conversations", "conv1", "m2", "act1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if invoker.gotParentType != service.ParentConversation {
		t.Errorf("parentType = %q, want a conversation", invoker.gotParentType)
	}
	// An absent body is fine — a button carries no selection.
	if invoker.gotSelected != "" {
		t.Errorf("selected = %q, want empty for a bodyless request", invoker.gotSelected)
	}
}

func TestMessageActionHandler_MalformedBody(t *testing.T) {
	h, _, jwtMgr := setupMessageActionHandler(t)
	rec := callAsMember(t, jwtMgr, h.Invoke(service.ParentChannel),
		actionRequest("channels", "ch1", "m1", "act1", `{`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestMessageActionHandler_ErrorStatuses(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "unknown action", err: service.ErrActionNotFound, want: http.StatusNotFound},
		{name: "disabled action", err: service.ErrActionDisabled, want: http.StatusConflict},
		// The fault is the integration's, not ex's — 502 so the client can say so.
		{name: "integration failed", err: service.ErrActionFailed, want: http.StatusBadGateway},
		{name: "no access to the chat", err: service.ErrForbidden, want: http.StatusForbidden},
		{name: "anything else", err: errors.New("boom"), want: http.StatusInternalServerError},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, invoker, jwtMgr := setupMessageActionHandler(t)
			invoker.err = tc.err
			rec := callAsMember(t, jwtMgr, h.Invoke(service.ParentChannel),
				actionRequest("channels", "ch1", "m1", "act1", ""))
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}
