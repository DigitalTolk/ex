package service

// Coverage tests for internal/service/agent.go. Everything here is prefixed
// agentCov / TestAgentCov to stay clear of parallel work in this package.
// agentCovDir wraps the package's in-memory fakeAgentDir (orchestrator_test.go)
// with per-method error injection so every store-error arm is reachable.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// errAgentCov is the injected store failure for error-arm tests.
var errAgentCov = errors.New("agentCov: boom")

// agentCovDir embeds the shared in-memory fake and fails any method named in
// errs with the mapped error instead of delegating.
type agentCovDir struct {
	*fakeAgentDir
	errs map[string]error
}

func agentCovNewDir() *agentCovDir {
	return &agentCovDir{fakeAgentDir: newFakeAgentDir(), errs: map[string]error{}}
}

func (d *agentCovDir) CreateTemplateIfAbsent(ctx context.Context, tpl *model.AgentTemplate) error {
	if err := d.errs["CreateTemplateIfAbsent"]; err != nil {
		return err
	}
	return d.fakeAgentDir.CreateTemplateIfAbsent(ctx, tpl)
}

func (d *agentCovDir) CreateAgentUser(ctx context.Context, user *model.User) error {
	if err := d.errs["CreateAgentUser"]; err != nil {
		return err
	}
	return d.fakeAgentDir.CreateAgentUser(ctx, user)
}

func (d *agentCovDir) PutTemplate(ctx context.Context, tpl *model.AgentTemplate) error {
	if err := d.errs["PutTemplate"]; err != nil {
		return err
	}
	return d.fakeAgentDir.PutTemplate(ctx, tpl)
}

func (d *agentCovDir) GetTemplate(ctx context.Context, slug string) (*model.AgentTemplate, error) {
	if err := d.errs["GetTemplate"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.GetTemplate(ctx, slug)
}

func (d *agentCovDir) ListTemplates(ctx context.Context) ([]*model.AgentTemplate, error) {
	if err := d.errs["ListTemplates"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.ListTemplates(ctx)
}

func (d *agentCovDir) GetAgentPrefs(ctx context.Context, userID, slug string) (*model.UserAgentPrefs, error) {
	if err := d.errs["GetAgentPrefs"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.GetAgentPrefs(ctx, userID, slug)
}

func (d *agentCovDir) PutAgentPrefs(ctx context.Context, prefs *model.UserAgentPrefs) error {
	if err := d.errs["PutAgentPrefs"]; err != nil {
		return err
	}
	return d.fakeAgentDir.PutAgentPrefs(ctx, prefs)
}

func (d *agentCovDir) PutSkill(ctx context.Context, sk *model.Skill) error {
	if err := d.errs["PutSkill"]; err != nil {
		return err
	}
	return d.fakeAgentDir.PutSkill(ctx, sk)
}

func (d *agentCovDir) GetAgentMemory(ctx context.Context, invokerID, agentID string) (*model.AgentMemory, error) {
	if err := d.errs["GetAgentMemory"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.GetAgentMemory(ctx, invokerID, agentID)
}

func (d *agentCovDir) PutAgentSubscription(ctx context.Context, sub *model.AgentSubscription) error {
	if err := d.errs["PutAgentSubscription"]; err != nil {
		return err
	}
	return d.fakeAgentDir.PutAgentSubscription(ctx, sub)
}

func (d *agentCovDir) ListSubscriptionsByParent(ctx context.Context, parentID string) ([]*model.AgentSubscription, error) {
	if err := d.errs["ListSubscriptionsByParent"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.ListSubscriptionsByParent(ctx, parentID)
}

func (d *agentCovDir) ListAllSubscriptions(ctx context.Context) ([]*model.AgentSubscription, error) {
	if err := d.errs["ListAllSubscriptions"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.ListAllSubscriptions(ctx)
}

func (d *agentCovDir) ListRunners(ctx context.Context, ownerID string) ([]*model.RunnerRegistration, error) {
	if err := d.errs["ListRunners"]; err != nil {
		return nil, err
	}
	return d.fakeAgentDir.ListRunners(ctx, ownerID)
}

// agentCovUsers implements agentUserGetter with injectable failures.
type agentCovUsers struct {
	users     map[string]*model.User
	errGet    error
	errUpdate error
}

func (f *agentCovUsers) GetUser(_ context.Context, id string) (*model.User, error) {
	if f.errGet != nil {
		return nil, f.errGet
	}
	u, ok := f.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (f *agentCovUsers) UpdateUser(_ context.Context, u *model.User) error {
	if f.errUpdate != nil {
		return f.errUpdate
	}
	cp := *u
	f.users[u.ID] = &cp
	return nil
}

func agentCovNewSvc() (*AgentService, *agentCovDir, *agentCovUsers) {
	dir := agentCovNewDir()
	users := &agentCovUsers{users: map[string]*model.User{}}
	return NewAgentService(dir, users), dir, users
}

// agentCovSeedAgent installs a template plus its shared agent user row.
func agentCovSeedAgent(t *testing.T, dir *agentCovDir, users *agentCovUsers, slug string) *model.AgentTemplate {
	t.Helper()
	now := time.Now()
	tpl := &model.AgentTemplate{
		Slug:              slug,
		DisplayName:       slug,
		Harness:           model.HarnessClaude,
		Model:             defaultAgentModel,
		Persona:           "seeded persona",
		Limits:            model.DefaultAgentLimits(),
		MaxConcurrentRuns: 1,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := dir.fakeAgentDir.PutTemplate(context.Background(), tpl); err != nil {
		t.Fatalf("seed template: %v", err)
	}
	users.users[AgentUserID(slug)] = &model.User{
		ID:          AgentUserID(slug),
		DisplayName: slug,
		Kind:        model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: slug},
	}
	return tpl
}

func TestAgentCovSeedDefaults(t *testing.T) {
	ctx := context.Background()
	svc, dir, _ := agentCovNewSvc()
	if err := svc.SeedDefaults(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	for _, slug := range []string{AgentSlugGG, AgentSlugQib, AgentSlugDev} {
		if _, err := dir.GetTemplate(ctx, slug); err != nil {
			t.Fatalf("template %s missing: %v", slug, err)
		}
		if dir.agents[AgentUserID(slug)] == nil {
			t.Fatalf("agent user %s missing", slug)
		}
	}
	// Idempotent: second run swallows ErrAlreadyExists from both creates.
	if err := svc.SeedDefaults(ctx); err != nil {
		t.Fatalf("re-seed: %v", err)
	}

	dir.errs["CreateTemplateIfAbsent"] = errAgentCov
	if err := svc.SeedDefaults(ctx); err == nil || !strings.Contains(err.Error(), "seed template") {
		t.Fatalf("want seed template error, got %v", err)
	}
	delete(dir.errs, "CreateTemplateIfAbsent")

	dir.errs["CreateAgentUser"] = errAgentCov
	if err := svc.SeedDefaults(ctx); err == nil || !strings.Contains(err.Error(), "seed agent user") {
		t.Fatalf("want seed agent user error, got %v", err)
	}
}

func TestAgentCovCreateAgent(t *testing.T) {
	ctx := context.Background()
	svc, dir, _ := agentCovNewSvc()

	bad := []CreateAgentInput{
		{Slug: "Bad Slug", Persona: "p"},                                                   // slug pattern
		{Slug: "zed", DisplayName: strings.Repeat("d", 65), Persona: "p"},                  // display too long
		{Slug: "zed", Persona: "   "},                                                      // persona required
		{Slug: "zed", Persona: strings.Repeat("p", 8*1024+1)},                              // persona too long
		{Slug: "zed", Persona: "p", Harness: "warp"},                                       // unknown harness
		{Slug: "zed", Persona: "p", Harness: model.HarnessBedrock, ExecutionMode: "weird"}, // bad exec mode
	}
	for i, in := range bad {
		if _, err := svc.CreateAgent(ctx, in); !errors.Is(err, ErrValidation) {
			t.Fatalf("case %d: want ErrValidation, got %v", i, err)
		}
	}

	dir.errs["GetTemplate"] = errAgentCov
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "zed", Persona: "p"}); !errors.Is(err, errAgentCov) {
		t.Fatalf("want boom from GetTemplate, got %v", err)
	}
	delete(dir.errs, "GetTemplate")

	dir.errs["PutTemplate"] = errAgentCov
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "zed", Persona: "p"}); err == nil || !strings.Contains(err.Error(), "create template") {
		t.Fatalf("want create template error, got %v", err)
	}
	delete(dir.errs, "PutTemplate")

	dir.errs["CreateAgentUser"] = errAgentCov
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "zed", Persona: "p"}); err == nil || !strings.Contains(err.Error(), "create agent user") {
		t.Fatalf("want create agent user error, got %v", err)
	}
	delete(dir.errs, "CreateAgentUser")

	// The template row survived the failed user create above → duplicate slug.
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: " ZED ", Persona: "p"}); !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("want already exists, got %v", err)
	}

	// Bedrock happy path: default model + execution mode, display <- slug.
	tpl, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "br", Persona: " p ", Harness: model.HarnessBedrock})
	if err != nil {
		t.Fatalf("create bedrock: %v", err)
	}
	if tpl.Model != defaultAPIModel(model.HarnessBedrock) || tpl.ExecutionMode != model.ExecutionRunner ||
		tpl.DisplayName != "br" || tpl.Persona != "p" || tpl.MaxConcurrentRuns != 1 {
		t.Fatalf("bedrock defaults wrong: %+v", tpl)
	}

	// CLI harness keeps its model and no execution mode; AlreadyExists from
	// CreateAgentUser is swallowed.
	dir.errs["CreateAgentUser"] = store.ErrAlreadyExists
	tpl2, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "cli", DisplayName: " Cli ", Persona: "p", Harness: model.HarnessClaude, Model: " m "})
	if err != nil {
		t.Fatalf("create cli: %v", err)
	}
	if tpl2.ExecutionMode != "" || tpl2.DisplayName != "Cli" || tpl2.Model != "m" {
		t.Fatalf("cli agent wrong: %+v", tpl2)
	}
}

func TestAgentCovRenameAgent(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")

	if _, err := svc.RenameAgent(ctx, "gg", "  "); !errors.Is(err, ErrValidation) {
		t.Fatalf("want validation for empty name, got %v", err)
	}
	if _, err := svc.RenameAgent(ctx, "gg", strings.Repeat("n", 65)); !errors.Is(err, ErrValidation) {
		t.Fatalf("want validation for long name, got %v", err)
	}
	if _, err := svc.RenameAgent(ctx, "nope", "New"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}

	dir.errs["PutTemplate"] = errAgentCov
	if _, err := svc.RenameAgent(ctx, "gg", "New"); err == nil || !strings.Contains(err.Error(), "rename template") {
		t.Fatalf("want rename template error, got %v", err)
	}
	delete(dir.errs, "PutTemplate")

	users.errUpdate = errAgentCov
	if _, err := svc.RenameAgent(ctx, " GG ", "New"); err == nil || !strings.Contains(err.Error(), "rename user") {
		t.Fatalf("want rename user error, got %v", err)
	}
	users.errUpdate = nil

	tpl, err := svc.RenameAgent(ctx, "gg", "Gigi")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if tpl.DisplayName != "Gigi" || users.users[AgentUserID("gg")].DisplayName != "Gigi" {
		t.Fatalf("rename not applied: %+v", tpl)
	}

	// Missing user row: template still renamed.
	delete(users.users, AgentUserID("gg"))
	if tpl, err = svc.RenameAgent(ctx, "gg", "Solo"); err != nil || tpl.DisplayName != "Solo" {
		t.Fatalf("rename without user row: %v %+v", err, tpl)
	}
}

func TestAgentCovSetAgentSkills(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")

	if _, err := svc.SetAgentSkills(ctx, "nope", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
	if _, err := svc.SetAgentSkills(ctx, "gg", []string{"ghost"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("want unknown skill, got %v", err)
	}

	ids := make([]string, 0, AgentSkillsMax+1)
	for i := 0; i <= AgentSkillsMax; i++ {
		id := fmt.Sprintf("sk-%d", i)
		if err := dir.fakeAgentDir.PutSkill(ctx, &model.Skill{ID: id, Name: id, Instructions: "i", CreatedBy: "u1"}); err != nil {
			t.Fatalf("put skill: %v", err)
		}
		ids = append(ids, id)
	}
	if _, err := svc.SetAgentSkills(ctx, "gg", ids); !errors.Is(err, ErrValidation) {
		t.Fatalf("want too many skills, got %v", err)
	}

	dir.errs["PutTemplate"] = errAgentCov
	if _, err := svc.SetAgentSkills(ctx, "gg", ids[:2]); err == nil || !strings.Contains(err.Error(), "set skills") {
		t.Fatalf("want set skills error, got %v", err)
	}
	delete(dir.errs, "PutTemplate")

	tpl, err := svc.SetAgentSkills(ctx, " GG", []string{" sk-0 ", "", "sk-0", "sk-1"})
	if err != nil {
		t.Fatalf("set skills: %v", err)
	}
	if len(tpl.SkillIDs) != 2 || tpl.SkillIDs[0] != "sk-0" || tpl.SkillIDs[1] != "sk-1" {
		t.Fatalf("skills not deduped: %v", tpl.SkillIDs)
	}
}

func TestAgentCovHelpers(t *testing.T) {
	if got := defaultAPIModel(model.HarnessBedrock); got == "" {
		t.Fatal("bedrock default model empty")
	}
	if got := defaultAPIModel(model.HarnessClaude); got != "" {
		t.Fatalf("non-API default model = %q", got)
	}

	if firstNonEmpty("", "x", "y") != "x" || firstNonEmpty("", "") != "" {
		t.Fatal("firstNonEmpty wrong")
	}

	def := model.DefaultAgentLimits()
	if got := mergeLimits(nil, model.AgentLimits{}); got != def {
		t.Fatalf("mergeLimits all-default = %+v", got)
	}
	got := mergeLimits(&model.AgentLimits{MaxTurns: 3, MaxTokens: 11}, model.AgentLimits{MaxWallClockSec: 42, MaxTokens: 7})
	if got.MaxTurns != 3 || got.MaxWallClockSec != 42 || got.MaxTokens != 11 || got.MaxPosts != def.MaxPosts {
		t.Fatalf("mergeLimits override = %+v", got)
	}
	if got := mergeLimits(nil, model.AgentLimits{MaxTokens: 7}); got.MaxTokens != 7 {
		t.Fatalf("mergeLimits template tokens = %+v", got)
	}

	rs := []*model.RunnerRegistration{{Harnesses: []model.RunnerHarness{{Name: model.HarnessClaude}}}}
	if !RunnerHasHarness(rs, model.HarnessClaude) || RunnerHasHarness(rs, model.HarnessCodex) {
		t.Fatal("RunnerHasHarness wrong")
	}
}

func TestAgentCovResolve(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")
	agent := users.users[AgentUserID("gg")]

	if _, err := svc.Resolve(ctx, &model.User{}, "u1"); err == nil {
		t.Fatal("want not-an-agent error")
	}

	dir.errs["GetTemplate"] = errAgentCov
	if _, err := svc.Resolve(ctx, agent, "u1"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want template error, got %v", err)
	}
	delete(dir.errs, "GetTemplate")

	dir.errs["GetAgentPrefs"] = errAgentCov
	if _, err := svc.Resolve(ctx, agent, "u1"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want prefs error, got %v", err)
	}
	delete(dir.errs, "GetAgentPrefs")

	// No prefs at all: inherit template, platform defaults fill the rest.
	res, err := svc.Resolve(ctx, agent, "u1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Harness != model.HarnessClaude || res.Model != defaultAgentModel ||
		res.FollowUpMins != model.DefaultFollowUpMins || res.MaxConcurrentRuns != 1 ||
		res.OfflinePolicy != model.OfflinePolicyReject || res.FollowUpMode != model.FollowUpOff {
		t.Fatalf("resolve defaults wrong: %+v", res)
	}

	// Harness re-pin without a model: the template's model must not leak.
	if err := dir.fakeAgentDir.PutAgentPrefs(ctx, &model.UserAgentPrefs{UserID: "u1", Slug: "gg", Harness: model.HarnessCodex}); err != nil {
		t.Fatal(err)
	}
	if res, err = svc.Resolve(ctx, agent, "u1"); err != nil || res.Model != "" || res.Harness != model.HarnessCodex {
		t.Fatalf("codex re-pin: %v %+v", err, res)
	}

	// Bedrock re-pin: default API model + resolved execution mode + overrides.
	if err := dir.fakeAgentDir.PutAgentPrefs(ctx, &model.UserAgentPrefs{
		UserID: "u1", Slug: "gg",
		Harness:       model.HarnessBedrock,
		ExecutionMode: model.ExecutionServer,
		Persona:       "mine",
		FollowUpMode:  model.FollowUpWindow,
		FollowUpMins:  25,
		Limits:        &model.AgentLimits{MaxTurns: 5},
	}); err != nil {
		t.Fatal(err)
	}
	res, err = svc.Resolve(ctx, agent, "u1")
	if err != nil {
		t.Fatalf("resolve bedrock: %v", err)
	}
	if res.Model != defaultAPIModel(model.HarnessBedrock) || res.ExecutionMode != model.ExecutionServer ||
		res.Persona != "mine" || res.FollowUpMins != 25 || res.Limits.MaxTurns != 5 {
		t.Fatalf("bedrock resolve wrong: %+v", res)
	}

	// MaxConcurrentRuns floors at 1 when the template says 0.
	tpl0 := agentCovSeedAgent(t, dir, users, "zero")
	tpl0.MaxConcurrentRuns = 0
	if err := dir.fakeAgentDir.PutTemplate(ctx, tpl0); err != nil {
		t.Fatal(err)
	}
	if res, err = svc.Resolve(ctx, users.users[AgentUserID("zero")], "u1"); err != nil || res.MaxConcurrentRuns != 1 {
		t.Fatalf("concurrent floor: %v %+v", err, res)
	}
}

func TestAgentCovListAgents(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")

	dir.errs["ListTemplates"] = errAgentCov
	if _, err := svc.ListAgents(ctx); !errors.Is(err, errAgentCov) {
		t.Fatalf("want list templates error, got %v", err)
	}
	delete(dir.errs, "ListTemplates")

	users.errGet = errAgentCov
	if _, err := svc.ListAgents(ctx); !errors.Is(err, errAgentCov) {
		t.Fatalf("want user error, got %v", err)
	}
	users.errGet = nil

	// A template with no user row is skipped, not fatal.
	if err := dir.fakeAgentDir.PutTemplate(ctx, &model.AgentTemplate{Slug: "ghost", Harness: model.HarnessClaude}); err != nil {
		t.Fatal(err)
	}
	out, err := svc.ListAgents(ctx)
	if err != nil || len(out) != 1 || out[0].ID != AgentUserID("gg") {
		t.Fatalf("list agents: %v %+v", err, out)
	}

	if u, err := svc.GetAgentBySlug(ctx, "gg"); err != nil || u.ID != AgentUserID("gg") {
		t.Fatalf("get by slug: %v", err)
	}
	if _, err := svc.GetAgentBySlug(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestAgentCovUpdatePrefs(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")
	sp := func(s string) *string { return &s }
	ip := func(i int) *int { return &i }
	bp := func(b bool) *bool { return &b }

	if _, err := svc.UpdatePrefs(ctx, "u1", "nope", AgentPrefsPatch{}); err == nil || !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("want unknown agent, got %v", err)
	}
	dir.errs["GetAgentPrefs"] = errAgentCov
	if _, err := svc.UpdatePrefs(ctx, "u1", "gg", AgentPrefsPatch{}); !errors.Is(err, errAgentCov) {
		t.Fatalf("want prefs load error, got %v", err)
	}
	delete(dir.errs, "GetAgentPrefs")

	bad := []AgentPrefsPatch{
		{Harness: sp("warp")},
		{ExecutionMode: sp("weird")},
		{OfflinePolicy: sp("maybe")},
		{FollowUpMode: sp("sometimes")},
		{AutoAllow: &[]string{"coffee"}},
		{FollowUpMins: ip(2000)},
	}
	for i, p := range bad {
		if _, err := svc.UpdatePrefs(ctx, "u1", "gg", p); err == nil {
			t.Fatalf("bad patch %d: want error", i)
		}
	}

	limits := model.AgentLimits{MaxTurns: 9}
	prefs, err := svc.UpdatePrefs(ctx, "u1", "gg", AgentPrefsPatch{
		Harness:       sp(model.HarnessBedrock),
		Model:         sp("m-1"),
		ExecutionMode: sp(model.ExecutionServer),
		Persona:       sp("mine"),
		Limits:        &limits,
		OfflinePolicy: sp(model.OfflinePolicyQueue),
		FollowUpMode:  sp(model.FollowUpAlways),
		FollowUpMins:  ip(30),
		FollowUpAsk:   bp(true),
		AutoAllow:     &[]string{" Read ", "read", "edit"},
	})
	if err != nil {
		t.Fatalf("update prefs: %v", err)
	}
	if prefs.Harness != model.HarnessBedrock || prefs.Model != "m-1" || prefs.ExecutionMode != model.ExecutionServer ||
		prefs.Persona != "mine" || prefs.Limits == nil || prefs.Limits.MaxTurns != 9 ||
		prefs.OfflinePolicy != model.OfflinePolicyQueue || prefs.FollowUpMode != model.FollowUpAlways ||
		prefs.FollowUpMins != 30 || !prefs.FollowUpAsk ||
		len(prefs.AutoAllow) != 2 || prefs.AutoAllow[0] != "read" || prefs.AutoAllow[1] != "edit" {
		t.Fatalf("prefs wrong: %+v", prefs)
	}

	// Zero limits clear the override; this pass loads the existing row.
	prefs, err = svc.UpdatePrefs(ctx, "u1", "gg", AgentPrefsPatch{Limits: &model.AgentLimits{}})
	if err != nil || prefs.Limits != nil {
		t.Fatalf("limits not cleared: %v %+v", err, prefs)
	}

	dir.errs["PutAgentPrefs"] = errAgentCov
	if _, err := svc.UpdatePrefs(ctx, "u1", "gg", AgentPrefsPatch{}); !errors.Is(err, errAgentCov) {
		t.Fatalf("want put error, got %v", err)
	}
}

func TestAgentCovGetPrefs(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")

	p, err := svc.GetPrefs(ctx, "u1", "gg")
	if err != nil || p.UserID != "u1" || p.Slug != "gg" || p.Harness != "" {
		t.Fatalf("zero prefs: %v %+v", err, p)
	}
	dir.errs["GetAgentPrefs"] = errAgentCov
	if _, err := svc.GetPrefs(ctx, "u1", "gg"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want error, got %v", err)
	}
	delete(dir.errs, "GetAgentPrefs")
	if err := dir.fakeAgentDir.PutAgentPrefs(ctx, &model.UserAgentPrefs{UserID: "u1", Slug: "gg", Persona: "mine"}); err != nil {
		t.Fatal(err)
	}
	if p, err = svc.GetPrefs(ctx, "u1", "gg"); err != nil || p.Persona != "mine" {
		t.Fatalf("stored prefs: %v %+v", err, p)
	}
}

func TestAgentCovSkillsCRUD(t *testing.T) {
	ctx := context.Background()
	svc, dir, _ := agentCovNewSvc()
	sp := func(s string) *string { return &s }

	bad := [][3]string{
		{"  ", "d", "i"}, // name required
		{strings.Repeat("n", model.SkillNameMaxLen+1), "d", "i"},        // name too long
		{"n", strings.Repeat("d", model.SkillDescriptionMaxLen+1), "i"}, // description too long
		{"n", "d", "  "}, // instructions required
		{"n", "d", strings.Repeat("i", model.SkillInstructionsMaxLen+1)}, // instructions too long
	}
	for i, c := range bad {
		if _, err := svc.CreateSkill(ctx, "u1", c[0], c[1], c[2]); !errors.Is(err, ErrValidation) {
			t.Fatalf("bad skill %d: want validation, got %v", i, err)
		}
	}

	dir.errs["PutSkill"] = errAgentCov
	if _, err := svc.CreateSkill(ctx, "u1", "n", "d", "i"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want put error, got %v", err)
	}
	delete(dir.errs, "PutSkill")

	sk, err := svc.CreateSkill(ctx, "u1", " Deploy ", " d ", "steps")
	if err != nil || sk.Name != "Deploy" || sk.Description != "d" || sk.CreatedBy != "u1" {
		t.Fatalf("create skill: %v %+v", err, sk)
	}

	if _, err := svc.UpdateSkill(ctx, "u1", "ghost", SkillPatch{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update: want not found, got %v", err)
	}
	if _, err := svc.UpdateSkill(ctx, "intruder", sk.ID, SkillPatch{}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("update: want forbidden, got %v", err)
	}
	if _, err := svc.UpdateSkill(ctx, "u1", sk.ID, SkillPatch{Name: sp("  ")}); !errors.Is(err, ErrValidation) {
		t.Fatalf("update: want validation, got %v", err)
	}
	dir.errs["PutSkill"] = errAgentCov
	if _, err := svc.UpdateSkill(ctx, "u1", sk.ID, SkillPatch{Name: sp("New")}); !errors.Is(err, errAgentCov) {
		t.Fatalf("update: want put error, got %v", err)
	}
	delete(dir.errs, "PutSkill")
	upd, err := svc.UpdateSkill(ctx, "u1", sk.ID, SkillPatch{Name: sp(" New "), Description: sp(" nd "), Instructions: sp("ni")})
	if err != nil || upd.Name != "New" || upd.Description != "nd" || upd.Instructions != "ni" {
		t.Fatalf("update skill: %v %+v", err, upd)
	}

	if got, err := svc.GetSkill(ctx, sk.ID); err != nil || got.Name != "New" {
		t.Fatalf("get skill: %v", err)
	}
	if all, err := svc.ListSkills(ctx); err != nil || len(all) != 1 {
		t.Fatalf("list skills: %v (%d)", err, len(all))
	}

	if err := svc.DeleteSkill(ctx, "u1", "ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete: want not found, got %v", err)
	}
	if err := svc.DeleteSkill(ctx, "intruder", sk.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete: want forbidden, got %v", err)
	}
	if err := svc.DeleteSkill(ctx, "u1", sk.ID); err != nil {
		t.Fatalf("delete skill: %v", err)
	}
	if _, err := svc.GetSkill(ctx, sk.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("skill not deleted: %v", err)
	}
}

func TestAgentCovMemory(t *testing.T) {
	ctx := context.Background()
	svc, dir, _ := agentCovNewSvc()

	if got, err := svc.GetMemory(ctx, "u1", "a1"); err != nil || got != "" {
		t.Fatalf("unset memory: %v %q", err, got)
	}
	dir.errs["GetAgentMemory"] = errAgentCov
	if _, err := svc.GetMemory(ctx, "u1", "a1"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want memory error, got %v", err)
	}
	delete(dir.errs, "GetAgentMemory")

	if err := svc.UpdateMemory(ctx, "u1", "a1", strings.Repeat("m", model.AgentMemoryMaxBytes+1)); !errors.Is(err, ErrValidation) {
		t.Fatalf("want too big, got %v", err)
	}
	if err := svc.UpdateMemory(ctx, "u1", "a1", "remember this"); err != nil {
		t.Fatalf("update memory: %v", err)
	}
	if got, err := svc.GetMemory(ctx, "u1", "a1"); err != nil || got != "remember this" {
		t.Fatalf("get memory: %v %q", err, got)
	}
}

func TestAgentCovCreateSubscription(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")

	if _, err := svc.CreateSubscription(ctx, "u1", "nope", "ch1", "channel", nil, 0, WatchInput{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
	if _, err := svc.CreateSubscription(ctx, "u1", "gg", "ch1", "channel", nil, 0, WatchInput{ActionMode: "bogus"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("want invalid mode, got %v", err)
	}
	dir.errs["PutAgentSubscription"] = errAgentCov
	if _, err := svc.CreateSubscription(ctx, "u1", "gg", "ch1", "channel", nil, 0, WatchInput{}); !errors.Is(err, errAgentCov) {
		t.Fatalf("want put error, got %v", err)
	}
	delete(dir.errs, "PutAgentSubscription")

	kws := []string{" Budget ", "", strings.Repeat("k", 65)}
	for i := 0; i < 12; i++ {
		kws = append(kws, fmt.Sprintf("kw%d", i))
	}
	sub, err := svc.CreateSubscription(ctx, "u1", "gg", "ch1", "channel", kws, 5, WatchInput{
		ThreadRootID: " t1 ",
		Instruction:  "  " + strings.Repeat("x", 4500),
	})
	if err != nil {
		t.Fatalf("create sub: %v", err)
	}
	if sub.AgentID != AgentUserID("gg") || sub.CreatorID != "u1" ||
		len(sub.Keywords) != 10 || sub.Keywords[0] != "budget" ||
		sub.HeartbeatMins != 15 || len(sub.Instruction) != 4000 ||
		sub.ActionMode != model.WatchActionNotify || sub.ThreadRootID != "t1" {
		t.Fatalf("sub wrong: %+v", sub)
	}

	sub2, err := svc.CreateSubscription(ctx, "u1", "gg", "ch1", "channel", nil, -3, WatchInput{ActionMode: model.WatchActionReply})
	if err != nil || sub2.HeartbeatMins != 0 || sub2.ActionMode != model.WatchActionReply {
		t.Fatalf("negative heartbeat: %v %+v", err, sub2)
	}
}

func TestAgentCovListSubscriptions(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")
	agentID := AgentUserID("gg")

	if _, err := svc.ListSubscriptionsFor(ctx, "u1", "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
	dir.errs["ListAllSubscriptions"] = errAgentCov
	if _, err := svc.ListSubscriptionsFor(ctx, "u1", "gg"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want list error, got %v", err)
	}
	delete(dir.errs, "ListAllSubscriptions")

	for _, sub := range []*model.AgentSubscription{
		{ID: "s1", AgentID: agentID, CreatorID: "u1", ParentID: "ch1"},
		{ID: "s2", AgentID: agentID, CreatorID: "u2", ParentID: "ch1"},
		{ID: "s3", AgentID: "other-agent", CreatorID: "u1", ParentID: "ch2"},
	} {
		if err := dir.fakeAgentDir.PutAgentSubscription(ctx, sub); err != nil {
			t.Fatal(err)
		}
	}
	out, err := svc.ListSubscriptionsFor(ctx, "u1", "gg")
	if err != nil || len(out) != 1 || out[0].ID != "s1" {
		t.Fatalf("list for: %v %+v", err, out)
	}

	dir.errs["ListSubscriptionsByParent"] = errAgentCov
	if _, err := svc.ListWatchersInParent(ctx, "u1", "ch1"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want watchers error, got %v", err)
	}
	delete(dir.errs, "ListSubscriptionsByParent")
	got, err := svc.ListWatchersInParent(ctx, "u1", "ch1")
	if err != nil || len(got) != 1 || got[0].ID != "s1" {
		t.Fatalf("watchers: %v %+v", err, got)
	}
}

func TestAgentCovUpdateDeleteSubscription(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	agentCovSeedAgent(t, dir, users, "gg")

	for id, creator := range map[string]string{"s1": "u1", "s2": "u2"} {
		if err := dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
			ID: id, AgentID: AgentUserID("gg"), CreatorID: creator, ParentID: "ch1", ActionMode: model.WatchActionNotify,
		}); err != nil {
			t.Fatal(err)
		}
	}

	dir.errs["ListSubscriptionsByParent"] = errAgentCov
	if _, err := svc.UpdateSubscription(ctx, "u1", "ch1", "s1", "", ""); !errors.Is(err, errAgentCov) {
		t.Fatalf("update: want list error, got %v", err)
	}
	if err := svc.DeleteSubscription(ctx, "u1", "ch1", "s1"); !errors.Is(err, errAgentCov) {
		t.Fatalf("delete: want list error, got %v", err)
	}
	delete(dir.errs, "ListSubscriptionsByParent")

	if _, err := svc.UpdateSubscription(ctx, "u1", "ch1", "s2", "", ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("update: want forbidden, got %v", err)
	}
	if _, err := svc.UpdateSubscription(ctx, "u1", "ch1", "s1", "", "bogus"); !errors.Is(err, ErrValidation) {
		t.Fatalf("update: want invalid mode, got %v", err)
	}
	dir.errs["PutAgentSubscription"] = errAgentCov
	if _, err := svc.UpdateSubscription(ctx, "u1", "ch1", "s1", "x", ""); !errors.Is(err, errAgentCov) {
		t.Fatalf("update: want put error, got %v", err)
	}
	delete(dir.errs, "PutAgentSubscription")
	sub, err := svc.UpdateSubscription(ctx, "u1", "ch1", "s1", "  watch budget  ", model.WatchActionDraft)
	if err != nil || sub.Instruction != "watch budget" || sub.ActionMode != model.WatchActionDraft {
		t.Fatalf("update sub: %v %+v", err, sub)
	}
	if _, err := svc.UpdateSubscription(ctx, "u1", "ch1", "ghost", "", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update: want not found, got %v", err)
	}

	if err := svc.DeleteSubscription(ctx, "u1", "ch1", "s2"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete: want forbidden, got %v", err)
	}
	if err := svc.DeleteSubscription(ctx, "u1", "ch1", "ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete: want not found, got %v", err)
	}
	if err := svc.DeleteSubscription(ctx, "u1", "ch1", "s1"); err != nil {
		t.Fatalf("delete sub: %v", err)
	}
	if got, _ := dir.fakeAgentDir.ListSubscriptionsByParent(ctx, "ch1"); len(got) != 1 {
		t.Fatalf("sub not deleted: %+v", got)
	}
}

func TestAgentCovLiveRunners(t *testing.T) {
	ctx := context.Background()
	svc, dir, _ := agentCovNewSvc()

	dir.errs["ListRunners"] = errAgentCov
	if _, err := svc.LiveRunners(ctx, "u1"); !errors.Is(err, errAgentCov) {
		t.Fatalf("want list error, got %v", err)
	}
	delete(dir.errs, "ListRunners")

	now := time.Now()
	if err := dir.PutRunner(ctx, &model.RunnerRegistration{RunnerID: "r-live", OwnerID: "u1", LeaseExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if err := dir.PutRunner(ctx, &model.RunnerRegistration{RunnerID: "r-dead", OwnerID: "u1", LeaseExpiresAt: now.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	live, err := svc.LiveRunners(ctx, "u1")
	if err != nil || len(live) != 1 || live[0].RunnerID != "r-live" {
		t.Fatalf("live runners: %v %+v", err, live)
	}
}
