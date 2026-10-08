package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeScheduledSvc struct {
	err      error
	gotInput service.ScheduledMessageInput
	gotUpd   service.ScheduledMessageUpdate
	gotID    string
}

func (f *fakeScheduledSvc) Schedule(_ context.Context, userID string, in service.ScheduledMessageInput) (*model.ScheduledMessage, error) {
	f.gotInput = in
	if f.err != nil {
		return nil, f.err
	}
	return &model.ScheduledMessage{ID: "s-1", UserID: userID, Body: in.Body, SendAt: in.SendAt, State: model.ScheduledMessagePending}, nil
}

func (f *fakeScheduledSvc) List(_ context.Context, userID string) ([]*model.ScheduledMessage, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []*model.ScheduledMessage{{ID: "s-1", UserID: userID}}, nil
}

func (f *fakeScheduledSvc) Update(_ context.Context, userID, id string, upd service.ScheduledMessageUpdate) (*model.ScheduledMessage, error) {
	f.gotID, f.gotUpd = id, upd
	if f.err != nil {
		return nil, f.err
	}
	return &model.ScheduledMessage{ID: id, UserID: userID, Body: *upd.Body}, nil
}

func (f *fakeScheduledSvc) Delete(_ context.Context, _, id string) error {
	f.gotID = id
	return f.err
}

func (f *fakeScheduledSvc) SendNow(_ context.Context, userID, id string) (*model.Message, error) {
	f.gotID = id
	if f.err != nil {
		return nil, f.err
	}
	return &model.Message{ID: "m-1", AuthorID: userID}, nil
}

func schedReq(method, body, uid, id string) *http.Request {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/api/v1/scheduled-messages", rd)
	if uid != "" {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: uid}))
	}
	if id != "" {
		req.SetPathValue("id", id)
	}
	return req
}

func schedDo(h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestScheduledMessageHandler_Endpoints(t *testing.T) {
	svc := &fakeScheduledSvc{}
	h := NewScheduledMessageHandler(svc)
	at := time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC)

	rec := schedDo(h.Create, schedReq(http.MethodPost, fmt.Sprintf(`{"parentID":"ch-1","parentType":"channel","parentMessageID":"root","body":"hi","attachmentIDs":["a"],"sendAt":%q}`, at.Format(time.RFC3339)), "u-1", ""))
	if rec.Code != http.StatusCreated || svc.gotInput.ParentMessageID != "root" || !svc.gotInput.SendAt.Equal(at) {
		t.Fatalf("Create = %d %s, input %+v", rec.Code, rec.Body.String(), svc.gotInput)
	}

	rec = schedDo(h.List, schedReq(http.MethodGet, "", "u-1", ""))
	var list []model.ScheduledMessage
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &list) != nil || len(list) != 1 {
		t.Fatalf("List = %d %s", rec.Code, rec.Body.String())
	}

	rec = schedDo(h.Update, schedReq(http.MethodPatch, `{"body":"edited"}`, "u-1", "s-9"))
	if rec.Code != http.StatusOK || svc.gotID != "s-9" || *svc.gotUpd.Body != "edited" {
		t.Fatalf("Update = %d %s", rec.Code, rec.Body.String())
	}

	if rec = schedDo(h.Delete, schedReq(http.MethodDelete, "", "u-1", "s-8")); rec.Code != http.StatusNoContent || svc.gotID != "s-8" {
		t.Fatalf("Delete = %d", rec.Code)
	}

	if rec = schedDo(h.SendNow, schedReq(http.MethodPost, "", "u-1", "s-7")); rec.Code != http.StatusOK || svc.gotID != "s-7" {
		t.Fatalf("SendNow = %d %s", rec.Code, rec.Body.String())
	}
}

func TestScheduledMessageHandler_AuthAndBodies(t *testing.T) {
	h := NewScheduledMessageHandler(&fakeScheduledSvc{})
	for name, hf := range map[string]http.HandlerFunc{"create": h.Create, "list": h.List, "update": h.Update, "delete": h.Delete, "send": h.SendNow} {
		if rec := schedDo(hf, schedReq(http.MethodPost, "{}", "", "s-1")); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without a user: %d", name, rec.Code)
		}
	}
	for name, hf := range map[string]http.HandlerFunc{"create": h.Create, "update": h.Update} {
		if rec := schedDo(hf, schedReq(http.MethodPost, `{"nope":1}`, "u-1", "s-1")); rec.Code != http.StatusBadRequest {
			t.Errorf("%s with a bad body: %d", name, rec.Code)
		}
	}
}

func TestScheduledMessageHandler_ErrorStatuses(t *testing.T) {
	for err, want := range map[error]int{
		service.ErrScheduledTimeInvalid: http.StatusBadRequest,
		service.ErrMessageTooLong:       http.StatusBadRequest,
		service.ErrTooManyAttachments:   http.StatusBadRequest,
		service.ErrThreadDeleted:        http.StatusBadRequest,
		service.ErrForbidden:            http.StatusForbidden,
		store.ErrNotFound:               http.StatusNotFound,
		service.ErrScheduledBusy:        http.StatusConflict,
		errors.New("dynamo down"):       http.StatusInternalServerError,
	} {
		svc := &fakeScheduledSvc{err: err}
		h := NewScheduledMessageHandler(svc)
		for name, hf := range map[string]http.HandlerFunc{"create": h.Create, "list": h.List, "update": h.Update, "delete": h.Delete, "send": h.SendNow} {
			body := `{"body":"x"}`
			if name == "create" {
				body = `{"body":"x","parentID":"c","parentType":"channel","sendAt":"2026-10-09T09:00:00Z"}`
			}
			if rec := schedDo(hf, schedReq(http.MethodPost, body, "u-1", "s-1")); rec.Code != want {
				t.Errorf("%s with %v: %d, want %d", name, err, rec.Code, want)
			}
		}
	}
}

type chanDraftClearer struct{ scopes chan string }

func (c *chanDraftClearer) DeleteForScope(_ context.Context, userID, parentID, parentType, parentMessageID string) error {
	c.scopes <- userID + "|" + parentID + "|" + parentType + "|" + parentMessageID
	return nil
}

// Scheduling empties the composer's draft for that scope, like a send.
func TestScheduledMessageHandler_CreateClearsTheDraft(t *testing.T) {
	h := NewScheduledMessageHandler(&fakeScheduledSvc{})
	clearer := &chanDraftClearer{scopes: make(chan string, 1)}
	h.SetDraftClearer(clearer)
	rec := schedDo(h.Create, schedReq(http.MethodPost, `{"parentID":"ch-1","parentType":"channel","parentMessageID":"root","body":"hi","sendAt":"2026-10-09T09:00:00Z"}`, "u-1", ""))
	if rec.Code != http.StatusCreated {
		t.Fatalf("Create = %d", rec.Code)
	}
	select {
	case got := <-clearer.scopes:
		if got != "u-1|ch-1|channel|root" {
			t.Fatalf("cleared %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("draft not cleared")
	}
}
