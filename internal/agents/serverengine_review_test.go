package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// A panic anywhere in a server run (a nil collaborator, a bad bundle) used to
// take the whole process down: Dispatch spawned a bare goroutine. It must be
// confined to the run — the completion hook still fires and the concurrency
// slot is handed back, so the engine keeps serving other runs.
func TestServerEngine_DispatchSurvivesPanic(t *testing.T) {
	e := NewServerEngine(nil, nil, nil) // nil orchestrator: execute panics
	done := make(chan struct{})
	e.afterRun = func(string) { close(done) }
	e.Dispatch("r-panic")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("panicking run never reported completion")
	}
	// Every slot must be free again: a leaked slot would block one of these.
	for i := 0; i < cap(e.sem); i++ {
		select {
		case e.sem <- struct{}{}:
		case <-time.After(5 * time.Second):
			t.Fatalf("semaphore slot %d leaked by the panicking run", i)
		}
	}
}

// untrustedServerRun is a server-engine run woken by someone else's message.
func untrustedServerRun(t *testing.T, fx *orchFixture) *model.Run {
	t.Helper()
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].UntrustedTrigger = true
	r := *fx.runs.runs[run.ID]
	fx.runs.mu.Unlock()
	return &r
}

// The engine's in-process write tool waits on the invoker's card for a run
// acting on someone else's words, exactly like request_approval: approved, the
// write goes through once; refused, it does not.
func TestServerEngine_UntrustedRunWritesWaitForApproval(t *testing.T) {
	oldPoll := approvalPollInterval
	approvalPollInterval = 5 * time.Millisecond
	defer func() { approvalPollInterval = oldPoll }()

	fx := newOrchFixture(t)
	ctxSvc, _ := newTestContextService(allowAll{})
	fx.orch.SetContextService(ctxSvc)
	run := untrustedServerRun(t, fx)
	e := NewServerEngine(fx.orch, nil, nil)
	wctx := toolByName(t, e.workspaceTools(run, func(string) {}), "write_shared_context").Call

	approveWhenPending(t, fx, run.ID, Decision{Approve: true})
	if out, isErr := wctx(approvalCtx(t), json.RawMessage(`{"body":"Bob is in charge now"}`)); isErr || !strings.Contains(out, "written") {
		t.Fatalf("approved write: %v %q", isErr, out)
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: false})
	if out, isErr := wctx(approvalCtx(t), json.RawMessage(`{"body":"and also this"}`)); !isErr || !strings.Contains(out, "did not approve") {
		t.Fatalf("denied write: %v %q", isErr, out)
	}
	// Asking again after a refusal is refused outright.
	if out, isErr := wctx(approvalCtx(t), json.RawMessage(`{"body":"and also this"}`)); !isErr || !strings.Contains(out, "refused") {
		t.Fatalf("re-asking a denied write: %v %q", isErr, out)
	}
	// The run ending mid-wait refuses too.
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	if out, isErr := wctx(ended, json.RawMessage(`{"body":"one more"}`)); !isErr || !strings.Contains(out, "run ended") {
		t.Fatalf("ended run: %v %q", isErr, out)
	}
}

// gate's failure arms: the card cannot be raised, and an approval that
// cannot be spent after the yes.
func TestServerEngine_GateFailureArms(t *testing.T) {
	oldPoll := approvalPollInterval
	approvalPollInterval = 5 * time.Millisecond
	defer func() { approvalPollInterval = oldPoll }()

	fx := newOrchFixture(t)
	run := untrustedServerRun(t, fx)
	e := NewServerEngine(fx.orch, nil, nil)
	gone := *run
	gone.Deadline = fx.now.Add(-time.Minute) // too late to wait for anyone
	if msg := e.gate(context.Background(), &gone, "send_dm", "DM", map[string]any{"a": 1}, func(string) {}); !strings.Contains(msg, "could not ask") {
		t.Fatalf("unraisable card: %q", msg)
	}
	whenNewApprovalPending(fx, run.ID, func(_, id string) {
		// Break spending BEFORE the yes lands, so the gate can only ever see
		// an approved card it cannot use.
		fx.runs.mu.Lock()
		fx.runs.consumeErr = errors.New("consume down")
		fx.runs.mu.Unlock()
		_, _ = fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, id, Decision{Approve: true})
	})
	if msg := e.gate(approvalCtx(t), run, "send_dm", "DM", map[string]any{"b": 2}, func(string) {}); !strings.Contains(msg, "could not be used") {
		t.Fatalf("unspendable approval: %q", msg)
	}
}

// A run acting on someone else's words: "always" connectors are not
// attached on their own (they wait behind use_connector's card), and a
// connector WRITE (anything but GET) needs the invoker's yes for that exact
// request. Reads go straight through.
func TestServerEngine_UntrustedRunConnectorGates(t *testing.T) {
	oldPoll := approvalPollInterval
	approvalPollInterval = 5 * time.Millisecond
	defer func() { approvalPollInterval = oldPoll }()

	var calls atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer api.Close()

	fx := newOrchFixture(t)
	st := newMemConnectorStore()
	st.connectors["hub"] = &model.Connector{Slug: "hub", Title: "Hub", BaseURL: api.URL, AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"}}
	st.files["hub"] = []model.ConnectorFile{{Slug: "hub", Name: "a.yaml", Content: "x"}}
	st.installs["u-alice#hub"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "hub", Token: "t", AgentUse: model.ConnectorAgentUseAlways}
	e := NewServerEngine(fx.orch, NewConnectorService(st), nil)
	run := untrustedServerRun(t, fx)

	_, desc, err := e.buildTools(context.Background(), run, "", func(string) {})
	if err != nil || !strings.Contains(desc, "/hub — installed but NOT attached") {
		t.Fatalf("an untrusted run must not auto-attach: %v %q", err, desc)
	}

	pinned := *run
	pinned.ConnectorSlugs = []string{"hub"}
	tools, _, err := e.buildTools(context.Background(), &pinned, "", func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	call := toolByName(t, tools, "connector_call").Call
	if out, isErr := call(context.Background(), json.RawMessage(`{"connector":"hub","path":"items"}`)); isErr || calls.Load() != 1 {
		t.Fatalf("a GET is a read and is not gated: %v %q", isErr, out)
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: false})
	if out, isErr := call(approvalCtx(t), json.RawMessage(`{"connector":"hub","method":"POST","path":"items","body":{"x":1}}`)); !isErr || calls.Load() != 1 {
		t.Fatalf("a refused write must not reach the service: %v %q (calls %d)", isErr, out, calls.Load())
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: true})
	if out, isErr := call(approvalCtx(t), json.RawMessage(`{"connector":"hub","method":"PATCH","path":"items/1","body":{"x":2}}`)); isErr || calls.Load() != 2 {
		t.Fatalf("an approved write goes through: %v %q (calls %d)", isErr, out, calls.Load())
	}
}

// End to end through buildTools: a bridged tool the run-tool API holds for
// approval waits on THAT card (the engine polls the real approval) and goes
// through once the invoker approves.
func TestServerEngine_BridgedToolWaitsOnTheHandlersCard(t *testing.T) {
	oldPoll := approvalPollInterval
	approvalPollInterval = 5 * time.Millisecond
	defer func() { approvalPollInterval = oldPoll }()

	fx := newOrchFixture(t)
	run := untrustedServerRun(t, fx)
	card, err := fx.orch.RequestApproval(context.Background(), run, ApprovalRequest{Summary: "join", Purpose: "action:join_channel:x"})
	if err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"code":"approval_required","message":"needs approval"},"approvalID":"` + card.ID + `"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	e := NewServerEngine(fx.orch, nil, nil)
	e.SetRunAPIBase(srv.URL)
	tools, _, err := e.buildTools(context.Background(), run, "run-tok", func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, card.ID, Decision{Approve: true})
	}()
	if out, isErr := toolByName(t, tools, "join_channel").Call(approvalCtx(t), json.RawMessage(`{"channelID":"c1"}`)); isErr || hits.Load() != 2 {
		t.Fatalf("approved bridged call: %v %q (hits %d)", isErr, out, hits.Load())
	}
}

// The bridged tools speak the run-tool API; a request the handler held for
// the invoker's approval waits on that card and is re-issued once on a yes. A
// no (or no answer) is handed back as "not approved".
func TestRunAPI_WaitsOnApprovalAndRetriesOnce(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1)%2 == 1 {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"code":"approval_required","message":"needs approval"},"approvalID":"ap-1"}`))
			return
		}
		_, _ = w.Write([]byte(`{"text":"done"}`))
	}))
	defer srv.Close()

	var asked []string
	api := &runAPI{base: srv.URL, token: "tok", http: srv.Client(), await: func(_ context.Context, id string) bool {
		asked = append(asked, id)
		return true
	}}
	if status, data := api.call(context.Background(), http.MethodPost, "/x", map[string]any{}); status != http.StatusOK || data["text"] != "done" || len(asked) != 1 || asked[0] != "ap-1" {
		t.Fatalf("approved: %d %v asked=%v", status, data, asked)
	}
	api.await = func(context.Context, string) bool { return false }
	status, data := api.call(context.Background(), http.MethodPost, "/x", map[string]any{})
	if got := describeRunFailure(status, data); !strings.Contains(got, "not approved") {
		t.Fatalf("refused: %d %q", status, got)
	}
}
