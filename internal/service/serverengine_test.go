package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"

	"github.com/DigitalTolk/ex/internal/bedrock"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeBedrock scripts Converse responses for engine tests.
type fakeBedrock struct {
	outs  []*bedrockruntime.ConverseOutput
	calls []*bedrockruntime.ConverseInput
}

func (f *fakeBedrock) Converse(_ context.Context, in *bedrockruntime.ConverseInput, _ ...func(*bedrockruntime.Options)) (*bedrockruntime.ConverseOutput, error) {
	f.calls = append(f.calls, in)
	if len(f.calls) > len(f.outs) {
		return nil, errors.New("fake bedrock: out of responses")
	}
	return f.outs[len(f.calls)-1], nil
}

func bedrockText(text string) *bedrockruntime.ConverseOutput {
	return &bedrockruntime.ConverseOutput{
		StopReason: types.StopReasonEndTurn,
		Usage:      &types.TokenUsage{InputTokens: aws.Int32(9), OutputTokens: aws.Int32(6)},
		Output: &types.ConverseOutputMemberMessage{Value: types.Message{
			Role:    types.ConversationRoleAssistant,
			Content: []types.ContentBlock{&types.ContentBlockMemberText{Value: text}},
		}},
	}
}

func bedrockToolCall(tool string, input map[string]any) *bedrockruntime.ConverseOutput {
	return &bedrockruntime.ConverseOutput{
		StopReason: types.StopReasonToolUse,
		Usage:      &types.TokenUsage{InputTokens: aws.Int32(4), OutputTokens: aws.Int32(2)},
		Output: &types.ConverseOutputMemberMessage{Value: types.Message{
			Role: types.ConversationRoleAssistant,
			Content: []types.ContentBlock{&types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{
				ToolUseId: aws.String("tu-1"), Name: aws.String(tool), Input: document.NewLazyDocument(input),
			}}},
		}},
	}
}

// mapLookup adapts a plain map to connectorCall's live-lookup signature.
func mapLookup(m map[string]RunnerConnector) func(string) (RunnerConnector, bool) {
	return func(slug string) (RunnerConnector, bool) {
		c, ok := m[slug]
		return c, ok
	}
}

// dispatchAndWait runs one server execution to completion via the engine.
func dispatchAndWait(t *testing.T, e *ServerEngine, runID string) {
	t.Helper()
	done := make(chan struct{})
	e.afterRun = func(string) { close(done) }
	e.Dispatch(runID)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("server run did not finish")
	}
}

func TestServerEngine_CompletesRunAndPostsAnswer(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	e := NewServerEngine(fx.orch, nil, &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{bedrockText("hello from bedrock")}})
	dispatchAndWait(t, e, run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCompleted {
		t.Fatalf("state: %s (fail=%q)", got.State, got.FailReason)
	}
	if !strings.Contains(fx.msgs.lastPost(), "hello from bedrock") {
		t.Fatalf("final text not posted: %q", fx.msgs.lastPost())
	}
	// Live usage events must have landed on the ledger (not double-counted at
	// complete: one turn → 9 in / 6 out exactly).
	if got.Spend.InputTokens != 9 || got.Spend.OutputTokens != 6 || got.Spend.Turns != 1 {
		t.Fatalf("spend: %+v", got.Spend)
	}
}

func TestServerEngine_ConnectorToolRoundTrip(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	// A connected service the model will call: assert pinned URL + bearer auth.
	var gotAuth, gotPath, gotQuery string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath, gotQuery = r.Header.Get("Authorization"), r.URL.Path, r.URL.RawQuery
		_, _ = w.Write([]byte(`{"people":[{"name":"Monica"}]}`))
	}))
	defer api.Close()

	st := newMemConnectorStore()
	st.connectors["hub"] = &model.Connector{Slug: "hub", Title: "Hub", BaseURL: api.URL, AuthKind: model.ConnectorAuthPaste, FileNames: []string{"api.yaml"}}
	st.files["hub"] = []model.ConnectorFile{{Slug: "hub", Name: "api.yaml", Content: "endpoints: [people]"}}
	st.installs["u-alice#hub"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "hub", Token: "tok-123"}
	connSvc := NewConnectorService(st)

	// The run carries the /hub pick.
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].ConnectorSlugs = []string{"hub"}
	fx.runs.mu.Unlock()

	fb := &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{
		bedrockToolCall("connector_doc", map[string]any{"connector": "hub", "file": "_USAGE.md"}),
		bedrockToolCall("connector_call", map[string]any{"connector": "hub", "path": "api/people", "query": map[string]any{"per_page": "5"}}),
		bedrockText("Monica is on the list"),
	}}
	e := NewServerEngine(fx.orch, connSvc, fb)
	dispatchAndWait(t, e, run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCompleted {
		t.Fatalf("state: %s (fail=%q)", got.State, got.FailReason)
	}
	if gotAuth != "Bearer tok-123" || gotPath != "/api/people" || gotQuery != "per_page=5" {
		t.Fatalf("connector call wrong: auth=%q path=%q query=%q", gotAuth, gotPath, gotQuery)
	}
	// The system prompt advertised the connected service and its doc files.
	sys := fb.calls[0].System[0].(*types.SystemContentBlockMemberText).Value
	if !strings.Contains(sys, "/hub — Hub") || !strings.Contains(sys, "_USAGE.md") {
		t.Fatalf("system prompt missing connector section: %q", sys)
	}
}

// The header shape is the connector's: an API-key connector calls with its
// own header and never Authorization; an anonymous one sends no credential
// header at all.
func TestServerEngine_ConnectorCallHonoursAuthHeader(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	got := map[string]http.Header{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got[r.URL.Path] = r.Header.Clone()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer api.Close()

	st := newMemConnectorStore()
	st.connectors["mb"] = &model.Connector{Slug: "mb", Title: "Metabase", BaseURL: api.URL, AuthKind: model.ConnectorAuthPaste, AuthHeader: "X-Api-Key: {token}", FileNames: []string{"api.yaml"}}
	st.files["mb"] = []model.ConnectorFile{{Slug: "mb", Name: "api.yaml", Content: "endpoints: [user]"}}
	st.installs["u-alice#mb"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "mb", Token: "mb_key"}
	st.connectors["open"] = &model.Connector{Slug: "open", Title: "Open", BaseURL: api.URL, AuthKind: model.ConnectorAuthNone, FileNames: []string{"api.yaml"}}
	st.files["open"] = []model.ConnectorFile{{Slug: "open", Name: "api.yaml", Content: "endpoints: [status]"}}
	st.installs["u-alice#open"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "open"}
	connSvc := NewConnectorService(st)

	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].ConnectorSlugs = []string{"mb", "open"}
	fx.runs.mu.Unlock()

	fb := &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{
		bedrockToolCall("connector_call", map[string]any{"connector": "mb", "path": "api/user/current"}),
		bedrockToolCall("connector_call", map[string]any{"connector": "open", "path": "status"}),
		bedrockText("done"),
	}}
	e := NewServerEngine(fx.orch, connSvc, fb)
	dispatchAndWait(t, e, run.ID)

	mb := got["/api/user/current"]
	if mb == nil || mb.Get("X-Api-Key") != "mb_key" || mb.Get("Authorization") != "" {
		t.Fatalf("metabase call headers wrong: %v", mb)
	}
	open := got["/status"]
	if open == nil || open.Get("Authorization") != "" || open.Get("X-Api-Key") != "" {
		t.Fatalf("anonymous call must carry no credential header: %v", open)
	}
}

func TestServerEngine_LoopFailureFailsRun(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	// Empty script → first Converse errors → run must fail, not hang.
	e := NewServerEngine(fx.orch, nil, &fakeBedrock{})
	dispatchAndWait(t, e, run.ID)
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "bedrock_error" {
		t.Fatalf("expected bedrock_error failure, got %s/%q", got.State, got.FailReason)
	}
}

func TestServerEngine_ClaimRefusesTaskMode(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Mode = model.RunModeTask
	fx.runs.mu.Unlock()

	if _, _, err := fx.orch.claimServerRun(context.Background(), run.ID); err == nil {
		t.Fatal("task-mode server claim must fail")
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "task_needs_runner" {
		t.Fatalf("task run not failed legibly: %s/%q", got.State, got.FailReason)
	}
	// A terminal run can't be claimed again.
	if _, _, err := fx.orch.claimServerRun(context.Background(), run.ID); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("expected ErrRunClosed, got %v", err)
	}
}

func TestServerEngine_ConnectorCallGuards(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("nope"))
	}))
	defer api.Close()
	e := &ServerEngine{http: api.Client()}
	bySlug := map[string]RunnerConnector{"hub": {Slug: "hub", BaseURL: api.URL, Token: "t"}}

	call := func(input string) (string, bool) {
		return e.connectorCall(context.Background(), mapLookup(bySlug), json.RawMessage(input))
	}
	if out, isErr := call(`{"connector":"nope","path":"x"}`); !isErr || !strings.Contains(out, "not attached") {
		t.Fatalf("unknown connector: %q", out)
	}
	if out, isErr := call(`{"connector":"hub","method":"DELETE","path":"x"}`); !isErr || !strings.Contains(out, "DELETE") {
		t.Fatalf("delete guard: %q", out)
	}
	if out, isErr := call(`{"connector":"hub","method":"TRACE","path":"x"}`); !isErr || !strings.Contains(out, "unsupported method") {
		t.Fatalf("method guard: %q", out)
	}
	if out, isErr := call(`{"connector":"hub","path":"../secrets"}`); !isErr || !strings.Contains(out, "bad path") {
		t.Fatalf("path traversal guard: %q", out)
	}
	if out, isErr := call(`{"connector":"hub","path":"https://evil.example"}`); !isErr || !strings.Contains(out, "bad path") {
		t.Fatalf("absolute url guard: %q", out)
	}
	if out, isErr := call(`not json`); !isErr || !strings.Contains(out, "bad input") {
		t.Fatalf("bad input: %q", out)
	}
	// A base that can't form a valid URL dies at request construction.
	broken := map[string]RunnerConnector{"hub": {Slug: "hub", BaseURL: "ht tp://broken", Token: "t"}}
	if out, isErr := e.connectorCall(context.Background(), mapLookup(broken), json.RawMessage(`{"connector":"hub","path":"x"}`)); !isErr || !strings.Contains(out, "request build failed") {
		t.Fatalf("unparsable base: %q", out)
	}
	// The outbound gate itself: under the production posture (no private
	// targets), the plain-HTTP loopback base is refused before any request.
	AllowPrivateConnectorTargets(false)
	out, isErr := call(`{"connector":"hub","path":"x"}`)
	AllowPrivateConnectorTargets(true)
	if !isErr || !strings.Contains(out, "blocked url") {
		t.Fatalf("outbound gate: %q", out)
	}
	// 4xx surfaces as an error result carrying the status + body.
	if out, isErr := call(`{"connector":"hub","path":"missing"}`); !isErr || !strings.Contains(out, "HTTP 404") || !strings.Contains(out, "nope") {
		t.Fatalf("status surface: %q", out)
	}
}

func TestOrchestrator_InvokeDispatchesToServerEngine(t *testing.T) {
	fx := newOrchFixture(t)
	// Alice pins gg to bedrock + server execution.
	h, m := model.HarnessBedrock, model.ExecutionServer
	if _, err := fx.orch.agentSvc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{Harness: &h, ExecutionMode: &m}); err != nil {
		t.Fatalf("prefs: %v", err)
	}
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	msg := &model.Message{ID: "m-srv", ParentID: "chan1", AuthorID: "u-alice", Body: "hi"}
	in := invocation{agent: agent, invoker: invoker, msg: msg, parentType: ParentChannel}

	// Engine unwired → legible offline error, no run row left behind.
	if err := fx.orch.invoke(context.Background(), in); !errors.Is(err, ErrAgentOffline) {
		t.Fatalf("unwired server engine: want ErrAgentOffline, got %v", err)
	}

	// Wired → run queued and handed to the dispatcher, no desktop runner involved.
	got := make(chan string, 1)
	fx.orch.SetServerEngine(dispatcherFunc(func(runID string) { got <- runID }))
	if err := fx.orch.invoke(context.Background(), in); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	select {
	case runID := <-got:
		run, err := fx.runs.GetRun(context.Background(), runID)
		if err != nil {
			t.Fatalf("run row: %v", err)
		}
		if run.Harness != model.HarnessBedrock || run.ExecutionMode != model.ExecutionServer {
			t.Fatalf("run engine fields: %s/%s", run.Harness, run.ExecutionMode)
		}
		if run.Model == "" {
			t.Fatal("API-harness run must resolve a model id")
		}
	case <-time.After(time.Second):
		t.Fatal("server engine never dispatched")
	}
}

type dispatcherFunc func(runID string)

func (f dispatcherFunc) Dispatch(runID string) { f(runID) }

// mintFunc is a runTokenMinter whose behavior the test chooses per call.
type mintFunc func() (string, error)

func (f mintFunc) GenerateRunToken(_, _, _ string, _ time.Time) (string, error) { return f() }

func TestAgentService_Template(t *testing.T) {
	fx := newOrchFixture(t)
	tpl, err := fx.orch.agentSvc.Template(context.Background(), AgentSlugGG)
	if err != nil || tpl == nil || tpl.Slug != AgentSlugGG {
		t.Fatalf("template read: %+v %v", tpl, err)
	}
	if _, err := fx.orch.agentSvc.Template(context.Background(), "nope"); err == nil {
		t.Fatal("unknown slug must error")
	}
}

func TestAgentService_SetAgentEngine(t *testing.T) {
	fx := newOrchFixture(t)
	svc := fx.orch.agentSvc

	tpl, err := svc.SetAgentEngine(context.Background(), AgentSlugGG, model.HarnessBedrock, "", model.ExecutionServer)
	if err != nil {
		t.Fatalf("set engine: %v", err)
	}
	if tpl.Harness != model.HarnessBedrock || tpl.ExecutionMode != model.ExecutionServer {
		t.Fatalf("template not repinned: %+v", tpl)
	}
	if tpl.Model != "" {
		t.Fatalf("harness change without model must clear the model, got %q", tpl.Model)
	}
	// Resolve now supplies the platform default model for the API harness.
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	resolved, err := svc.Resolve(context.Background(), agent, "u-alice")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if resolved.Harness != model.HarnessBedrock || resolved.Model == "" || resolved.ExecutionMode != model.ExecutionServer {
		t.Fatalf("resolved: %+v", resolved)
	}

	if tpl, err = svc.SetAgentEngine(context.Background(), AgentSlugGG, model.HarnessBedrock, "eu.anthropic.claude-sonnet", ""); err != nil || tpl.Model != "eu.anthropic.claude-sonnet" {
		t.Fatalf("explicit model: %v %+v", err, tpl)
	}

	for _, bad := range []struct{ h, m, e string }{
		{"warp", "", ""},                       // unknown harness
		{model.HarnessClaude, "", "server"},    // exec mode on a CLI harness
		{model.HarnessBedrock, "", "sideways"}, // unknown exec mode
	} {
		if _, err := svc.SetAgentEngine(context.Background(), AgentSlugGG, bad.h, bad.m, bad.e); !errors.Is(err, ErrValidation) {
			t.Fatalf("want ErrValidation for %+v, got %v", bad, err)
		}
	}
	if _, err := svc.SetAgentEngine(context.Background(), "ghost", model.HarnessClaude, "", ""); err == nil {
		t.Fatal("unknown slug must fail")
	}
}

// makeCtxAware makes the fake refuse calls once the loop's context is dead —
// the real SDK does — so abort-path tests terminate.
type ctxAwareBedrock struct{ inner *fakeBedrock }

func (c *ctxAwareBedrock) Converse(ctx context.Context, in *bedrockruntime.ConverseInput, opts ...func(*bedrockruntime.Options)) (*bedrockruntime.ConverseOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.inner.Converse(ctx, in, opts...)
}

func TestServerEngine_DispatchOnClosedRun(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].State = model.RunStateCompleted
	fx.runs.mu.Unlock()

	e := NewServerEngine(fx.orch, nil, &fakeBedrock{})
	dispatchAndWait(t, e, run.ID) // claim fails; engine must return, not panic
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCompleted {
		t.Fatalf("closed run touched: %s", got.State)
	}
}

func TestServerEngine_AbortOnTokenBudget(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Limits.MaxTokens = 1 // first turn's usage blows it
	fx.runs.mu.Unlock()

	// Endless tool-caller: only the abort can end this run.
	fb := &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{
		bedrockToolCall("connector_doc", map[string]any{}),
		bedrockToolCall("connector_doc", map[string]any{}),
		bedrockToolCall("connector_doc", map[string]any{}),
	}}
	e := NewServerEngine(fx.orch, nil, &ctxAwareBedrock{inner: fb})
	dispatchAndWait(t, e, run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "token_budget" {
		t.Fatalf("expected token_budget abort, got %s/%q", got.State, got.FailReason)
	}
}

func TestServerEngine_StoreLossMidRun(t *testing.T) {
	// The run row vanishes right after the claim: every subsequent report and
	// the final complete hit plain store errors — the engine logs and moves on
	// instead of wedging.
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	var gets int
	fx.runs.onGetRun = func(id string) {
		if id != run.ID {
			return
		}
		gets++
		if gets == 2 { // 1 = claim; drop before the first report's read
			fx.runs.dropRun(run.ID)
		}
	}
	e := NewServerEngine(fx.orch, nil, &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{bedrockText("into the void")}})
	dispatchAndWait(t, e, run.ID)
	if _, err := fx.runs.GetRun(context.Background(), run.ID); !errors.Is(err, ErrRunClosedSentinel()) && err == nil {
		t.Fatal("run row should be gone")
	}
}

// ErrRunClosedSentinel keeps the assertion honest without importing store in
// two places: the row is deleted, so any non-nil error is acceptable.
func ErrRunClosedSentinel() error { return errors.New("gone") }

func TestServerEngine_ConnectorLoadFailure(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].ConnectorSlugs = []string{"hub"}
	fx.runs.mu.Unlock()

	st := newMemConnectorStore()
	st.failListInstalls = errors.New("dynamo down")
	e := NewServerEngine(fx.orch, NewConnectorService(st), &fakeBedrock{})
	dispatchAndWait(t, e, run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "connector_load_failed" {
		t.Fatalf("expected connector_load_failed, got %s/%q", got.State, got.FailReason)
	}
}

func TestServerEngine_ConnectorLoadFailureAndFailRunFailure(t *testing.T) {
	// Connector load fails AND the fail-run write fails (row dropped after the
	// state report) — the engine survives both.
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].ConnectorSlugs = []string{"hub"}
	fx.runs.mu.Unlock()
	var gets int
	fx.runs.onGetRun = func(id string) {
		if id == run.ID {
			gets++
			if gets == 3 { // 1 claim, 2 state report, 3 FailRun
				fx.runs.dropRun(run.ID)
			}
		}
	}
	st := newMemConnectorStore()
	st.failListInstalls = errors.New("dynamo down")
	e := NewServerEngine(fx.orch, NewConnectorService(st), &fakeBedrock{})
	dispatchAndWait(t, e, run.ID) // must terminate without panic
}

func TestServerEngine_EmptyConnectorRows(t *testing.T) {
	// Slugs picked but nothing installed → no tools, no "Connected services"
	// section, run still completes.
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].ConnectorSlugs = []string{"hub"}
	fx.runs.mu.Unlock()

	fb := &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{bedrockText("plain")}}
	e := NewServerEngine(fx.orch, NewConnectorService(newMemConnectorStore()), fb)
	dispatchAndWait(t, e, run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCompleted {
		t.Fatalf("state: %s/%q", got.State, got.FailReason)
	}
	sys := fb.calls[0].System[0].(*types.SystemContentBlockMemberText).Value
	if strings.Contains(sys, "Connected services") {
		t.Fatal("no-install run must not advertise connectors")
	}
}

func TestServerEngine_DocToolArms(t *testing.T) {
	st := newMemConnectorStore()
	st.connectors["hub"] = &model.Connector{Slug: "hub", Title: "Hub", BaseURL: "https://hub.example.net", AuthKind: model.ConnectorAuthPaste, FileNames: []string{"api.yaml"}}
	st.files["hub"] = []model.ConnectorFile{{Slug: "hub", Name: "api.yaml", Content: "endpoints: []"}}
	st.installs["u1#hub"] = &model.ConnectorInstall{UserID: "u1", ConnectorSlug: "hub", Token: "t"}
	fx := newOrchFixture(t)
	e := &ServerEngine{orch: fx.orch, connectors: NewConnectorService(st), http: &http.Client{}}
	tools, desc, err := e.buildTools(context.Background(), &model.Run{InvokerID: "u1", ConnectorSlugs: []string{"hub"}}, "", func(string) {})
	if err != nil || !strings.Contains(desc, "/hub") {
		t.Fatalf("buildTools: %v", err)
	}
	doc := toolByName(t, tools, "connector_doc").Call
	if out, isErr := doc(context.Background(), json.RawMessage(`not json`)); !isErr || !strings.Contains(out, "bad input") {
		t.Fatalf("bad input: %q", out)
	}
	if out, isErr := doc(context.Background(), json.RawMessage(`{"connector":"ghost","file":"x"}`)); !isErr || !strings.Contains(out, "not attached") {
		t.Fatalf("unknown connector: %q", out)
	}
	if out, isErr := doc(context.Background(), json.RawMessage(`{"connector":"hub","file":"ghost.yaml"}`)); !isErr || !strings.Contains(out, "no such file") {
		t.Fatalf("missing file: %q", out)
	}
	if out, isErr := doc(context.Background(), json.RawMessage(`{"connector":"hub","file":"API.YAML"}`)); isErr || out != "endpoints: []" {
		t.Fatalf("doc read: %q %v", out, isErr)
	}
}

func TestServerEngine_ConnectorCallSeamsAndBody(t *testing.T) {
	var gotBody string
	big := strings.Repeat("z", connectorResponseCap+100)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_, _ = w.Write([]byte(big))
	}))
	defer api.Close()
	e := &ServerEngine{http: api.Client()}
	bySlug := map[string]RunnerConnector{"hub": {Slug: "hub", BaseURL: api.URL, Token: "t"}}

	// Happy POST with body — response over the cap gets truncated.
	out, isErr := e.connectorCall(context.Background(), mapLookup(bySlug), json.RawMessage(`{"connector":"hub","method":"POST","path":"x","body":{"a":1}}`))
	if isErr || !strings.Contains(out, "HTTP 200") || !strings.Contains(out, "[response truncated]") {
		t.Fatalf("post+truncate: err=%v %q", isErr, out[:80])
	}
	if gotBody != `{"a":1}` {
		t.Fatalf("body sent: %q", gotBody)
	}

	// Seam: body marshal failure.
	old := marshalJSON
	marshalJSON = func(any) ([]byte, error) { return nil, errors.New("marshal boom") }
	out, isErr = e.connectorCall(context.Background(), mapLookup(bySlug), json.RawMessage(`{"connector":"hub","path":"x","body":{}}`))
	marshalJSON = old
	if !isErr || !strings.Contains(out, "bad body") {
		t.Fatalf("marshal seam: %q", out)
	}

	// Seam: request construction failure.
	oldReq := newRequest
	newRequest = func(context.Context, string, string, io.Reader) (*http.Request, error) {
		return nil, errors.New("request boom")
	}
	out, isErr = e.connectorCall(context.Background(), mapLookup(bySlug), json.RawMessage(`{"connector":"hub","path":"x"}`))
	newRequest = oldReq
	if !isErr || !strings.Contains(out, "request build failed") {
		t.Fatalf("request seam: %q", out)
	}

	// Transport failure: server gone.
	api.Close()
	out, isErr = e.connectorCall(context.Background(), mapLookup(bySlug), json.RawMessage(`{"connector":"hub","path":"x"}`))
	if !isErr || !strings.Contains(out, "request failed") {
		t.Fatalf("transport arm: %q", out)
	}
}

func TestServerSystemRules_WatchInstruction(t *testing.T) {
	s := serverSystemRules(&Assignment{AgentName: "qib", InvokerName: "Alice", Persona: "p", WatchInstruction: "watch deploys"}, "")
	if !strings.Contains(s, "Standing order") || !strings.Contains(s, "watch deploys") || !strings.Contains(s, "SKIP") {
		t.Fatalf("watch rules missing: %q", s)
	}
}

func TestOrchestrator_ClaimServerRunArms(t *testing.T) {
	fx := newOrchFixture(t)

	// Unknown run id.
	if _, _, err := fx.orch.claimServerRun(context.Background(), "nope"); err == nil {
		t.Fatal("missing run must fail")
	}

	// ClaimRun loses the race.
	run := fx.startRun(t)
	fx.runs.failClaim = store.ErrStaleRun
	if _, _, err := fx.orch.claimServerRun(context.Background(), run.ID); !errors.Is(err, store.ErrStaleRun) {
		t.Fatalf("claim race: %v", err)
	}
	fx.runs.failClaim = nil

	// Deadline re-base hits a STALE write → run considered closed.
	fx.runs.failUpdateOnce = store.ErrStaleRun
	if _, _, err := fx.orch.claimServerRun(context.Background(), run.ID); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("stale re-base: %v", err)
	}

	// Re-base hits a PLAIN write error → warn and claim anyway; a users
	// lookup failure degrades names to raw ids rather than failing the claim.
	run2ID := func() string {
		msg := &model.Message{ID: "m2", ParentID: "chan2", AuthorID: "u-alice", Body: "hi"}
		agent, _ := fx.users.GetUser(context.Background(), testGGID)
		invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
		resolved, _ := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
		r, err := fx.orch.startRun(context.Background(), invocation{agent: agent, invoker: invoker, msg: msg, parentType: ParentChannel}, resolved)
		if err != nil {
			t.Fatalf("start run2: %v", err)
		}
		return r.ID
	}()
	fx.runs.failUpdateOnce = errors.New("dynamo hiccup")
	fx.users.failByIDs = errors.New("users down")
	asg, _, err := fx.orch.claimServerRun(context.Background(), run2ID)
	fx.users.failByIDs = nil
	if err != nil {
		t.Fatalf("plain re-base error must not fail the claim: %v", err)
	}
	if asg.AgentName != testGGID || asg.InvokerID != "u-alice" {
		t.Fatalf("names must fall back to ids: %+v", asg.AgentName)
	}
	// The claim minted a run token — the bridged workspace tools ride the
	// run-tool HTTP API and are dead without one.
	if asg.MCPToken == "" {
		t.Fatal("server claim must mint a run token")
	}

	// Token mint failure fails the run legibly.
	runMintID := func() string {
		msg := &model.Message{ID: "m-mint", ParentID: "chan-mint", AuthorID: "u-alice", Body: "hi"}
		agent, _ := fx.users.GetUser(context.Background(), testGGID)
		invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
		resolved, _ := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
		r, err := fx.orch.startRun(context.Background(), invocation{agent: agent, invoker: invoker, msg: msg, parentType: ParentChannel}, resolved)
		if err != nil {
			t.Fatalf("start mint run: %v", err)
		}
		return r.ID
	}()
	goodMinter := fx.orch.tokens
	fx.orch.tokens = &orchCovMinter{fail: errors.New("kms down")}
	if _, _, err := fx.orch.claimServerRun(context.Background(), runMintID); err == nil {
		t.Fatal("mint failure must fail the claim")
	}
	fx.orch.tokens = goodMinter
	if got, _ := fx.runs.GetRun(context.Background(), runMintID); got.State != model.RunStateFailed || got.FailReason != "token_mint_failed" {
		t.Fatalf("run not failed on mint error: %+v", got)
	}
	// Mint failure whose fail write ALSO fails (warn arm).
	runMint2ID := func() string {
		msg := &model.Message{ID: "m-mint2", ParentID: "chan-mint2", AuthorID: "u-alice", Body: "hi"}
		agent, _ := fx.users.GetUser(context.Background(), testGGID)
		invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
		resolved, _ := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
		r, err := fx.orch.startRun(context.Background(), invocation{agent: agent, invoker: invoker, msg: msg, parentType: ParentChannel}, resolved)
		if err != nil {
			t.Fatalf("start mint run2: %v", err)
		}
		return r.ID
	}()
	// The store break must land AFTER the acknowledge write (which would
	// otherwise consume the one-shot failure), so the minter itself plants it.
	fx.orch.tokens = mintFunc(func() (string, error) {
		fx.runs.failUpdateOnce = errors.New("dynamo hiccup")
		return "", errors.New("kms down")
	})
	if _, _, err := fx.orch.claimServerRun(context.Background(), runMint2ID); err == nil {
		t.Fatal("mint failure must fail the claim even when the fail write errors")
	}
	fx.orch.tokens = goodMinter

	// Task-mode refusal whose fail write ALSO fails (warn arm).
	run3ID := func() string {
		msg := &model.Message{ID: "m3", ParentID: "chan3", AuthorID: "u-alice", Body: "hi"}
		agent, _ := fx.users.GetUser(context.Background(), testGGID)
		invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
		resolved, _ := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
		r, err := fx.orch.startRun(context.Background(), invocation{agent: agent, invoker: invoker, msg: msg, parentType: ParentChannel}, resolved)
		if err != nil {
			t.Fatalf("start run3: %v", err)
		}
		return r.ID
	}()
	fx.runs.mu.Lock()
	fx.runs.runs[run3ID].Mode = model.RunModeTask
	fx.runs.mu.Unlock()
	fx.runs.failUpdateOnce = errors.New("dynamo hiccup")
	if _, _, err := fx.orch.claimServerRun(context.Background(), run3ID); err == nil {
		t.Fatal("task-mode server claim must fail")
	}
}

func TestOrchestrator_ServerInvokeBusyThread(t *testing.T) {
	fx := newOrchFixture(t)
	h, m := model.HarnessBedrock, model.ExecutionServer
	if _, err := fx.orch.agentSvc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{Harness: &h, ExecutionMode: &m}); err != nil {
		t.Fatalf("prefs: %v", err)
	}
	fx.orch.SetServerEngine(dispatcherFunc(func(string) {})) // never completes
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	in := invocation{agent: agent, invoker: invoker, msg: &model.Message{ID: "mb", ParentID: "chanb", AuthorID: "u-alice", Body: "hi"}, parentType: ParentChannel}
	if err := fx.orch.invoke(context.Background(), in); err != nil {
		t.Fatalf("first invoke: %v", err)
	}
	// Same THREAD (a reply under the first mention) while the first run is
	// still active → the turn dedup rejects it.
	in.msg = &model.Message{ID: "mb2", ParentID: "chanb", ParentMessageID: "mb", AuthorID: "u-alice", Body: "again"}
	if err := fx.orch.invoke(context.Background(), in); !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("second invoke in same thread: want ErrAgentBusy, got %v", err)
	}
}

func TestAgentService_SetAgentEngine_PutFailure(t *testing.T) {
	fx := newOrchFixture(t)
	fx.dir.failPutTemplate = errors.New("dynamo down")
	if _, err := fx.orch.agentSvc.SetAgentEngine(context.Background(), AgentSlugGG, model.HarnessClaude, "", ""); err == nil || !strings.Contains(err.Error(), "set engine") {
		t.Fatalf("put failure must surface: %v", err)
	}
}

func TestServerEngine_LoopAndFailRunBothFail(t *testing.T) {
	// The model call errors AND the fail-run write errors (row dropped before
	// FailRun's read) — the warn arm, engine still terminates.
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	var gets int
	fx.runs.onGetRun = func(id string) {
		if id == run.ID {
			gets++
			if gets == 3 { // 1 claim, 2 state report, 3 FailRun
				fx.runs.dropRun(run.ID)
			}
		}
	}
	e := NewServerEngine(fx.orch, nil, &fakeBedrock{}) // no scripted responses → loop error
	dispatchAndWait(t, e, run.ID)
}

func TestOrchestrator_RunnersNeverClaimServerRuns(t *testing.T) {
	// The desktop runner advertises the bedrock harness too — but a
	// server-mode run belongs to the backend engine alone. Before this guard,
	// the runner's long-poll raced the engine for the queued run and, on
	// winning, executed it on the invoker's LOCAL AWS credentials.
	fx := newOrchFixture(t)
	_ = fx.dir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "r-bedrock", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}, {Name: model.HarnessBedrock}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Harness = model.HarnessBedrock
	fx.runs.runs[run.ID].ExecutionMode = model.ExecutionServer
	fx.runs.mu.Unlock()

	as, err := fx.orch.Claim(context.Background(), "u-alice", "r-bedrock", []string{model.HarnessClaude, model.HarnessBedrock}, 5, 0)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(as) != 0 {
		t.Fatalf("runner must not claim a server-mode run, got %d assignments", len(as))
	}

	// The server engine still claims it fine.
	if _, _, err := fx.orch.claimServerRun(context.Background(), run.ID); err != nil {
		t.Fatalf("server claim after runner poll: %v", err)
	}
}

// toolByName finds one tool of the surface — index-free so the surface can
// grow without breaking every test.
func toolByName(t *testing.T, tools []bedrock.Tool, name string) bedrock.Tool {
	t.Helper()
	for _, tool := range tools {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %s not in surface (%d tools)", name, len(tools))
	return bedrock.Tool{}
}

func toolNames(tools []bedrock.Tool) []string {
	out := make([]string, 0, len(tools))
	for _, tool := range tools {
		out = append(out, tool.Name)
	}
	return out
}

func TestServerEngine_WorkspaceTools(t *testing.T) {
	fx := newOrchFixture(t)
	ctxSvc, _ := newTestContextService(allowAll{})
	fx.orch.SetContextService(ctxSvc)
	dm := &orchCovDM{convID: "dm-1"}
	fx.orch.SetOwnerDMResolver(dm)
	run := fx.startRun(t)
	e := NewServerEngine(fx.orch, nil, nil)

	tools := e.workspaceTools(run)
	for _, want := range []string{"get_thread", "get_context", "write_shared_context", "notify_owner", "post_message"} {
		toolByName(t, tools, want)
	}
	ctx := context.Background()

	// get_thread / get_context return text, never errors.
	if out, isErr := toolByName(t, tools, "get_thread").Call(ctx, json.RawMessage(`{}`)); isErr {
		t.Fatalf("get_thread: %q", out)
	}
	if out, isErr := toolByName(t, tools, "get_context").Call(ctx, json.RawMessage(`{}`)); isErr || out == "" {
		t.Fatalf("get_context: %q", out)
	}

	// write_shared_context: bad input, then a real write.
	wctx := toolByName(t, tools, "write_shared_context").Call
	if out, isErr := wctx(ctx, json.RawMessage(`{}`)); !isErr || !strings.Contains(out, "body required") {
		t.Fatalf("ctx bad input: %q", out)
	}
	if out, isErr := wctx(ctx, json.RawMessage(`not json`)); !isErr {
		t.Fatalf("ctx bad json: %q", out)
	}
	if out, isErr := wctx(ctx, json.RawMessage(`{"body":"decision: ship it","pinned":true}`)); isErr || !strings.Contains(out, "written") {
		t.Fatalf("ctx write: %q", out)
	}
	// A denied write surfaces as a tool error, not a crash.
	deniedCtx, _ := newTestContextService(denyAll{})
	fx.orch.SetContextService(deniedCtx)
	wdenied := toolByName(t, e.workspaceTools(run), "write_shared_context").Call
	if out, isErr := wdenied(ctx, json.RawMessage(`{"body":"nope"}`)); !isErr || !strings.Contains(out, "context write failed") {
		t.Fatalf("denied ctx write: %q", out)
	}
	fx.orch.SetContextService(ctxSvc)

	// notify_owner: bad input, DM-open failure, send failure, then success.
	notify := toolByName(t, tools, "notify_owner").Call
	if out, isErr := notify(ctx, json.RawMessage(`{}`)); !isErr {
		t.Fatalf("notify bad input: %q", out)
	}
	if out, isErr := notify(ctx, json.RawMessage(`not json`)); !isErr {
		t.Fatalf("notify bad json: %q", out)
	}
	dm.fail = errors.New("dm down")
	if out, isErr := notify(ctx, json.RawMessage(`{"body":"psst"}`)); !isErr || !strings.Contains(out, "DM open failed") {
		t.Fatalf("notify dm fail: %q", out)
	}
	dm.fail = nil
	fx.msgs.failSendOnce = errors.New("send down")
	if out, isErr := notify(ctx, json.RawMessage(`{"body":"psst"}`)); !isErr || !strings.Contains(out, "DM send failed") {
		t.Fatalf("notify send fail: %q", out)
	}
	if out, isErr := notify(ctx, json.RawMessage(`{"body":"psst"}`)); isErr || !strings.Contains(out, "privately") {
		t.Fatalf("notify: %q", out)
	}
	if !strings.Contains(fx.msgs.lastPost(), "psst") {
		t.Fatal("notify body never sent")
	}

	// post_message: bad input, post-cap, store loss, send failure,
	// RecordAgentPost failure (remaining=0 arm), then success.
	post := toolByName(t, tools, "post_message").Call
	if out, isErr := post(ctx, json.RawMessage(`{"body":"  "}`)); !isErr {
		t.Fatalf("post bad input: %q", out)
	}
	if out, isErr := post(ctx, json.RawMessage(`not json`)); !isErr {
		t.Fatalf("post bad json: %q", out)
	}
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Spend.Posts = run.Limits.MaxPosts
	fx.runs.mu.Unlock()
	if out, isErr := post(ctx, json.RawMessage(`{"body":"x"}`)); !isErr || !strings.Contains(out, "post cap") {
		t.Fatalf("post cap: %q", out)
	}
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Spend.Posts = 0
	fx.runs.mu.Unlock()
	fx.msgs.failSendOnce = errors.New("send down")
	if out, isErr := post(ctx, json.RawMessage(`{"body":"x"}`)); !isErr || !strings.Contains(out, "post rejected") {
		t.Fatalf("post send fail: %q", out)
	}
	fx.runs.failAddPostsOnce = errors.New("ledger down")
	if out, isErr := post(ctx, json.RawMessage(`{"body":"y"}`)); isErr || !strings.Contains(out, "0 post(s) remaining") {
		t.Fatalf("post with ledger failure must still succeed: %q", out)
	}
	if out, isErr := post(ctx, json.RawMessage(`{"body":"part one"}`)); isErr || !strings.Contains(out, "posted [m:") {
		t.Fatalf("post: %q", out)
	}

	// GetRun loss: the cap check can't read the run → rejected.
	fx.runs.dropRun(run.ID)
	if out, isErr := post(ctx, json.RawMessage(`{"body":"z"}`)); !isErr || !strings.Contains(out, "post rejected") {
		t.Fatalf("post after store loss: %q", out)
	}
}

func TestServerEngine_WatchModesGetNoPostTool(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	e := NewServerEngine(fx.orch, nil, nil)
	for _, mode := range []string{model.WatchActionNotify, model.WatchActionDraft, model.WatchActionReply} {
		run.ActionMode = mode
		names := strings.Join(toolNames(e.workspaceTools(run)), ",")
		if strings.Contains(names, "post_message") {
			t.Fatalf("mode %s must not offer post_message: %s", mode, names)
		}
	}
	// Without ctx service and DM resolver those tools are absent too.
	run.ActionMode = ""
	names := strings.Join(toolNames(e.workspaceTools(run)), ",")
	if strings.Contains(names, "write_shared_context") || strings.Contains(names, "notify_owner") {
		t.Fatalf("unwired deps must not offer their tools: %s", names)
	}
}

func TestServerEngine_AlwaysConnectorsAutoAttach(t *testing.T) {
	fx := newOrchFixture(t)
	st := newMemConnectorStore()
	st.connectors["hub"] = &model.Connector{Slug: "hub", Title: "Hub", BaseURL: "https://hub.example.net", AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"}}
	st.files["hub"] = []model.ConnectorFile{{Slug: "hub", Name: "a.yaml", Content: "x"}}
	st.installs["u-alice#hub"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "hub", Token: "t", AgentUse: model.ConnectorAgentUseAlways}
	st.connectors["ask"] = &model.Connector{Slug: "ask", Title: "Ask", BaseURL: "https://ask.example.net", AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"}}
	st.files["ask"] = []model.ConnectorFile{{Slug: "ask", Name: "a.yaml", Content: "x"}}
	st.installs["u-alice#ask"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "ask", Token: "t", AgentUse: model.ConnectorAgentUseAsk}
	e := NewServerEngine(fx.orch, NewConnectorService(st), nil)

	// No picks: the always-install attaches; the ask-install is advertised as
	// attachable via use_connector, not attached.
	_, desc, err := e.buildTools(context.Background(), &model.Run{ID: "r1", InvokerID: "u-alice"}, "", func(string) {})
	if err != nil {
		t.Fatalf("buildTools: %v", err)
	}
	if !strings.Contains(desc, "/hub — Hub") || !strings.Contains(desc, "/ask — installed but NOT attached") {
		t.Fatalf("always-attach wrong: %q", desc)
	}

	// Picks and always-installs merge without duplicates; a picked ask-install
	// attaches directly.
	tools, desc2, err := e.buildTools(context.Background(), &model.Run{ID: "r2", InvokerID: "u-alice", ConnectorSlugs: []string{"hub", "ask"}}, "", func(string) {})
	if err != nil || strings.Count(desc2, "/hub") != 1 || !strings.Contains(desc2, "/ask — Ask") {
		t.Fatalf("merge: %v %q", err, desc2)
	}
	toolByName(t, tools, "connector_call")
	toolByName(t, tools, "use_connector")

	// Index failure degrades to picks only.
	st.failListInstalls = errors.New("dynamo down")
	if _, _, err := e.buildTools(context.Background(), &model.Run{ID: "r3", InvokerID: "u-alice"}, "", func(string) {}); err != nil {
		t.Fatalf("index failure must not fail the run: %v", err)
	}
}

func TestAgentService_RunnerModeRejectedEverywhere(t *testing.T) {
	fx := newOrchFixture(t)
	svc := fx.orch.agentSvc
	ctx := context.Background()
	runner := model.ExecutionRunner

	if _, err := svc.UpdatePrefs(ctx, "u-alice", AgentSlugGG, AgentPrefsPatch{ExecutionMode: &runner}); !errors.Is(err, ErrValidation) {
		t.Fatalf("prefs runner: %v", err)
	}
	if _, err := svc.SetAgentEngine(ctx, AgentSlugGG, model.HarnessBedrock, "", model.ExecutionRunner); !errors.Is(err, ErrValidation) {
		t.Fatalf("engine runner: %v", err)
	}
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "srv", Persona: "p", Harness: model.HarnessBedrock, ExecutionMode: model.ExecutionRunner}); !errors.Is(err, ErrValidation) {
		t.Fatalf("create runner: %v", err)
	}
	// Legacy stored "runner" rows are coerced to server at resolve time.
	fx.dir.mu.Lock()
	fx.dir.templates[AgentSlugGG].Harness = model.HarnessBedrock
	fx.dir.templates[AgentSlugGG].ExecutionMode = model.ExecutionRunner
	fx.dir.mu.Unlock()
	agent, _ := fx.users.GetUser(ctx, testGGID)
	resolved, err := svc.Resolve(ctx, agent, "u-alice")
	if err != nil || resolved.ExecutionMode != model.ExecutionServer {
		t.Fatalf("legacy runner not coerced: %+v err=%v", resolved, err)
	}
}

func TestToolDetail(t *testing.T) {
	for _, tc := range []struct{ tool, input, want string }{
		{"connector_call", `{"connector":"hub","path":"api/people"}`, "hub API: GET api/people"},
		{"connector_call", `{"connector":"hub","method":"post","path":"api/x"}`, "hub API: POST api/x"},
		{"connector_doc", `{"connector":"hub","file":"_USAGE.md"}`, "hub doc: _USAGE.md"},
		{"use_connector", `{"connector":"hub","reason":"need people data"}`, "attach /hub: need people data"},
		{"mystery_tool", `{"x":1}`, `{"x":1}`},
		{"connector_call", `not json`, "not json"},
	} {
		if got := toolDetail(tc.tool, tc.input); got != tc.want {
			t.Fatalf("toolDetail(%s, %s) = %q, want %q", tc.tool, tc.input, got, tc.want)
		}
	}
}

// askSurfaceFixture builds an engine + run with one ask-install ("hub"), one
// never-install ("locked"), and one picked-and-attached connector ("pin").
func askSurfaceFixture(t *testing.T) (*orchFixture, *ServerEngine, *memConnectorStore, *model.Run, []bedrock.Tool, *[]string) {
	t.Helper()
	fx := newOrchFixture(t)
	st := newMemConnectorStore()
	for _, slug := range []string{"hub", "locked", "pin"} {
		st.connectors[slug] = &model.Connector{Slug: slug, Title: strings.ToUpper(slug), BaseURL: "https://" + slug + ".example.net", AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"}}
		st.files[slug] = []model.ConnectorFile{{Slug: slug, Name: "a.yaml", Content: "x"}}
	}
	st.installs["u-alice#hub"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "hub", Token: "t"} // "" = ask
	st.installs["u-alice#locked"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "locked", Token: "t", AgentUse: model.ConnectorAgentUseNever}
	st.installs["u-alice#pin"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "pin", Token: "t"}
	e := NewServerEngine(fx.orch, NewConnectorService(st), nil)
	run := fx.startRun(t)
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].ConnectorSlugs = []string{"pin"}
	run = fx.runs.runs[run.ID]
	fx.runs.mu.Unlock()
	notes := &[]string{}
	tools, desc, err := e.buildTools(context.Background(), run, "", func(s string) { *notes = append(*notes, s) })
	if err != nil {
		t.Fatalf("buildTools: %v", err)
	}
	if !strings.Contains(desc, "/hub — installed but NOT attached") || !strings.Contains(desc, "/locked — installed, but the invoker has blocked") {
		t.Fatalf("desc: %q", desc)
	}
	return fx, e, st, run, tools, notes
}

// approveWhenPending watches the fake store for the run's pending approval and
// decides it — the invoker acting on the card.
func approveWhenPending(t *testing.T, fx *orchFixture, runID string, d Decision) {
	t.Helper()
	go func() {
		for i := 0; i < 500; i++ {
			time.Sleep(2 * time.Millisecond)
			fx.runs.mu.Lock()
			var id string
			for k, a := range fx.runs.approvals {
				if strings.HasPrefix(k, runID+"#") && a.State == model.ApprovalPending {
					id = a.ID
				}
			}
			fx.runs.mu.Unlock()
			if id != "" {
				_, _ = fx.orch.DecideApproval(context.Background(), "u-alice", runID, id, d)
				return
			}
		}
	}()
}

func TestServerEngine_UseConnectorApproveFlow(t *testing.T) {
	oldPoll, oldNote := approvalPollInterval, approvalWaitNote
	approvalPollInterval, approvalWaitNote = 5*time.Millisecond, time.Millisecond
	defer func() { approvalPollInterval, approvalWaitNote = oldPoll, oldNote }()

	fx, _, _, run, tools, notes := askSurfaceFixture(t)
	use := toolByName(t, tools, "use_connector").Call

	// Let the gate sit pending across at least one poll so the still-waiting
	// note fires before the approval lands.
	time.AfterFunc(25*time.Millisecond, func() { approveWhenPending(t, fx, run.ID, Decision{Approve: true}) })
	out, isErr := use(context.Background(), json.RawMessage(`{"connector":"hub","reason":"need people data"}`))
	if isErr || !strings.Contains(out, "attached /hub") || !strings.Contains(out, "a.yaml") {
		t.Fatalf("approve flow: err=%v %q", isErr, out)
	}
	// The wait narrated itself: the initial note plus at least one
	// still-waiting reminder while the gate sat pending.
	if len(*notes) < 2 || !strings.Contains((*notes)[0], "waiting for the invoker") || !strings.Contains((*notes)[1], "still waiting") {
		t.Fatalf("wait notes: %v", *notes)
	}
	// Attached for real: connector_call now resolves the slug.
	if out, _ := toolByName(t, tools, "connector_doc").Call(context.Background(), json.RawMessage(`{"connector":"hub","file":"a.yaml"}`)); out != "x" {
		t.Fatalf("post-attach doc read: %q", out)
	}
	// Second use_connector short-circuits.
	if out, isErr := use(context.Background(), json.RawMessage(`{"connector":"hub","reason":"again"}`)); isErr || !strings.Contains(out, "already attached") {
		t.Fatalf("re-attach: %q", out)
	}
}

func TestServerEngine_UseConnectorDeniedExpiredAndErrors(t *testing.T) {
	oldPoll := approvalPollInterval
	approvalPollInterval = 5 * time.Millisecond
	defer func() { approvalPollInterval = oldPoll }()

	fx, _, st, run, tools, _ := askSurfaceFixture(t)
	use := toolByName(t, tools, "use_connector").Call
	ctx := context.Background()

	if out, isErr := use(ctx, json.RawMessage(`not json`)); !isErr || !strings.Contains(out, "bad input") {
		t.Fatalf("bad input: %q", out)
	}
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"ghost","reason":"r"}`)); !isErr || !strings.Contains(out, "not installed") {
		t.Fatalf("not installed: %q", out)
	}
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"locked","reason":"r"}`)); !isErr || !strings.Contains(out, "blocked agent-initiated use") {
		t.Fatalf("never: %q", out)
	}
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"pin","reason":"r"}`)); isErr || !strings.Contains(out, "already attached") {
		t.Fatalf("picked connector: %q", out)
	}
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"hub","reason":"  "}`)); !isErr || !strings.Contains(out, "reason is required") {
		t.Fatalf("reason: %q", out)
	}

	// Denied.
	approveWhenPending(t, fx, run.ID, Decision{Approve: false})
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"hub","reason":"r"}`)); !isErr || !strings.Contains(out, "denied") {
		t.Fatalf("denied: %q", out)
	}

	// Expired: settle the next pending approval as expired ourselves.
	go func() {
		for i := 0; i < 500; i++ {
			time.Sleep(2 * time.Millisecond)
			fx.runs.mu.Lock()
			var id string
			for k, a := range fx.runs.approvals {
				if strings.HasPrefix(k, run.ID+"#") && a.State == model.ApprovalPending {
					id = a.ID
				}
			}
			fx.runs.mu.Unlock()
			if id != "" {
				_ = fx.runs.SettleApproval(context.Background(), run.ID, id, model.ApprovalExpired, "", "", "", time.Now())
				return
			}
		}
	}()
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"hub","reason":"r"}`)); !isErr || !strings.Contains(out, "expired unanswered") {
		t.Fatalf("expired: %q", out)
	}

	// Approved but the registry row vanished before attach → legible failure.
	approveWhenPending(t, fx, run.ID, Decision{Approve: true})
	delete(st.connectors, "hub")
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"hub","reason":"r"}`)); !isErr || !strings.Contains(out, "attach failed") {
		t.Fatalf("attach failure: %q", out)
	}
	st.connectors["hub"] = &model.Connector{Slug: "hub", Title: "HUB", BaseURL: "https://hub.example.net", AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"}}

	// Run context dies while waiting.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if out, isErr := use(cancelled, json.RawMessage(`{"connector":"hub","reason":"r"}`)); !isErr || !strings.Contains(out, "run ended") {
		t.Fatalf("ctx done: %q", out)
	}

	// Approval row lost mid-wait → lookup failure surfaces.
	go func() {
		for i := 0; i < 500; i++ {
			time.Sleep(2 * time.Millisecond)
			fx.runs.mu.Lock()
			var key string
			for k, a := range fx.runs.approvals {
				if strings.HasPrefix(k, run.ID+"#") && a.State == model.ApprovalPending {
					key = k
				}
			}
			if key != "" {
				delete(fx.runs.approvals, key)
			}
			fx.runs.mu.Unlock()
			if key != "" {
				return
			}
		}
	}()
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"hub","reason":"r"}`)); !isErr || !strings.Contains(out, "approval lookup failed") {
		t.Fatalf("lookup failure: %q", out)
	}

	// Run too close to its deadline → the approval itself is refused.
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Deadline = fx.orch.now()
	run.Deadline = fx.orch.now()
	fx.runs.mu.Unlock()
	if out, isErr := use(ctx, json.RawMessage(`{"connector":"hub","reason":"r"}`)); !isErr || !strings.Contains(out, "could not raise the approval") {
		t.Fatalf("raise failure: %q", out)
	}
}

func TestServerEngine_ApprovalTools(t *testing.T) {
	oldPoll, oldNote := approvalPollInterval, approvalWaitNote
	approvalPollInterval, approvalWaitNote = 5*time.Millisecond, time.Millisecond
	defer func() { approvalPollInterval, approvalWaitNote = oldPoll, oldNote }()

	fx := newOrchFixture(t)
	e := NewServerEngine(fx.orch, NewConnectorService(newMemConnectorStore()), nil)
	run := fx.startRun(t)
	tools := e.approvalTools(run, func(string) {})
	req := toolByName(t, tools, "request_approval").Call
	ask := toolByName(t, tools, "ask_user").Call
	ctx := context.Background()

	// Bad inputs never open a gate.
	if out, isErr := req(ctx, json.RawMessage(`not json`)); !isErr || !strings.Contains(out, "requires a summary") {
		t.Fatalf("req bad json: %q", out)
	}
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"  "}`)); !isErr || !strings.Contains(out, "requires a summary") {
		t.Fatalf("req blank summary: %q", out)
	}
	if out, isErr := ask(ctx, json.RawMessage(`not json`)); !isErr || !strings.Contains(out, "requires a question") {
		t.Fatalf("ask bad json: %q", out)
	}
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"q","options":["only one"]}`)); !isErr || !strings.Contains(out, "2–5 options") {
		t.Fatalf("ask one option: %q", out)
	}

	// request_approval: approved with the invoker's note, then without.
	approveWhenPending(t, fx, run.ID, Decision{Approve: true, Text: "go ahead"})
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"post the report","risk":"low"}`)); isErr || out != "approved — proceed with the action. The invoker adds: go ahead" {
		t.Fatalf("approved+note: err=%v %q", isErr, out)
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: true})
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"post the report"}`)); isErr || out != "approved — proceed with the action" {
		t.Fatalf("approved: err=%v %q", isErr, out)
	}

	// Denied with direction, then without.
	approveWhenPending(t, fx, run.ID, Decision{Approve: false, Text: "use the seed DB instead"})
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"drop the table"}`)); !isErr || !strings.Contains(out, "They say: use the seed DB instead") {
		t.Fatalf("denied+note: %q", out)
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: false})
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"drop the table"}`)); !isErr || !strings.Contains(out, "explain and wind down") {
		t.Fatalf("denied: %q", out)
	}

	// Expired: settle the pending gate as expired ourselves.
	expireWhenPending := func() {
		go func() {
			for i := 0; i < 500; i++ {
				time.Sleep(2 * time.Millisecond)
				fx.runs.mu.Lock()
				var id string
				for k, a := range fx.runs.approvals {
					if strings.HasPrefix(k, run.ID+"#") && a.State == model.ApprovalPending {
						id = a.ID
					}
				}
				fx.runs.mu.Unlock()
				if id != "" {
					_ = fx.runs.SettleApproval(context.Background(), run.ID, id, model.ApprovalExpired, "", "", "", time.Now())
					return
				}
			}
		}()
	}
	expireWhenPending()
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"s"}`)); !isErr || !strings.Contains(out, "nobody decided in time") {
		t.Fatalf("req expired: %q", out)
	}

	// ask_user: a choice with a note, then a bare choice.
	approveWhenPending(t, fx, run.ID, Decision{Approve: true, Choice: "B", Text: "and hurry"})
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"which?","options":["A","B"]}`)); isErr || out != "the invoker chose: B — and adds: and hurry" {
		t.Fatalf("choice+note: err=%v %q", isErr, out)
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: true, Choice: "A"})
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"which?","options":["A","B"]}`)); isErr || out != "the invoker chose: A" {
		t.Fatalf("choice: err=%v %q", isErr, out)
	}

	// Dismissed with their own words, then silently.
	approveWhenPending(t, fx, run.ID, Decision{Approve: false, Text: "neither — do both"})
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"which?","options":["A","B"]}`)); !isErr || !strings.Contains(out, "answered in their own words instead: neither — do both") {
		t.Fatalf("own words: %q", out)
	}
	approveWhenPending(t, fx, run.ID, Decision{Approve: false})
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"which?","options":["A","B"]}`)); !isErr || !strings.Contains(out, "dismissed the question") {
		t.Fatalf("dismissed: %q", out)
	}

	// Timed out.
	expireWhenPending()
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"q","options":["A","B"]}`)); !isErr || !strings.Contains(out, "no answer in time") {
		t.Fatalf("ask expired: %q", out)
	}

	// The run ends mid-wait. These leave their gates pending, so they come
	// after every flow that scans for a pending approval to decide.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if out, isErr := req(cancelled, json.RawMessage(`{"summary":"s"}`)); !isErr || !strings.Contains(out, "run ended") {
		t.Fatalf("req ctx done: %q", out)
	}
	if out, isErr := ask(cancelled, json.RawMessage(`{"question":"q","options":["A","B"]}`)); !isErr || !strings.Contains(out, "run ended") {
		t.Fatalf("ask ctx done: %q", out)
	}

	// The orchestrator refuses the gate: 6 options break the 2–5 rule server-side.
	if out, isErr := ask(ctx, json.RawMessage(`{"question":"q","options":["1","2","3","4","5","6"]}`)); !isErr || !strings.Contains(out, "could not raise the question") {
		t.Fatalf("ask raise refusal: %q", out)
	}
	// And for request_approval: a run at its deadline can't wait for a human.
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].Deadline = fx.orch.now()
	run.Deadline = fx.orch.now()
	fx.runs.mu.Unlock()
	if out, isErr := req(ctx, json.RawMessage(`{"summary":"s"}`)); !isErr || !strings.Contains(out, "could not raise the approval") {
		t.Fatalf("req raise refusal: %q", out)
	}
}

func TestServerEngine_BuildToolsBridge(t *testing.T) {
	fx := newOrchFixture(t)
	e := NewServerEngine(fx.orch, NewConnectorService(newMemConnectorStore()), nil)
	e.SetRunAPIBase("http://127.0.0.1:1/")
	if e.runAPIBase != "http://127.0.0.1:1" {
		t.Fatalf("trailing slash kept: %q", e.runAPIBase)
	}
	run := &model.Run{ID: "r", InvokerID: "u-alice"}

	// With a run token the bridged surface (and the approval tools) ride along.
	tools, _, err := e.buildTools(context.Background(), run, "tok", func(string) {})
	if err != nil {
		t.Fatalf("buildTools: %v", err)
	}
	toolByName(t, tools, "list_channels")
	toolByName(t, tools, "create_coding_task")
	toolByName(t, tools, "request_approval")
	toolByName(t, tools, "ask_user")

	// Without a token the bridge is off — those tools would only error.
	tools, _, err = e.buildTools(context.Background(), run, "", func(string) {})
	if err != nil {
		t.Fatalf("buildTools no token: %v", err)
	}
	for _, tl := range tools {
		if tl.Name == "list_channels" {
			t.Fatal("bridge tools offered without a run token")
		}
	}
}

func TestServerEngine_ConnectorToolsDanglingPicks(t *testing.T) {
	// Picks that resolve to nothing (uninstalled slug) and no other installs:
	// no connector tools at all.
	fx := newOrchFixture(t)
	e := NewServerEngine(fx.orch, NewConnectorService(newMemConnectorStore()), nil)
	tools, desc, err := e.buildTools(context.Background(), &model.Run{ID: "r", InvokerID: "u-alice", ConnectorSlugs: []string{"ghost"}}, "", func(string) {})
	if err != nil || desc != "" {
		t.Fatalf("dangling picks: %v %q", err, desc)
	}
	for _, tl := range tools {
		if strings.HasPrefix(tl.Name, "connector") || tl.Name == "use_connector" {
			t.Fatalf("connector tool offered with nothing usable: %s", tl.Name)
		}
	}
}

func TestServerEngine_UseConnectorFullDispatch(t *testing.T) {
	// The whole journey through Dispatch: model requests an ask-connector,
	// the invoker approves the card, the attached API gets called, the run
	// completes — with the wait's progress notes flowing through ReportEvents.
	oldPoll, oldNote := approvalPollInterval, approvalWaitNote
	approvalPollInterval, approvalWaitNote = 5*time.Millisecond, time.Millisecond
	defer func() { approvalPollInterval, approvalWaitNote = oldPoll, oldNote }()

	fx := newOrchFixture(t)
	var gotPath string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"todos":[]}`))
	}))
	defer api.Close()
	st := newMemConnectorStore()
	st.connectors["hub"] = &model.Connector{Slug: "hub", Title: "Hub", BaseURL: api.URL, AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"}}
	st.files["hub"] = []model.ConnectorFile{{Slug: "hub", Name: "a.yaml", Content: "x"}}
	st.installs["u-alice#hub"] = &model.ConnectorInstall{UserID: "u-alice", ConnectorSlug: "hub", Token: "t"} // ask
	run := fx.startRun(t)

	fb := &fakeBedrock{outs: []*bedrockruntime.ConverseOutput{
		bedrockToolCall("use_connector", map[string]any{"connector": "hub", "reason": "need the todo list"}),
		bedrockToolCall("connector_call", map[string]any{"connector": "hub", "path": "api/todos"}),
		bedrockText("no todos — you're free"),
	}}
	e := NewServerEngine(fx.orch, NewConnectorService(st), fb)
	approveWhenPending(t, fx, run.ID, Decision{Approve: true})
	dispatchAndWait(t, e, run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCompleted {
		t.Fatalf("state: %s (fail=%q)", got.State, got.FailReason)
	}
	if gotPath != "/api/todos" {
		t.Fatalf("post-approval call never landed: %q", gotPath)
	}
	if !strings.Contains(fx.msgs.lastPost(), "you're free") {
		t.Fatalf("final text: %q", fx.msgs.lastPost())
	}
}
