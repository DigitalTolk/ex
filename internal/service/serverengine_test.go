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
		return e.connectorCall(context.Background(), bySlug, json.RawMessage(input))
	}
	if out, isErr := call(`{"connector":"nope","path":"x"}`); !isErr || !strings.Contains(out, "unknown connector") {
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
	if out, isErr := e.connectorCall(context.Background(), broken, json.RawMessage(`{"connector":"hub","path":"x"}`)); !isErr || !strings.Contains(out, "request build failed") {
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
	e := &ServerEngine{connectors: NewConnectorService(st), http: &http.Client{}}
	tools, desc, err := e.buildTools(context.Background(), &model.Run{InvokerID: "u1", ConnectorSlugs: []string{"hub"}})
	if err != nil || len(tools) != 2 || !strings.Contains(desc, "/hub") {
		t.Fatalf("buildTools: %v %d", err, len(tools))
	}
	doc := tools[0].Call
	if out, isErr := doc(context.Background(), json.RawMessage(`not json`)); !isErr || !strings.Contains(out, "bad input") {
		t.Fatalf("bad input: %q", out)
	}
	if out, isErr := doc(context.Background(), json.RawMessage(`{"connector":"ghost","file":"x"}`)); !isErr || !strings.Contains(out, "unknown connector") {
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
	out, isErr := e.connectorCall(context.Background(), bySlug, json.RawMessage(`{"connector":"hub","method":"POST","path":"x","body":{"a":1}}`))
	if isErr || !strings.Contains(out, "HTTP 200") || !strings.Contains(out, "[response truncated]") {
		t.Fatalf("post+truncate: err=%v %q", isErr, out[:80])
	}
	if gotBody != `{"a":1}` {
		t.Fatalf("body sent: %q", gotBody)
	}

	// Seam: body marshal failure.
	old := marshalJSON
	marshalJSON = func(any) ([]byte, error) { return nil, errors.New("marshal boom") }
	out, isErr = e.connectorCall(context.Background(), bySlug, json.RawMessage(`{"connector":"hub","path":"x","body":{}}`))
	marshalJSON = old
	if !isErr || !strings.Contains(out, "bad body") {
		t.Fatalf("marshal seam: %q", out)
	}

	// Seam: request construction failure.
	oldReq := newRequest
	newRequest = func(context.Context, string, string, io.Reader) (*http.Request, error) {
		return nil, errors.New("request boom")
	}
	out, isErr = e.connectorCall(context.Background(), bySlug, json.RawMessage(`{"connector":"hub","path":"x"}`))
	newRequest = oldReq
	if !isErr || !strings.Contains(out, "request build failed") {
		t.Fatalf("request seam: %q", out)
	}

	// Transport failure: server gone.
	api.Close()
	out, isErr = e.connectorCall(context.Background(), bySlug, json.RawMessage(`{"connector":"hub","path":"x"}`))
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
