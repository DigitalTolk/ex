package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestNotification_MarkChannelNotification_Error(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	st := newMockUserStateStore()
	st.setErr = errors.New("boom")
	svc.SetUserStateService(NewUserStateService(st, nil))
	// Logs the failure; must not panic.
	svc.markChannelNotification(context.Background(), "u1", "ch1")
}

func TestNotification_MarkThreadNotification_Error(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	st := newMockUserStateStore()
	st.setErr = errors.New("boom")
	svc.SetUserStateService(NewUserStateService(st, nil))
	msg := &model.Message{ID: "m1", ParentID: "ch1", ParentMessageID: "root1"}
	svc.markThreadNotification(context.Background(), "u1", msg, ParentChannel)
}

func TestNotification_MarkThreadNotification_NoUserState(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	// userState nil → early return (no-op, covers the guard).
	svc.markThreadNotification(context.Background(), "u1", &model.Message{ParentMessageID: "root1"}, ParentChannel)
	// msg with empty ParentMessageID → early return.
	svc.markThreadNotification(context.Background(), "u1", &model.Message{}, ParentChannel)
}
