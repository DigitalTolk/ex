package model

import (
	"fmt"
	"regexp"
	"strings"
)

// AgentModelOption is one model an admin offers for an engine: the agents
// page and the admin panel pick an agent's model from these instead of a free
// text field. Only the engines with a fixed set of models have a list:
// Claude Code (Claude models) and AWS Bedrock (Claude in the EU); Codex keeps
// its free text.
type AgentModelOption struct {
	Harness string `json:"harness" dynamodbav:"harness"`
	ID      string `json:"id" dynamodbav:"id"`
	// Label is what the dropdown shows; the id when blank.
	Label string `json:"label,omitempty" dynamodbav:"label,omitempty"`
}

// DefaultAgentModels is the list a workspace offers until an admin edits it.
// Claude Code takes Claude model ids. Bedrock takes the EU cross-region
// inference profiles ("eu." + the Bedrock model id), so a run stays inside
// the EU whichever EU region serves it.
var DefaultAgentModels = []AgentModelOption{
	// Claude Code: the current models first, then the previous ones still
	// served. (Mythos is left out: it is for verified organizations only.)
	{Harness: HarnessClaude, ID: "claude-opus-5-5", Label: "Claude Opus 5.5"},
	{Harness: HarnessClaude, ID: "claude-sonnet-5-5", Label: "Claude Sonnet 5.5"},
	{Harness: HarnessClaude, ID: "claude-haiku-5-5", Label: "Claude Haiku 5.5"},
	{Harness: HarnessClaude, ID: "claude-fable-5-2", Label: "Claude Fable 5.2"},
	{Harness: HarnessClaude, ID: "claude-opus-5", Label: "Claude Opus 5"},
	{Harness: HarnessClaude, ID: "claude-sonnet-5", Label: "Claude Sonnet 5"},
	{Harness: HarnessClaude, ID: "claude-fable-5-1", Label: "Claude Fable 5.1"},
	{Harness: HarnessClaude, ID: "claude-fable-5", Label: "Claude Fable 5"},
	{Harness: HarnessClaude, ID: "claude-opus-4-8", Label: "Claude Opus 4.8"},
	{Harness: HarnessClaude, ID: "claude-opus-4-7", Label: "Claude Opus 4.7"},
	{Harness: HarnessClaude, ID: "claude-opus-4-6", Label: "Claude Opus 4.6"},
	{Harness: HarnessClaude, ID: "claude-sonnet-4-6", Label: "Claude Sonnet 4.6"},
	{Harness: HarnessClaude, ID: "claude-haiku-4-5", Label: "Claude Haiku 4.5"},
	{Harness: HarnessBedrock, ID: "eu.anthropic.claude-opus-5", Label: "Claude Opus 5 (EU)"},
}

// MaxAgentModelsPerHarness caps each engine's list: it is a dropdown.
const MaxAgentModelsPerHarness = 25

// HarnessHasModelList reports whether an engine picks its model from the
// admin's list.
func HarnessHasModelList(harness string) bool {
	return harness == HarnessClaude || harness == HarnessBedrock
}

var (
	claudeModelID  = regexp.MustCompile(`^claude-[a-z0-9][a-z0-9.-]*$`)
	bedrockModelID = regexp.MustCompile(`^eu\.anthropic\.claude-[a-z0-9][a-z0-9.:-]*$`)
)

// NormalizeAgentModels trims and checks an admin's list: a known engine, an id
// in that engine's form (a Claude model id; for Bedrock an EU Claude inference
// profile), no repeats, and every listed engine keeping between one and
// MaxAgentModelsPerHarness models. Both engines must be listed: a dropdown
// with nothing in it leaves no way to pick a model.
func NormalizeAgentModels(in []AgentModelOption) ([]AgentModelOption, error) {
	out := make([]AgentModelOption, 0, len(in))
	seen := map[string]bool{}
	count := map[string]int{}
	for _, o := range in {
		o.Harness = strings.TrimSpace(o.Harness)
		o.ID = strings.TrimSpace(o.ID)
		o.Label = strings.TrimSpace(o.Label)
		switch o.Harness {
		case HarnessClaude:
			if !claudeModelID.MatchString(o.ID) {
				return nil, fmt.Errorf("%q is not a Claude model id (claude-…)", o.ID)
			}
		case HarnessBedrock:
			if !bedrockModelID.MatchString(o.ID) {
				return nil, fmt.Errorf("%q is not an EU Claude inference profile (eu.anthropic.claude-…)", o.ID)
			}
		default:
			return nil, fmt.Errorf("models can be listed for claude and bedrock only, not %q", o.Harness)
		}
		if len(o.ID) > 100 || len(o.Label) > 60 {
			return nil, fmt.Errorf("%q: the id is limited to 100 characters and the label to 60", o.ID)
		}
		key := o.Harness + "|" + o.ID
		if seen[key] {
			return nil, fmt.Errorf("%q is listed twice for %s", o.ID, o.Harness)
		}
		seen[key] = true
		count[o.Harness]++
		out = append(out, o)
	}
	for _, h := range []string{HarnessClaude, HarnessBedrock} {
		switch {
		case count[h] == 0:
			return nil, fmt.Errorf("list at least one model for %s", h)
		case count[h] > MaxAgentModelsPerHarness:
			return nil, fmt.Errorf("list at most %d models for %s", MaxAgentModelsPerHarness, h)
		}
	}
	return out, nil
}

// OffersAgentModel reports whether the list offers id for harness. An engine
// without a list offers anything.
func OffersAgentModel(list []AgentModelOption, harness, id string) bool {
	if !HarnessHasModelList(harness) {
		return true
	}
	for _, o := range list {
		if o.Harness == harness && o.ID == id {
			return true
		}
	}
	return false
}
