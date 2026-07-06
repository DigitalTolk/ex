package handler

import (
	"context"
	"errors"
	"fmt"
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

type fakeActivitySvc struct {
	feed    service.ActivityFeed
	feedErr error
	seenErr error
}

func (f *fakeActivitySvc) Feed(context.Context, string) (service.ActivityFeed, error) {
	return f.feed, f.feedErr
}
func (f *fakeActivitySvc) MarkSeen(context.Context, string) error { return f.seenErr }

type fakeReminderSvc struct {
	scheduled *model.Reminder
	schedErr  error
	pending   []*model.Reminder
	listErr   error
	cancelErr error
}

func (f *fakeReminderSvc) Schedule(context.Context, string, service.ReminderInput) (*model.Reminder, error) {
	return f.scheduled, f.schedErr
}
func (f *fakeReminderSvc) ListPending(context.Context, string) ([]*model.Reminder, error) {
	return f.pending, f.listErr
}
func (f *fakeReminderSvc) Cancel(context.Context, string, string) error { return f.cancelErr }

func setupActivityHandler(t *testing.T, a ActivityService, r ReminderService) (*ActivityHandler, *auth.JWTManager) {
	t.Helper()
	return NewActivityHandler(a, r), auth.NewJWTManager("activity-secret", 15*time.Minute, 24*time.Hour)
}

func authedReq(t *testing.T, jwtMgr *auth.JWTManager, method, target, body string) *http.Request {
	t.Helper()
	u := &model.User{ID: "u-1", SystemRole: model.SystemRoleMember}
	tok, _ := jwtMgr.GenerateAccessToken(u)
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

func TestActivityHandler_Feed(t *testing.T) {
	a := &fakeActivitySvc{feed: service.ActivityFeed{Items: []*model.ActivityItem{{ID: "x"}}, Unread: 1}}
	h, jwt := setupActivityHandler(t, a, &fakeReminderSvc{})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.Feed))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodGet, "/api/v1/activity", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"unread":1`) {
		t.Fatalf("Feed = %d %s", rec.Code, rec.Body.String())
	}
}

func TestActivityHandler_FeedNilItemsCoerced(t *testing.T) {
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.Feed))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodGet, "/api/v1/activity", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Fatalf("nil items should coerce to []: %d %s", rec.Code, rec.Body.String())
	}
}

func TestActivityHandler_FeedError(t *testing.T) {
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{feedErr: errors.New("boom")}, &fakeReminderSvc{})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.Feed))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodGet, "/api/v1/activity", ""))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("Feed error = %d", rec.Code)
	}
}

func TestActivityHandler_Unauthorized(t *testing.T) {
	// Called WITHOUT the auth middleware → no userID in context → 401 from each
	// handler's own guard.
	h := NewActivityHandler(&fakeActivitySvc{}, &fakeReminderSvc{})
	for _, hf := range []http.HandlerFunc{h.Feed, h.MarkRead, h.CreateReminder, h.ListReminders, h.CancelReminder} {
		rec := httptest.NewRecorder()
		hf(rec, httptest.NewRequest(http.MethodGet, "/api/v1/activity", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", rec.Code)
		}
	}
}

func TestActivityHandler_MarkRead(t *testing.T) {
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.MarkRead))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodPut, "/api/v1/activity/read", ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("MarkRead = %d", rec.Code)
	}

	hErr, jwtErr := setupActivityHandler(t, &fakeActivitySvc{seenErr: errors.New("boom")}, &fakeReminderSvc{})
	handlerErr := middleware.Auth(jwtErr)(http.HandlerFunc(hErr.MarkRead))
	recErr := httptest.NewRecorder()
	handlerErr.ServeHTTP(recErr, authedReq(t, jwtErr, http.MethodPut, "/api/v1/activity/read", ""))
	if recErr.Code != http.StatusInternalServerError {
		t.Fatalf("MarkRead error = %d", recErr.Code)
	}
}

func TestActivityHandler_CreateReminder(t *testing.T) {
	now := time.Now().Add(time.Hour)
	good := &fakeReminderSvc{scheduled: &model.Reminder{ID: "r1", RemindAt: now}}
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, good)
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.CreateReminder))
	rec := httptest.NewRecorder()
	body := `{"messageID":"m-1","parentID":"ch-1","parentType":"channel","remindAt":"` + now.Format(time.RFC3339) + `"}`
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodPost, "/api/v1/reminders", body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("CreateReminder = %d %s", rec.Code, rec.Body.String())
	}
}

func TestActivityHandler_CreateReminderBadBody(t *testing.T) {
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.CreateReminder))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodPost, "/api/v1/reminders", `{bad`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body = %d", rec.Code)
	}
}

func TestActivityHandler_CreateReminderErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"invalid time", service.ErrReminderTimeInvalid, http.StatusBadRequest},
		{"not found", store.ErrNotFound, http.StatusNotFound},
		{"validation", errors.New("reminder: invalid parent type"), http.StatusBadRequest},
		{"access", fmt.Errorf("message: not a channel member: %w", service.ErrForbidden), http.StatusForbidden},
		{"generic", errors.New("kaboom"), http.StatusInternalServerError},
	}
	for _, c := range cases {
		h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{schedErr: c.err})
		handler := middleware.Auth(jwt)(http.HandlerFunc(h.CreateReminder))
		rec := httptest.NewRecorder()
		body := `{"messageID":"m-1","parentID":"ch-1","parentType":"channel"}`
		handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodPost, "/api/v1/reminders", body))
		if rec.Code != c.want {
			t.Errorf("%s: status=%d, want %d", c.name, rec.Code, c.want)
		}
	}
}

func TestActivityHandler_ListReminders(t *testing.T) {
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{pending: nil})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.ListReminders))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodGet, "/api/v1/reminders", ""))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("nil reminders should be []: %d %s", rec.Code, rec.Body.String())
	}

	hErr, jwtErr := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{listErr: errors.New("boom")})
	handlerErr := middleware.Auth(jwtErr)(http.HandlerFunc(hErr.ListReminders))
	recErr := httptest.NewRecorder()
	handlerErr.ServeHTTP(recErr, authedReq(t, jwtErr, http.MethodGet, "/api/v1/reminders", ""))
	if recErr.Code != http.StatusInternalServerError {
		t.Fatalf("ListReminders error = %d", recErr.Code)
	}
}

func TestActivityHandler_CancelReminder(t *testing.T) {
	h, jwt := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{})
	handler := middleware.Auth(jwt)(http.HandlerFunc(h.CancelReminder))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, authedReq(t, jwt, http.MethodDelete, "/api/v1/reminders/r1", ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("Cancel = %d", rec.Code)
	}

	hNF, jwtNF := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{cancelErr: store.ErrNotFound})
	handlerNF := middleware.Auth(jwtNF)(http.HandlerFunc(hNF.CancelReminder))
	recNF := httptest.NewRecorder()
	handlerNF.ServeHTTP(recNF, authedReq(t, jwtNF, http.MethodDelete, "/api/v1/reminders/r1", ""))
	if recNF.Code != http.StatusNotFound {
		t.Fatalf("Cancel not found = %d", recNF.Code)
	}

	hErr, jwtErr := setupActivityHandler(t, &fakeActivitySvc{}, &fakeReminderSvc{cancelErr: errors.New("boom")})
	handlerErr := middleware.Auth(jwtErr)(http.HandlerFunc(hErr.CancelReminder))
	recErr := httptest.NewRecorder()
	handlerErr.ServeHTTP(recErr, authedReq(t, jwtErr, http.MethodDelete, "/api/v1/reminders/r1", ""))
	if recErr.Code != http.StatusInternalServerError {
		t.Fatalf("Cancel error = %d", recErr.Code)
	}
}
