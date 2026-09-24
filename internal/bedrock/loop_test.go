package bedrock

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

type fakeClient struct {
	outs  []*bedrockruntime.ConverseOutput
	errs  []error
	calls []*bedrockruntime.ConverseInput
}

func (f *fakeClient) Converse(_ context.Context, in *bedrockruntime.ConverseInput, _ ...func(*bedrockruntime.Options)) (*bedrockruntime.ConverseOutput, error) {
	f.calls = append(f.calls, in)
	i := len(f.calls) - 1
	if i < len(f.errs) && f.errs[i] != nil {
		return nil, f.errs[i]
	}
	if i >= len(f.outs) {
		return nil, errors.New("fake: no more scripted responses")
	}
	return f.outs[i], nil
}

func textOut(stop types.StopReason, text string, in, out int32) *bedrockruntime.ConverseOutput {
	return &bedrockruntime.ConverseOutput{
		StopReason: stop,
		Usage:      &types.TokenUsage{InputTokens: aws.Int32(in), OutputTokens: aws.Int32(out)},
		Output: &types.ConverseOutputMemberMessage{Value: types.Message{
			Role:    types.ConversationRoleAssistant,
			Content: []types.ContentBlock{&types.ContentBlockMemberText{Value: text}},
		}},
	}
}

func toolOut(name string, input map[string]any) *bedrockruntime.ConverseOutput {
	return &bedrockruntime.ConverseOutput{
		StopReason: types.StopReasonToolUse,
		Usage:      &types.TokenUsage{InputTokens: aws.Int32(7), OutputTokens: aws.Int32(3)},
		Output: &types.ConverseOutputMemberMessage{Value: types.Message{
			Role: types.ConversationRoleAssistant,
			Content: []types.ContentBlock{
				&types.ContentBlockMemberText{Value: "let me check"},
				&types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{
					ToolUseId: aws.String("tu-1"),
					Name:      aws.String(name),
					Input:     document.NewLazyDocument(input),
				}},
			},
		}},
	}
}

func TestRun_PlainAnswer(t *testing.T) {
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{textOut(types.StopReasonEndTurn, "the answer", 11, 4)}}
	text, usage, err := Run(context.Background(), c, Config{ModelID: "m", System: "sys", Prompt: "q"})
	if err != nil || text != "the answer" {
		t.Fatalf("got %q err=%v", text, err)
	}
	if usage.InputTokens != 11 || usage.OutputTokens != 4 {
		t.Fatalf("usage: %+v", usage)
	}
	if len(c.calls) != 1 || aws.ToString(c.calls[0].ModelId) != "m" {
		t.Fatalf("calls: %d", len(c.calls))
	}
}

func TestRun_ToolRoundTrip(t *testing.T) {
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{
		toolOut("echo", map[string]any{"msg": "hi"}),
		textOut(types.StopReasonEndTurn, "done: hi", 5, 2),
	}}
	var gotInput string
	var events []string
	text, usage, err := Run(context.Background(), c, Config{
		ModelID: "m", System: "s", Prompt: "p",
		Tools: []Tool{{
			Name: "echo", Description: "echoes", Schema: map[string]any{"type": "object"},
			Call: func(_ context.Context, in json.RawMessage) (string, bool) {
				var v struct{ Msg string }
				_ = json.Unmarshal(in, &v)
				gotInput = v.Msg
				return "echo says " + v.Msg, false
			},
		}},
		OnEvent: func(kind string, _ map[string]any) { events = append(events, kind) },
	})
	if err != nil || text != "done: hi" {
		t.Fatalf("got %q err=%v", text, err)
	}
	if gotInput != "hi" {
		t.Fatalf("tool input: %q", gotInput)
	}
	if usage.InputTokens != 12 || usage.OutputTokens != 5 {
		t.Fatalf("usage summed wrong: %+v", usage)
	}
	// Second call must carry the tool result back as a user message.
	last := c.calls[1].Messages[len(c.calls[1].Messages)-1]
	if last.Role != types.ConversationRoleUser {
		t.Fatalf("tool result role: %v", last.Role)
	}
	tr, ok := last.Content[0].(*types.ContentBlockMemberToolResult)
	if !ok || aws.ToString(tr.Value.ToolUseId) != "tu-1" {
		t.Fatalf("tool result block: %#v", last.Content[0])
	}
	joined := strings.Join(events, ",")
	for _, want := range []string{"tool_call", "tool_result", "text"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("events missing %s: %s", want, joined)
		}
	}
}

func TestRun_UnknownToolAndPanicBecomeErrorResults(t *testing.T) {
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{
		toolOut("nope", map[string]any{}),
		toolOut("boom", map[string]any{}),
		textOut(types.StopReasonEndTurn, "recovered", 1, 1),
	}}
	text, _, err := Run(context.Background(), c, Config{
		ModelID: "m", Prompt: "p",
		Tools: []Tool{{
			Name: "boom", Description: "panics", Schema: map[string]any{"type": "object"},
			Call: func(_ context.Context, _ json.RawMessage) (string, bool) { panic("kaboom") },
		}},
	})
	if err != nil || text != "recovered" {
		t.Fatalf("got %q err=%v", text, err)
	}
	for i, wantFrag := range map[int]string{1: "unknown tool", 2: "panicked"} {
		last := c.calls[i].Messages[len(c.calls[i].Messages)-1]
		tr := last.Content[0].(*types.ContentBlockMemberToolResult)
		if tr.Value.Status != types.ToolResultStatusError {
			t.Fatalf("call %d: expected error status", i)
		}
		txt := tr.Value.Content[0].(*types.ToolResultContentBlockMemberText).Value
		if !strings.Contains(txt, wantFrag) {
			t.Fatalf("call %d: %q missing %q", i, txt, wantFrag)
		}
	}
}

func TestRun_CeilingAndNoProgress(t *testing.T) {
	// Model asks for tools forever → iteration cap trips, partial text kept.
	loops := make([]*bedrockruntime.ConverseOutput, 0, 3)
	for range 3 {
		loops = append(loops, toolOut("echo", map[string]any{}))
	}
	c := &fakeClient{outs: loops}
	text, _, err := Run(context.Background(), c, Config{
		ModelID: "m", Prompt: "p", MaxIters: 3,
		Tools: []Tool{{Name: "echo", Description: "d", Schema: map[string]any{"type": "object"},
			Call: func(_ context.Context, _ json.RawMessage) (string, bool) { return "ok", false }}},
	})
	if err == nil || !strings.Contains(err.Error(), "without a final answer") {
		t.Fatalf("expected ceiling error, got %v", err)
	}
	if text != "let me check" {
		t.Fatalf("partial text lost: %q", text)
	}

	// stopReason tool_use with no tool blocks → ErrNoProgress.
	c2 := &fakeClient{outs: []*bedrockruntime.ConverseOutput{{
		StopReason: types.StopReasonToolUse,
		Output: &types.ConverseOutputMemberMessage{Value: types.Message{
			Role:    types.ConversationRoleAssistant,
			Content: []types.ContentBlock{&types.ContentBlockMemberText{Value: "stuck"}},
		}},
	}}}
	if _, _, err := Run(context.Background(), c2, Config{ModelID: "m", Prompt: "p"}); !errors.Is(err, ErrNoProgress) {
		t.Fatalf("expected ErrNoProgress, got %v", err)
	}
}

func TestRun_ErrorsAndValidation(t *testing.T) {
	if _, _, err := Run(context.Background(), &fakeClient{}, Config{Prompt: "p"}); err == nil {
		t.Fatal("missing model id must fail")
	}
	c := &fakeClient{errs: []error{errors.New("throttled")}}
	if _, _, err := Run(context.Background(), c, Config{ModelID: "m", Prompt: "p"}); err == nil || !strings.Contains(err.Error(), "throttled") {
		t.Fatalf("converse error not surfaced: %v", err)
	}
	// Truncation of oversized tool results.
	big := strings.Repeat("x", toolResultCap+50)
	c3 := &fakeClient{outs: []*bedrockruntime.ConverseOutput{
		toolOut("big", map[string]any{}),
		textOut(types.StopReasonEndTurn, "ok", 1, 1),
	}}
	_, _, err := Run(context.Background(), c3, Config{
		ModelID: "m", Prompt: "p",
		Tools: []Tool{{Name: "big", Description: "d", Schema: map[string]any{"type": "object"},
			Call: func(_ context.Context, _ json.RawMessage) (string, bool) { return big, false }}},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	tr := c3.calls[1].Messages[len(c3.calls[1].Messages)-1].Content[0].(*types.ContentBlockMemberToolResult)
	txt := tr.Value.Content[0].(*types.ToolResultContentBlockMemberText).Value
	if len(txt) > toolResultCap+30 || !strings.Contains(txt, "[truncated]") {
		t.Fatalf("tool result not truncated: %d chars", len(txt))
	}
}

func TestRun_ResponseWithoutMessage(t *testing.T) {
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{{StopReason: types.StopReasonEndTurn, Output: nil}}}
	if _, _, err := Run(context.Background(), c, Config{ModelID: "m", Prompt: "p"}); err == nil || !strings.Contains(err.Error(), "no message") {
		t.Fatalf("message-less response: %v", err)
	}
}

func TestRun_LongTextPreviewClipped(t *testing.T) {
	long := strings.Repeat("a", 400)
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{textOut(types.StopReasonEndTurn, long, 1, 1)}}
	var preview string
	text, _, err := Run(context.Background(), c, Config{ModelID: "m", Prompt: "p", OnEvent: func(kind string, p map[string]any) {
		if kind == "text" {
			preview, _ = p["preview"].(string)
		}
	}})
	if err != nil || text != long {
		t.Fatalf("long text: err=%v len=%d", err, len(text))
	}
	if len(preview) != 160 {
		t.Fatalf("preview must clip to 160, got %d", len(preview))
	}
}

// badDoc drives documentJSON's error and empty arms.
type badDoc struct {
	b   []byte
	err error
}

func (d badDoc) MarshalSmithyDocument() ([]byte, error) { return d.b, d.err }

func TestDocumentJSON(t *testing.T) {
	if got := string(documentJSON(nil)); got != "{}" {
		t.Fatalf("nil doc: %q", got)
	}
	if got := string(documentJSON(badDoc{err: errors.New("boom")})); got != "{}" {
		t.Fatalf("marshal error: %q", got)
	}
	if got := string(documentJSON(badDoc{b: nil})); got != "{}" {
		t.Fatalf("empty doc: %q", got)
	}
	if got := string(documentJSON(document.NewLazyDocument(map[string]any{"a": 1}))); got == "{}" {
		t.Fatalf("real doc must serialize, got %q", got)
	}
}

func TestRun_ToolCallInputPreviewClipped(t *testing.T) {
	big := strings.Repeat("y", 300)
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{
		toolOut("echo", map[string]any{"blob": big}),
		textOut(types.StopReasonEndTurn, "ok", 1, 1),
	}}
	var preview string
	_, _, err := Run(context.Background(), c, Config{
		ModelID: "m", Prompt: "p",
		Tools: []Tool{{Name: "echo", Description: "d", Schema: map[string]any{"type": "object"},
			Call: func(_ context.Context, _ json.RawMessage) (string, bool) { return "ok", false }}},
		OnEvent: func(kind string, p map[string]any) {
			if kind == "tool_call" {
				preview, _ = p["input"].(string)
			}
		},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(preview) != 240 || !strings.Contains(preview, "blob") {
		t.Fatalf("input preview must clip to 240, got %d", len(preview))
	}
}

// Claude models get prompt-cache checkpoints: one fixed after system, one
// request-scoped on the last message — and cache reads never count as fresh
// input, while cache writes do.
func TestRun_PromptCacheCheckpoints(t *testing.T) {
	tool := toolOut("lookup", map[string]any{"q": "x"})
	tool.Usage = &types.TokenUsage{
		InputTokens:           aws.Int32(7),
		OutputTokens:          aws.Int32(3),
		CacheWriteInputTokens: aws.Int32(900),
	}
	done := textOut(types.StopReasonEndTurn, "done", 5, 2)
	done.Usage.CacheReadInputTokens = aws.Int32(900)
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{tool, done}}

	_, usage, err := Run(context.Background(), c, Config{
		ModelID: "eu.anthropic.claude-opus-5-v1", System: "s", Prompt: "p",
		Tools: []Tool{{Name: "lookup", Schema: map[string]any{}, Call: func(context.Context, json.RawMessage) (string, bool) { return "hit", false }}},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	// Fresh input = uncached + cache writes; the 900 cached read on trip 2 is free.
	if usage.InputTokens != 7+900+5 || usage.OutputTokens != 5 {
		t.Fatalf("usage: %+v", usage)
	}
	for i, call := range c.calls {
		if n := len(call.System); n != 2 {
			t.Fatalf("call %d: system blocks = %d, want text + cachePoint", i, n)
		}
		if _, ok := call.System[1].(*types.SystemContentBlockMemberCachePoint); !ok {
			t.Fatalf("call %d: system[1] is %T, want cachePoint", i, call.System[1])
		}
		last := call.Messages[len(call.Messages)-1].Content
		if _, ok := last[len(last)-1].(*types.ContentBlockMemberCachePoint); !ok {
			t.Fatalf("call %d: last block is %T, want cachePoint", i, last[len(last)-1])
		}
		// Request-scoped decoration only: HISTORY messages carry no checkpoints.
		for m, msg := range call.Messages[:len(call.Messages)-1] {
			for _, b := range msg.Content {
				if _, ok := b.(*types.ContentBlockMemberCachePoint); ok {
					t.Fatalf("call %d: stacked cachePoint in history message %d", i, m)
				}
			}
		}
	}
}

// Non-Claude models get no checkpoints (Converse rejects them), and the empty
// guard leaves an empty history alone.
func TestCachedMessages_Gating(t *testing.T) {
	msgs := []types.Message{{Role: types.ConversationRoleUser, Content: []types.ContentBlock{&types.ContentBlockMemberText{Value: "p"}}}}
	if got := cachedMessages(msgs, false); len(got[0].Content) != 1 {
		t.Fatalf("cache=false must pass messages through, got %d blocks", len(got[0].Content))
	}
	if got := cachedMessages(nil, true); got != nil {
		t.Fatalf("empty history must stay empty, got %v", got)
	}
	if got := cachedMessages(msgs, true); len(msgs[0].Content) != 1 || len(got[0].Content) != 2 {
		t.Fatal("cache=true must decorate a copy, never the history itself")
	}
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{textOut(types.StopReasonEndTurn, "ok", 1, 1)}}
	if _, _, err := Run(context.Background(), c, Config{ModelID: "m", System: "s", Prompt: "p"}); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(c.calls[0].System) != 1 {
		t.Fatalf("non-claude model must not get a system cachePoint")
	}
}

// A turn's tool calls run CONCURRENTLY (wall clock = slowest call, not the
// sum) while results still return in request order. The two tools rendezvous:
// each returns "ok" only if the other has already started — serial execution
// would leave the first stuck until its 2s bailout.
func TestRun_ParallelToolExecution(t *testing.T) {
	multi := &bedrockruntime.ConverseOutput{
		StopReason: types.StopReasonToolUse,
		Usage:      &types.TokenUsage{InputTokens: aws.Int32(5), OutputTokens: aws.Int32(2)},
		Output: &types.ConverseOutputMemberMessage{Value: types.Message{
			Role: types.ConversationRoleAssistant,
			Content: []types.ContentBlock{
				&types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{ToolUseId: aws.String("tu-a"), Name: aws.String("a"), Input: document.NewLazyDocument(map[string]any{})}},
				&types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{ToolUseId: aws.String("tu-b"), Name: aws.String("b"), Input: document.NewLazyDocument(map[string]any{})}},
			},
		}},
	}
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{multi, textOut(types.StopReasonEndTurn, "done", 1, 1)}}
	aStarted, bStarted := make(chan struct{}), make(chan struct{})
	rendezvous := func(mine, other chan struct{}) func(context.Context, json.RawMessage) (string, bool) {
		return func(context.Context, json.RawMessage) (string, bool) {
			close(mine)
			select {
			case <-other:
				return "ok", false
			case <-time.After(2 * time.Second):
				return "still serial", true
			}
		}
	}
	var kinds []string
	_, _, err := Run(context.Background(), c, Config{
		ModelID: "m", System: "s", Prompt: "p",
		Tools: []Tool{
			{Name: "a", Schema: map[string]any{}, Call: rendezvous(aStarted, bStarted)},
			{Name: "b", Schema: map[string]any{}, Call: rendezvous(bStarted, aStarted)},
		},
		OnEvent: func(kind string, _ map[string]any) { kinds = append(kinds, kind) },
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	last := c.calls[1].Messages[len(c.calls[1].Messages)-1]
	tr0 := last.Content[0].(*types.ContentBlockMemberToolResult).Value
	tr1 := last.Content[1].(*types.ContentBlockMemberToolResult).Value
	if aws.ToString(tr0.ToolUseId) != "tu-a" || aws.ToString(tr1.ToolUseId) != "tu-b" {
		t.Fatalf("results out of request order: %v %v", tr0.ToolUseId, tr1.ToolUseId)
	}
	for i, tr := range []types.ToolResultBlock{tr0, tr1} {
		if got := tr.Content[0].(*types.ToolResultContentBlockMemberText).Value; got != "ok" {
			t.Fatalf("tool %d did not run concurrently: %q", i, got)
		}
	}
	// Every call is announced before any result lands (OnEvent stays ordered).
	if !strings.Contains(strings.Join(kinds, ","), "tool_call,tool_call,tool_result,tool_result") {
		t.Fatalf("event order: %v", kinds)
	}
}
