package model

import (
	"fmt"
	"strings"
	"testing"
)

func TestDefaultAgentModelsAreAValidList(t *testing.T) {
	got, err := NormalizeAgentModels(DefaultAgentModels)
	if err != nil {
		t.Fatalf("the built-in list must pass its own rules: %v", err)
	}
	if len(got) != len(DefaultAgentModels) {
		t.Fatalf("normalized %d models, want %d", len(got), len(DefaultAgentModels))
	}
	// Bedrock runs stay in the EU.
	for _, m := range DefaultAgentModels {
		if m.Harness == HarnessBedrock && !strings.HasPrefix(m.ID, "eu.anthropic.claude-") {
			t.Errorf("default Bedrock model %q is not an EU Claude profile", m.ID)
		}
	}
}

func TestNormalizeAgentModelsTrims(t *testing.T) {
	got, err := NormalizeAgentModels([]AgentModelOption{
		{Harness: " claude ", ID: " claude-opus-5-5 ", Label: "  Opus  "},
		{Harness: "bedrock", ID: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"},
	})
	if err != nil {
		t.Fatalf("NormalizeAgentModels: %v", err)
	}
	want := []AgentModelOption{
		{Harness: "claude", ID: "claude-opus-5-5", Label: "Opus"},
		{Harness: "bedrock", ID: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestNormalizeAgentModelsRefuses(t *testing.T) {
	ok := []AgentModelOption{{Harness: "claude", ID: "claude-opus-5"}, {Harness: "bedrock", ID: "eu.anthropic.claude-opus-5"}}
	many := append([]AgentModelOption{}, ok...)
	for i := 0; i < MaxAgentModelsPerHarness; i++ {
		many = append(many, AgentModelOption{Harness: "claude", ID: fmt.Sprintf("claude-x-%d", i)})
	}
	for _, tc := range []struct {
		name string
		list []AgentModelOption
		want string
	}{
		{"a model that is not Claude, for Claude Code", append(ok, AgentModelOption{Harness: "claude", ID: "gpt-5"}), "not a Claude model id"},
		{"a Bedrock profile outside the EU", append(ok, AgentModelOption{Harness: "bedrock", ID: "us.anthropic.claude-opus-5"}), "not an EU Claude inference profile"},
		{"a non-Claude Bedrock model", append(ok, AgentModelOption{Harness: "bedrock", ID: "eu.meta.llama-4"}), "not an EU Claude inference profile"},
		{"an engine without a list", append(ok, AgentModelOption{Harness: "codex", ID: "gpt-5"}), "claude and bedrock only"},
		{"a long id", append(ok, AgentModelOption{Harness: "claude", ID: "claude-" + strings.Repeat("a", 100)}), "limited to 100"},
		{"a long label", append(ok, AgentModelOption{Harness: "claude", ID: "claude-x", Label: strings.Repeat("a", 61)}), "limited to 100"},
		{"a repeat", append(ok, AgentModelOption{Harness: "claude", ID: "claude-opus-5"}), "listed twice"},
		{"no Claude Code model", ok[1:], "at least one model for claude"},
		{"no Bedrock model", ok[:1], "at least one model for bedrock"},
		{"too many", many, "at most 25"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NormalizeAgentModels(tc.list)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

func TestOffersAgentModel(t *testing.T) {
	list := DefaultAgentModels
	for _, tc := range []struct {
		harness, id string
		want        bool
	}{
		{HarnessClaude, "claude-opus-5-5", true},
		{HarnessClaude, "claude-made-up", false},
		// The same id under the other engine is a different thing.
		{HarnessBedrock, "claude-opus-5-5", false},
		{HarnessBedrock, "eu.anthropic.claude-opus-5", true},
		// Codex has no list: anything goes.
		{HarnessCodex, "gpt-anything", true},
	} {
		if got := OffersAgentModel(list, tc.harness, tc.id); got != tc.want {
			t.Errorf("OffersAgentModel(%s, %s) = %v, want %v", tc.harness, tc.id, got, tc.want)
		}
	}
	if !HarnessHasModelList(HarnessBedrock) || HarnessHasModelList(HarnessCodex) {
		t.Fatal("Claude Code and Bedrock pick from a list; Codex does not")
	}
}
