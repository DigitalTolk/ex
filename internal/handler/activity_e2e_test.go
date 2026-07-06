//go:build integration

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
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/redis/go-redis/v9"
)

type e2eMsgStore struct{ msg *model.Message }

func (m *e2eMsgStore) GetMessage(context.Context, string, string) (*model.Message, error) {
	return m.msg, nil
}

type e2eAccess struct{}

func (e2eAccess) CheckAccess(context.Context, string, string, string) error { return nil }

type e2eNotifier struct{}

func (e2eNotifier) NotifyDirect(context.Context, string, service.Notification) {}

// TestActivityHandler_CreateReminder_EndToEnd drives a browser-shaped JSON body
// (millisecond ISO remindAt, exactly the fields the client sends) through the
// REAL handler → ReminderService → Redis store, then reads it back — catching
// JSON-decode / validation / round-trip breaks the mocked handler tests can't.
func TestActivityHandler_CreateReminder_EndToEnd(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: redisAddrForTest(t)})
	t.Cleanup(func() { _ = client.Close() })

	activitySvc := service.NewActivityService(store.NewRedisActivityStore(client), &stubPublisher{})
	reminderSvc := service.NewReminderService(
		store.NewRedisReminderStore(client),
		&e2eMsgStore{msg: &model.Message{ID: "m1", ParentID: "ch1", Body: "hello world"}},
		e2eAccess{},
	)
	reminderSvc.SetDelivery(activitySvc, e2eNotifier{})
	h, jwt := setupActivityHandler(t, activitySvc, reminderSvc)

	// Exactly what the client sends: JS `new Date(...).toISOString()` includes
	// milliseconds and a Z suffix.
	remindAt := time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.000Z07:00")
	body := `{"messageID":"m1","parentID":"ch1","parentType":"channel","channelSlug":"general","remindAt":"` + remindAt + `"}`

	rec := httptest.NewRecorder()
	middleware.Auth(jwt)(http.HandlerFunc(h.CreateReminder)).
		ServeHTTP(rec, authedReq(t, jwt, http.MethodPost, "/api/v1/reminders", body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("CreateReminder = %d, body=%s", rec.Code, rec.Body.String())
	}

	// And it comes back on the pending list.
	listRec := httptest.NewRecorder()
	middleware.Auth(jwt)(http.HandlerFunc(h.ListReminders)).
		ServeHTTP(listRec, authedReq(t, jwt, http.MethodGet, "/api/v1/reminders", ""))
	if listRec.Code != http.StatusOK || !strings.Contains(listRec.Body.String(), `"messageID":"m1"`) {
		t.Fatalf("ListReminders = %d, body=%s", listRec.Code, listRec.Body.String())
	}
}
