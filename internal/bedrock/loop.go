// Package bedrock runs an agent loop against AWS Bedrock's Converse API.
// It is the SERVER-SIDE twin of the desktop runner's bedrock harness
// (ex-electron src/runner/harness/bedrock.ts): same protocol — system rules +
// task prompt, tool_use round-trips until the model stops — but tools are
// injected Go closures instead of MCP proxies, so the loop itself stays pure
// and fully testable with a fake client.
package bedrock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

// Client is the one Bedrock call the loop needs — bedrockruntime.Client
// satisfies it; tests inject a fake.
type Client interface {
	Converse(ctx context.Context, params *bedrockruntime.ConverseInput, optFns ...func(*bedrockruntime.Options)) (*bedrockruntime.ConverseOutput, error)
}

// Tool is one callable the model may invoke. Schema is a JSON-Schema object
// for the input. Call returns the tool-result text and whether it represents
// an error (surfaced to the model as a failed tool result, never as a loop
// failure — models recover from tool errors; loops don't).
type Tool struct {
	Name        string
	Description string
	Schema      map[string]any
	Call        func(ctx context.Context, input json.RawMessage) (text string, isErr bool)
}

// Usage totals the loop's token spend across every Converse round-trip.
type Usage struct {
	InputTokens  int64
	OutputTokens int64
}

// Config is one loop invocation.
type Config struct {
	ModelID   string
	System    string
	Prompt    string
	MaxIters  int   // ≤0 → itersCeiling
	MaxTokens int32 // per-response cap; ≤0 → defaultMaxTokens
	Tools     []Tool
	// OnEvent observes loop progress ("text", "tool_call", "tool_result") for
	// run timelines. Optional. Must not block.
	OnEvent func(kind string, payload map[string]any)
}

const (
	// itersCeiling is the hard backstop on Converse round-trips regardless of
	// configured limits — the same guard the runner harness keeps against a
	// model that never stops calling tools.
	itersCeiling     = 32
	defaultMaxTokens = 4096
	// toolResultCap bounds one tool result so a huge API response can't blow
	// the context window in a single turn.
	toolResultCap = 24_000
)

// ErrNoProgress reports a model turn that claimed tool_use but carried no
// tool-use blocks — retrying would loop forever on the same reply.
var ErrNoProgress = errors.New("bedrock: model stopped without progress")

// Run drives the Converse loop until the model answers without requesting a
// tool, an iteration ceiling trips, or ctx dies. The final assistant text is
// returned; partial text accumulated before a ceiling trip is returned with
// the error so callers can salvage it.
func Run(ctx context.Context, client Client, cfg Config) (string, Usage, error) {
	if cfg.ModelID == "" {
		return "", Usage{}, errors.New("bedrock: model id required")
	}
	maxIters := cfg.MaxIters
	if maxIters <= 0 || maxIters > itersCeiling {
		maxIters = itersCeiling
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}

	tools := map[string]Tool{}
	var toolCfg *types.ToolConfiguration
	if len(cfg.Tools) > 0 {
		toolCfg = &types.ToolConfiguration{}
		for _, t := range cfg.Tools {
			tools[t.Name] = t
			toolCfg.Tools = append(toolCfg.Tools, &types.ToolMemberToolSpec{
				Value: types.ToolSpecification{
					Name:        aws.String(t.Name),
					Description: aws.String(t.Description),
					InputSchema: &types.ToolInputSchemaMemberJson{Value: document.NewLazyDocument(t.Schema)},
				},
			})
		}
	}

	msgs := []types.Message{{
		Role:    types.ConversationRoleUser,
		Content: []types.ContentBlock{&types.ContentBlockMemberText{Value: cfg.Prompt}},
	}}
	var usage Usage
	var lastText string

	// Prompt caching (Claude models): without checkpoints, Converse re-bills
	// the ENTIRE history as fresh input on every round-trip, so a run's input
	// spend grows quadratically with tool calls. One checkpoint after system
	// caches the fixed prefix (tool defs + rules); a per-request checkpoint on
	// the last message caches the growing history — msgs is append-only, so
	// each request's history is a strict prefix of the next and prior
	// checkpoints become cache hits.
	cache := strings.Contains(cfg.ModelID, "anthropic.claude")
	system := []types.SystemContentBlock{&types.SystemContentBlockMemberText{Value: cfg.System}}
	if cache {
		system = append(system, &types.SystemContentBlockMemberCachePoint{Value: types.CachePointBlock{Type: types.CachePointTypeDefault}})
	}

	for iter := 0; iter < maxIters; iter++ {
		out, err := client.Converse(ctx, &bedrockruntime.ConverseInput{
			ModelId:         aws.String(cfg.ModelID),
			System:          system,
			Messages:        cachedMessages(msgs, cache),
			ToolConfig:      toolCfg,
			InferenceConfig: &types.InferenceConfiguration{MaxTokens: aws.Int32(maxTokens)},
		})
		if err != nil {
			return lastText, usage, fmt.Errorf("bedrock: converse: %w", err)
		}
		var turnIn, turnOut, cacheRead, cacheWrite int64
		if out.Usage != nil {
			cacheRead, cacheWrite = int64(aws.ToInt32(out.Usage.CacheReadInputTokens)), int64(aws.ToInt32(out.Usage.CacheWriteInputTokens))
			// FRESH input is uncached input + cache writes; cache READS are
			// near-free re-reads of the shared prefix and must not count
			// against the run's token limits (mirrors the CLI harness).
			turnIn, turnOut = int64(aws.ToInt32(out.Usage.InputTokens))+cacheWrite, int64(aws.ToInt32(out.Usage.OutputTokens))
			usage.InputTokens += turnIn
			usage.OutputTokens += turnOut
		}
		// One "turn" per Converse round-trip, carrying that trip's token spend —
		// the caller's live ledger (turn/token limits) feeds on these.
		emit(cfg.OnEvent, "turn", map[string]any{"inputTokens": turnIn, "outputTokens": turnOut, "cacheRead": cacheRead, "cacheWrite": cacheWrite})

		reply, ok := out.Output.(*types.ConverseOutputMemberMessage)
		if !ok || reply == nil {
			return lastText, usage, errors.New("bedrock: response carried no message")
		}
		msgs = append(msgs, reply.Value)

		var texts []string
		var toolUses []types.ToolUseBlock
		for _, block := range reply.Value.Content {
			switch b := block.(type) {
			case *types.ContentBlockMemberText:
				texts = append(texts, b.Value)
			case *types.ContentBlockMemberToolUse:
				toolUses = append(toolUses, b.Value)
			}
		}
		if t := strings.TrimSpace(strings.Join(texts, "\n")); t != "" {
			lastText = t
			preview := t
			if len(preview) > 160 {
				preview = preview[:160]
			}
			emit(cfg.OnEvent, "text", map[string]any{"chars": len(t), "preview": preview})
		}

		if out.StopReason != types.StopReasonToolUse {
			return lastText, usage, nil
		}
		if len(toolUses) == 0 {
			return lastText, usage, ErrNoProgress
		}

		// Execute every requested tool CONCURRENTLY — the model batches
		// independent calls on purpose, so a turn's wall clock should be its
		// slowest call, not the sum (one slow upstream was costing 30s per
		// call, serially). Results still ride back as ONE user message in
		// request order, and OnEvent stays single-goroutine: calls are
		// announced before the fan-out, results reported after it.
		type outcome struct {
			text  string
			isErr bool
		}
		names := make([]string, len(toolUses))
		raws := make([]json.RawMessage, len(toolUses))
		outcomes := make([]outcome, len(toolUses))
		for i, tu := range toolUses {
			names[i] = aws.ToString(tu.Name)
			raws[i] = documentJSON(tu.Input)
			// The clipped input rides along so the run timeline can say what
			// the call actually did, not just which tool ran.
			inputPreview := string(raws[i])
			if len(inputPreview) > 240 {
				inputPreview = inputPreview[:240]
			}
			emit(cfg.OnEvent, "tool_call", map[string]any{"tool": names[i], "input": inputPreview})
		}
		var wg sync.WaitGroup
		for i := range toolUses {
			wg.Add(1)
			go func() {
				defer wg.Done()
				text, isErr := callTool(ctx, tools, names[i], raws[i])
				outcomes[i] = outcome{text: text, isErr: isErr}
			}()
		}
		wg.Wait()
		var results []types.ContentBlock
		for i, tu := range toolUses {
			text := outcomes[i].text
			if len(text) > toolResultCap {
				text = text[:toolResultCap] + "\n…[truncated]"
			}
			status := types.ToolResultStatusSuccess
			if outcomes[i].isErr {
				status = types.ToolResultStatusError
			}
			emit(cfg.OnEvent, "tool_result", map[string]any{"tool": names[i], "isError": outcomes[i].isErr})
			results = append(results, &types.ContentBlockMemberToolResult{
				Value: types.ToolResultBlock{
					ToolUseId: tu.ToolUseId,
					Status:    status,
					Content:   []types.ToolResultContentBlock{&types.ToolResultContentBlockMemberText{Value: text}},
				},
			})
		}
		msgs = append(msgs, types.Message{Role: types.ConversationRoleUser, Content: results})
	}
	return lastText, usage, fmt.Errorf("bedrock: %d tool round-trips without a final answer", maxIters)
}

// callTool dispatches one tool use, turning unknown names and panics into
// error results the model can react to.
func callTool(ctx context.Context, tools map[string]Tool, name string, input json.RawMessage) (text string, isErr bool) {
	t, ok := tools[name]
	if !ok {
		return "unknown tool: " + name, true
	}
	defer func() {
		if r := recover(); r != nil {
			text, isErr = fmt.Sprintf("tool %s panicked: %v", name, r), true
		}
	}()
	return t.Call(ctx, input)
}

// smithyDocument is the marshal surface of document.Interface — narrowed
// because the SDK interface carries an unexported marker method no external
// type can implement, and the fallback arms deserve direct tests.
type smithyDocument interface {
	MarshalSmithyDocument() ([]byte, error)
}

// documentJSON renders a Converse document as raw JSON ("{}" when absent or
// unmarshalable — tools validate their own input anyway).
func documentJSON(d smithyDocument) json.RawMessage {
	if d == nil {
		return json.RawMessage("{}")
	}
	b, err := d.MarshalSmithyDocument()
	if err != nil || len(b) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(b)
}

func emit(fn func(string, map[string]any), kind string, payload map[string]any) {
	if fn != nil {
		fn(kind, payload)
	}
}

// cachedMessages decorates the request with a prompt-cache checkpoint on the
// LAST message. The history itself is never mutated — the checkpoint is
// request-scoped, re-derived each round-trip, so checkpoints never stack up
// inside msgs as the conversation grows.
func cachedMessages(msgs []types.Message, cache bool) []types.Message {
	if !cache || len(msgs) == 0 {
		return msgs
	}
	out := append([]types.Message{}, msgs...)
	last := out[len(out)-1]
	content := append(append([]types.ContentBlock{}, last.Content...),
		&types.ContentBlockMemberCachePoint{Value: types.CachePointBlock{Type: types.CachePointTypeDefault}})
	out[len(out)-1] = types.Message{Role: last.Role, Content: content}
	return out
}
