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
	list := svc.List(context.Background())
	if list == nil || len(list) != 0 {
		t.Fatalf("List() = %#v, want empty non-nil slice", list)
	}
}

func TestCommandServiceListsInRegistrationOrder(t *testing.T) {
	svc := NewCommandService()
	svc.Register(&fakeCommand{info: CommandInfo{Name: "b", Description: "second"}})
	svc.Register(&fakeCommand{info: CommandInfo{Name: "a", Description: "first"}})

	list := svc.List(context.Background())
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
	if err != nil || got.Message != want {
		t.Fatalf("Run = (%+v, %v), want the command's message", got, err)
	}
	if cmd.got == nil || *cmd.got != req {
		t.Errorf("command received %+v, want %+v", cmd.got, req)
	}
}

func TestCommandUserErrorMessage(t *testing.T) {
	err := &CommandUserError{Message: "guests can't do that"}
	if err.Error() != "command: guests can't do that" {
		t.Errorf("Error() = %q", err.Error())
	}
}

// A built-in and an external command can collide on a name. The built-in wins at
// dispatch, so it must also win in the list — offering both would show a duplicate
// entry where only one can ever run.
func TestCommandServiceExternalRunnerMerging(t *testing.T) {
	ctx := context.Background()
	runner := &fakeExternalRunner{list: []CommandInfo{
		{Name: "deploy", Description: "external"},
		{Name: "shared", Description: "shadowed"},
	}}
	svc := NewCommandService()
	svc.Register(&fakeCommand{info: CommandInfo{Name: "shared", Description: "built-in"}})
	svc.SetExternalRunner(runner)

	list := svc.List(ctx)
	if len(list) != 2 {
		t.Fatalf("List = %+v, want the built-in plus the non-colliding external", list)
	}
	if list[0].Name != "shared" || list[0].Description != "built-in" {
		t.Errorf("list[0] = %+v, want the built-in to shadow the external one", list[0])
	}
	if list[1].Name != "deploy" {
		t.Errorf("list[1] = %+v, want the external command", list[1])
	}

	// BuiltinTriggers is what external registration checks against.
	if triggers := svc.BuiltinTriggers(); !triggers["shared"] || triggers["deploy"] {
		t.Errorf("BuiltinTriggers = %+v, want only the compiled-in name", triggers)
	}
}

func TestCommandServiceRunFallsBackToExternal(t *testing.T) {
	ctx := context.Background()
	runner := &fakeExternalRunner{result: CommandResult{EphemeralText: "ran externally"}}
	svc := NewCommandService()
	svc.SetExternalRunner(runner)

	got, err := svc.Run(ctx, "deploy", CommandRequest{ParentType: ParentChannel, Text: "web"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got.EphemeralText != "ran externally" {
		t.Errorf("Run = %+v, want the external runner's result", got)
	}
	if runner.gotTrigger != "deploy" || runner.gotReq.Text != "web" {
		t.Errorf("runner received (%q, %+v), want the trigger and its arguments", runner.gotTrigger, runner.gotReq)
	}
}

// A built-in that fails reports its error rather than falling through to the
// external runner — the name is taken, and retrying it elsewhere would be wrong.
func TestCommandServiceRunBuiltinErrorDoesNotFallThrough(t *testing.T) {
	runner := &fakeExternalRunner{}
	svc := NewCommandService()
	svc.Register(&fakeCommand{info: CommandInfo{Name: "x"}, err: errors.New("boom")})
	svc.SetExternalRunner(runner)

	if _, err := svc.Run(context.Background(), "x", CommandRequest{ParentType: ParentChannel}); err == nil {
		t.Fatal("want the built-in's error")
	}
	if runner.gotTrigger != "" {
		t.Error("the external runner was consulted after a built-in failed")
	}
}

// fakeExternalRunner is a programmable ExternalCommandRunner.
type fakeExternalRunner struct {
	list       []CommandInfo
	result     CommandResult
	err        error
	gotTrigger string
	gotReq     CommandRequest
}

func (f *fakeExternalRunner) ListCommands(context.Context) []CommandInfo { return f.list }

func (f *fakeExternalRunner) RunCommand(_ context.Context, trigger string, req CommandRequest) (CommandResult, error) {
	f.gotTrigger, f.gotReq = trigger, req
	return f.result, f.err
}
