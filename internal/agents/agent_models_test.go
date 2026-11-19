package agents

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// fakeModelCatalog offers the built-in list, and records what was asked.
type fakeModelCatalog struct{ asked []string }

func (c *fakeModelCatalog) OffersAgentModel(_ context.Context, harness, id string) bool {
	c.asked = append(c.asked, harness+"|"+id)
	return model.OffersAgentModel(model.DefaultAgentModels, harness, id)
}

func notOffered(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, service.ErrValidation) || !strings.Contains(err.Error(), "is not one of the models offered") {
		t.Fatalf("err = %v, want the model refused", err)
	}
}

func TestCreateAgentTakesOnlyOfferedModels(t *testing.T) {
	ctx := context.Background()
	svc, _, _ := agentCovNewSvc()
	catalog := &fakeModelCatalog{}
	svc.SetModelCatalog(catalog)

	_, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "aa", Persona: "p", Model: "claude-made-up"})
	notOffered(t, err)
	_, err = svc.CreateAgent(ctx, CreateAgentInput{Slug: "bb", Persona: "p", Harness: model.HarnessBedrock, Model: "us.anthropic.claude-opus-5"})
	notOffered(t, err)

	tpl, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "cc", Persona: "p", Model: " claude-sonnet-5-5 "})
	if err != nil || tpl.Model != "claude-sonnet-5-5" {
		t.Fatalf("an offered model: %+v, %v", tpl, err)
	}
	// No model: the engine's default, and nothing to check.
	asked := len(catalog.asked)
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "dd", Persona: "p"}); err != nil {
		t.Fatalf("no model: %v", err)
	}
	if len(catalog.asked) != asked {
		t.Fatalf("a blank model was checked: %v", catalog.asked[asked:])
	}
	// Codex has no list.
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "ee", Persona: "p", Harness: model.HarnessCodex, Model: "gpt-anything"}); err != nil {
		t.Fatalf("codex: %v", err)
	}
}

func TestSetAgentEngineTakesOnlyOfferedModels(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	svc.SetModelCatalog(&fakeModelCatalog{})
	agentCovSeedAgent(t, dir, users, "gg")

	_, err := svc.SetAgentEngine(ctx, "gg", model.HarnessClaude, "claude-made-up", "")
	notOffered(t, err)
	// An id offered for the OTHER engine is still refused.
	_, err = svc.SetAgentEngine(ctx, "gg", model.HarnessBedrock, "claude-opus-5-5", model.ExecutionServer)
	notOffered(t, err)

	tpl, err := svc.SetAgentEngine(ctx, "gg", model.HarnessBedrock, "eu.anthropic.claude-opus-5", model.ExecutionServer)
	if err != nil || tpl.Model != "eu.anthropic.claude-opus-5" || tpl.Harness != model.HarnessBedrock {
		t.Fatalf("an offered model: %+v, %v", tpl, err)
	}
}

func TestUpdatePrefsTakesOnlyOfferedModels(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	svc.SetModelCatalog(&fakeModelCatalog{})
	agentCovSeedAgent(t, dir, users, "gg")
	str := func(s string) *string { return &s }

	// The agent's own engine (Claude Code) when the person has not picked one.
	_, err := svc.UpdatePrefs(ctx, "u-1", "gg", AgentPrefsPatch{Model: str("claude-made-up")})
	notOffered(t, err)
	prefs, err := svc.UpdatePrefs(ctx, "u-1", "gg", AgentPrefsPatch{Model: str(" claude-haiku-5-5 ")})
	if err != nil || prefs.Model != "claude-haiku-5-5" {
		t.Fatalf("an offered model: %+v, %v", prefs, err)
	}
	// Their own engine when they have one: Bedrock's list.
	_, err = svc.UpdatePrefs(ctx, "u-1", "gg", AgentPrefsPatch{Harness: str(model.HarnessBedrock), Model: str("claude-haiku-5-5")})
	notOffered(t, err)
	prefs, err = svc.UpdatePrefs(ctx, "u-1", "gg", AgentPrefsPatch{Harness: str(model.HarnessBedrock), Model: str("eu.anthropic.claude-opus-5")})
	if err != nil || prefs.Model != "eu.anthropic.claude-opus-5" {
		t.Fatalf("an offered Bedrock model: %+v, %v", prefs, err)
	}
	// Back to the default: nothing to check.
	if _, err := svc.UpdatePrefs(ctx, "u-1", "gg", AgentPrefsPatch{Model: str("")}); err != nil {
		t.Fatalf("clearing the model: %v", err)
	}
	// An agent nobody made is still refused first.
	if _, err := svc.UpdatePrefs(ctx, "u-1", "nobody", AgentPrefsPatch{Model: str("claude-haiku-5-5")}); err == nil {
		t.Fatal("want an unknown agent refused")
	}
}

// Without a catalog (tests, builds without settings) any model goes.
func TestModelCheckWithoutCatalog(t *testing.T) {
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")
	if _, err := svc.SetAgentEngine(context.Background(), "gg", model.HarnessClaude, "claude-anything", ""); err != nil {
		t.Fatalf("no catalog: %v", err)
	}
}
