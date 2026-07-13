package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakeCommand is a programmable Command recording its invocation.
type fakeCommand struct {
	info CommandInfo
	msg  *model.Message
	err  error
	got  *CommandRequest
}

func (f *fakeCommand) Info() CommandInfo { return f.info }

func (f *fakeCommand) Run(_ context.Context, req CommandRequest) (*model.Message, error) {
	f.got = &req
	return f.msg, f.err
}

func TestCommandServiceListEmpty(t *testing.T) {
	svc := NewCommandService()
	list := svc.List()
	if list == nil || len(list) != 0 {
		t.Fatalf("List() = %#v, want empty non-nil slice", list)
	}
}

func TestCommandServiceListsInRegistrationOrder(t *testing.T) {
	svc := NewCommandService()
	svc.Register(&fakeCommand{info: CommandInfo{Name: "b", Description: "second"}})
	svc.Register(&fakeCommand{info: CommandInfo{Name: "a", Description: "first"}})

	list := svc.List()
	if len(list) != 2 || list[0].Name != "b" || list[1].Name != "a" {
		t.Fatalf("List() = %#v, want registration order preserved", list)
	}
}

func TestCommandServiceRunUnknownCommand(t *testing.T) {
	svc := NewCommandService()
	_, err := svc.Run(context.Background(), "nope", CommandRequest{ParentType: ParentChannel})
	if !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("err = %v, want ErrUnknownCommand", err)
	}
}

func TestCommandServiceRunRejectsUnknownParentType(t *testing.T) {
	svc := NewCommandService()
	svc.Register(&fakeCommand{info: CommandInfo{Name: "x"}})
	_, err := svc.Run(context.Background(), "x", CommandRequest{ParentType: "thread"})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestCommandServiceRunDispatches(t *testing.T) {
	want := &model.Message{ID: "m1"}
	cmd := &fakeCommand{info: CommandInfo{Name: "x"}, msg: want}
	svc := NewCommandService()
	svc.Register(cmd)

	req := CommandRequest{UserID: "u1", ParentID: "c1", ParentType: ParentConversation}
	got, err := svc.Run(context.Background(), "x", req)
	if err != nil || got != want {
		t.Fatalf("Run = (%v, %v), want the command's message", got, err)
	}
	if cmd.got == nil || *cmd.got != req {
		t.Errorf("command received %+v, want %+v", cmd.got, req)
	}
}
