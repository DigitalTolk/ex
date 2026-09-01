package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Default agent template slugs (plan-v2 §4, revised). gg and qib are SHARED
// workspace agents — plain users owned by no one. What is per-user is
// attribution (whose invocation a run serves, whose machine executes) and
// preferences (each user's prompt/harness/model for when THEY invoke).
// Nothing anywhere may branch on these slugs — they select config, never
// code paths.
const (
	AgentSlugGG  = "gg"
	AgentSlugQib = "qib"
)

// defaultAgentModel pins the seeded templates to the current Opus.
const defaultAgentModel = "claude-opus-5"

// AgentDirectoryStore is the store surface AgentService needs.
type AgentDirectoryStore interface {
	PutTemplate(ctx context.Context, tpl *model.AgentTemplate) error
	CreateTemplateIfAbsent(ctx context.Context, tpl *model.AgentTemplate) error
	GetTemplate(ctx context.Context, slug string) (*model.AgentTemplate, error)
	ListTemplates(ctx context.Context) ([]*model.AgentTemplate, error)
	CreateAgentUser(ctx context.Context, user *model.User) error
	PutAgentPrefs(ctx context.Context, prefs *model.UserAgentPrefs) error
	GetAgentPrefs(ctx context.Context, userID, slug string) (*model.UserAgentPrefs, error)
	PutRunner(ctx context.Context, reg *model.RunnerRegistration) error
	ListRunners(ctx context.Context, ownerID string) ([]*model.RunnerRegistration, error)
	DeleteRunner(ctx context.Context, ownerID, runnerID string) error
	PutSkill(ctx context.Context, sk *model.Skill) error
	GetSkill(ctx context.Context, id string) (*model.Skill, error)
	ListSkills(ctx context.Context) ([]*model.Skill, error)
	DeleteSkill(ctx context.Context, id string) error
	PutAgentMemory(ctx context.Context, m *model.AgentMemory) error
	GetAgentMemory(ctx context.Context, invokerID, agentID string) (*model.AgentMemory, error)
	PutAgentSubscription(ctx context.Context, sub *model.AgentSubscription) error
	ListSubscriptionsByParent(ctx context.Context, parentID string) ([]*model.AgentSubscription, error)
	ListAllSubscriptions(ctx context.Context) ([]*model.AgentSubscription, error)
	DeleteAgentSubscription(ctx context.Context, parentID, id string) error
	PutTaskClaim(ctx context.Context, c *model.TaskClaim) error
	ListTaskClaims(ctx context.Context, parentID, threadRootID string) ([]*model.TaskClaim, error)
	PutAgentFollow(ctx context.Context, f *model.AgentThreadFollow) error
	ListAgentFollows(ctx context.Context, parentID, threadRootID string) ([]*model.AgentThreadFollow, error)
}

// agentUserGetter is the slice of UserStore the agent service needs to
// resolve profiles.
type agentUserGetter interface {
	GetUser(ctx context.Context, id string) (*model.User, error)
	UpdateUser(ctx context.Context, user *model.User) error
}

// AgentService owns agent templates, the shared agent users, and per-user
// preference resolution. Runs are the Orchestrator's business.
type AgentService struct {
	agents AgentDirectoryStore
	users  agentUserGetter
}

// NewAgentService constructs an AgentService.
func NewAgentService(agents AgentDirectoryStore, users agentUserGetter) *AgentService {
	return &AgentService{agents: agents, users: users}
}

// AgentUserID derives the shared agent user's deterministic ID from its
// slug, so every boot converges on the same row.
func AgentUserID(slug string) string {
	return store.DeriveID("agent#" + slug)
}

// SeedDefaults writes the gg/qib templates AND their shared agent users when
// absent. Boot-time idempotent: existing rows (possibly admin-edited) are
// never overwritten.
func (s *AgentService) SeedDefaults(ctx context.Context) error {
	now := time.Now()
	seeds := []*model.AgentTemplate{
		{
			Slug:        AgentSlugGG,
			DisplayName: "gg",
			Harness:     model.HarnessClaude,
			Model:       defaultAgentModel,
			Persona: "You are gg, a general-purpose assistant embedded in this team's chat. " +
				"You answer questions, summarize threads, and draft text on request. " +
				"Be direct and concise; prefer posting one useful reply over many partial ones.",
			Limits:            model.DefaultAgentLimits(),
			MaxConcurrentRuns: 1,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		{
			Slug:        AgentSlugQib,
			DisplayName: "qib",
			Harness:     model.HarnessClaude,
			Model:       defaultAgentModel,
			Persona: "You are qib, a careful reviewer embedded in this team's chat. " +
				"You critique drafts, check claims against the thread, and point out gaps or risks. " +
				"Answer as a short, prioritized list; disagree plainly when warranted.",
			Limits:            model.DefaultAgentLimits(),
			MaxConcurrentRuns: 1,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		{
			Slug:        AgentSlugDev,
			DisplayName: "dev",
			Harness:     model.HarnessClaude,
			Model:       defaultAgentModel,
			Persona:     devPersona,
			Limits:      model.DefaultAgentLimits(),
			// Coding tasks run long and a requester may steer two projects at
			// once; the per-thread busy dedup still serializes each task.
			MaxConcurrentRuns: 2,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
	}
	for _, tpl := range seeds {
		if err := s.agents.CreateTemplateIfAbsent(ctx, tpl); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
			return fmt.Errorf("agent: seed template %s: %w", tpl.Slug, err)
		}
		agentUser := &model.User{
			ID: AgentUserID(tpl.Slug),
			// No email, on purpose: agents never authenticate (no email-index
			// row is written) and every UI surface that shows an email —
			// directory, DM search — would otherwise display a synthetic
			// placeholder that reads as breakage.
			Email:        "",
			DisplayName:  tpl.DisplayName,
			SystemRole:   model.SystemRoleMember,
			AuthProvider: model.AuthProviderAgent,
			Status:       "active",
			Kind:         model.UserKindAgent,
			AgentConfig:  &model.AgentConfig{TemplateSlug: tpl.Slug},
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := s.agents.CreateAgentUser(ctx, agentUser); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
			return fmt.Errorf("agent: seed agent user %s: %w", tpl.Slug, err)
		}
	}
	return nil
}

// devPersona is the seeded coding agent's prompt (plan-coding-agent.md). The
// deterministic parts of the workflow — channel/thread creation, gates,
// lifecycle notes, workspace preparation — live in server/runner code; this
// text only has to make the model reach for the right tool at the right time.
const devPersona = "You are dev, the team's coding agent. You fix bugs and build features in the team's products — " +
	"each a GitLab project made of one or more repos (usually a backend AND a frontend) — working inside the Ex " +
	"code workspace on the requester's own machine, and you never push or open a merge request without the " +
	"requester's sign-off.\n\n" +
	"When someone asks for a fix, feature or chore: (1) resolve the PRODUCT (its name, e.g. \"CliffHub\"), its " +
	"repos with roles, a short title, the goal (fetch a referenced ticket through its connector), and the kind " +
	"(bug | feature | chore). Known products are listed in your context under \"# Known coding projects\"; for a " +
	"product Ex hasn't seen, ask the requester which GitLab repos make it up (frontend, backend, …) — never guess " +
	"a single repo for what is usually full-stack work; (2) call create_coding_task with the product name and " +
	"repos — the server opens the project channel + task thread and starts your task run there; then END your " +
	"turn WITHOUT posting anything (the pointer has already been posted). Never start coding in the channel you " +
	"were asked in; never create a task for chit-chat or questions.\n\n" +
	"In a task run (your context has a # Coding task section and a workspace section): first understand how the " +
	"product works end to end — how it starts (docker compose when the repo ships one), how people sign in, " +
	"which roles see what; the UI lives in the frontend repo — change THAT, never build a standalone page or app " +
	"from scratch, and if the change needs a repo the task doesn't have, say so and ask; keep diffs small and " +
	"focused, one branch across the repos you touch; commit as you go; run the tests before claiming anything " +
	"works; post SHORT milestone updates (root cause, plan, result) — never per-command narration. When the " +
	"change is verified locally, call publish_test_plan: start the product the way the requester uses it (pass " +
	"the dev commands), give the URL to OPEN, numbered steps from the requester's perspective (who to sign in " +
	"as, what to click, what they should see) and counter-checks (what must NOT happen, who must NOT see it, " +
	"what must still work as before) — an API endpoint is never a test plan for a product with a UI. Then END " +
	"your turn so the requester can test; treat every reply in the task thread as steering; use request_mr ONLY " +
	"for the push/MR step and do exactly what it returns. Be direct and concise."

// slugPattern bounds an agent slug: a mention-safe identifier — lowercase,
// starts with a letter, letters/digits/hyphen, 2–32 chars.
var slugPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)

// CreateAgentInput is the admin-supplied definition of a new shared agent.
type CreateAgentInput struct {
	Slug          string
	DisplayName   string
	Harness       string
	Model         string
	ExecutionMode string
	Persona       string
}

// CreateAgent defines a new shared agent (template + its singleton agent
// user), the same shape SeedDefaults produces for gg/qib. Admin-gated at the
// handler. The agent is immediately mentionable workspace-wide; per-user
// prefs still override harness/model/persona as usual.
func (s *AgentService) CreateAgent(ctx context.Context, in CreateAgentInput) (*model.AgentTemplate, error) {
	slug := strings.ToLower(strings.TrimSpace(in.Slug))
	if !slugPattern.MatchString(slug) {
		return nil, fmt.Errorf("agent: slug must be 2–32 chars, lowercase letters/digits/hyphen, starting with a letter: %w", ErrValidation)
	}
	display := strings.TrimSpace(in.DisplayName)
	if display == "" {
		display = slug
	}
	if len(display) > 64 {
		return nil, fmt.Errorf("agent: display name too long: %w", ErrValidation)
	}
	persona := strings.TrimSpace(in.Persona)
	if persona == "" {
		return nil, fmt.Errorf("agent: persona (the agent's prompt) is required: %w", ErrValidation)
	}
	if len(persona) > 8*1024 {
		return nil, fmt.Errorf("agent: persona too long: %w", ErrValidation)
	}
	harness := firstNonEmpty(in.Harness, model.HarnessClaude)
	switch harness {
	case model.HarnessClaude, model.HarnessCodex, model.HarnessBedrock:
	default:
		return nil, fmt.Errorf("agent: unknown harness %q: %w", harness, ErrValidation)
	}
	mdl := strings.TrimSpace(in.Model)
	execMode := ""
	if model.HarnessIsAPI(harness) {
		if mdl == "" {
			mdl = defaultAPIModel(harness)
		}
		execMode = firstNonEmpty(in.ExecutionMode, model.ExecutionRunner)
		switch execMode {
		case model.ExecutionRunner, model.ExecutionServer:
		default:
			return nil, fmt.Errorf("agent: unknown execution mode %q: %w", execMode, ErrValidation)
		}
	}

	// Uniqueness: refuse if a template already claims this slug.
	if _, err := s.agents.GetTemplate(ctx, slug); err == nil {
		return nil, fmt.Errorf("agent: %q already exists: %w", slug, ErrValidation)
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	now := time.Now()
	tpl := &model.AgentTemplate{
		Slug:              slug,
		DisplayName:       display,
		Harness:           harness,
		Model:             mdl,
		ExecutionMode:     execMode,
		Persona:           persona,
		Limits:            model.DefaultAgentLimits(),
		MaxConcurrentRuns: 1,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := s.agents.PutTemplate(ctx, tpl); err != nil {
		return nil, fmt.Errorf("agent: create template: %w", err)
	}
	agentUser := &model.User{
		ID:           AgentUserID(slug),
		DisplayName:  display,
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderAgent,
		Status:       "active",
		Kind:         model.UserKindAgent,
		AgentConfig:  &model.AgentConfig{TemplateSlug: slug},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.agents.CreateAgentUser(ctx, agentUser); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
		return nil, fmt.Errorf("agent: create agent user: %w", err)
	}
	return tpl, nil
}

// RenameAgent changes a shared agent's display name (the @name people see) on
// both the template and its singleton agent user. Admin-only at the handler.
func (s *AgentService) RenameAgent(ctx context.Context, slug, newName string) (*model.AgentTemplate, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	name := strings.TrimSpace(newName)
	if name == "" || len(name) > 64 {
		return nil, fmt.Errorf("agent: display name required (≤64 chars): %w", ErrValidation)
	}
	tpl, err := s.agents.GetTemplate(ctx, slug)
	if err != nil {
		return nil, err
	}
	tpl.DisplayName = name
	tpl.UpdatedAt = time.Now()
	if err := s.agents.PutTemplate(ctx, tpl); err != nil {
		return nil, fmt.Errorf("agent: rename template: %w", err)
	}
	if u, err := s.users.GetUser(ctx, AgentUserID(slug)); err == nil && u != nil {
		u.DisplayName = name
		u.UpdatedAt = time.Now()
		if err := s.users.UpdateUser(ctx, u); err != nil {
			return nil, fmt.Errorf("agent: rename user: %w", err)
		}
	}
	return tpl, nil
}

// AgentSkillsMax bounds how many skills one agent template can pin — every
// attached skill's full instructions ride each run's bundle, so this is a
// context-budget guard, not an arbitrary knob.
const AgentSkillsMax = 8

// SetAgentSkills pins skills to an agent template. Attached skills are
// injected verbatim into every run's context bundle ("# Attached skills"),
// so the agent follows them without needing to discover them. Empty list
// clears. Every id must name an existing skill.
func (s *AgentService) SetAgentSkills(ctx context.Context, slug string, skillIDs []string) (*model.AgentTemplate, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	tpl, err := s.agents.GetTemplate(ctx, slug)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	deduped := make([]string, 0, len(skillIDs))
	for _, id := range skillIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		if _, err := s.agents.GetSkill(ctx, id); err != nil {
			return nil, fmt.Errorf("agent: unknown skill %q: %w", id, ErrValidation)
		}
		seen[id] = true
		deduped = append(deduped, id)
	}
	if len(deduped) > AgentSkillsMax {
		return nil, fmt.Errorf("agent: at most %d skills per agent: %w", AgentSkillsMax, ErrValidation)
	}
	tpl.SkillIDs = deduped
	tpl.UpdatedAt = time.Now()
	if err := s.agents.PutTemplate(ctx, tpl); err != nil {
		return nil, fmt.Errorf("agent: set skills: %w", err)
	}
	return tpl, nil
}

// defaultAPIModel is the model id used when an API harness has no explicit
// pin. Bedrock ids are inference-profile / model ids in the account's region;
// this default targets Claude Sonnet, overridable per-user and per-template.
func defaultAPIModel(harness string) string {
	switch harness {
	case model.HarnessBedrock:
		return "anthropic.claude-3-5-sonnet-20241022-v2:0"
	default:
		return ""
	}
}

// Resolve computes the effective config for a run: the INVOKER's prefs ??
// template ?? platform default (plan-v2 §4 — the invoker's, because the run
// executes on their machine, on their quota, with their prompt).
func (s *AgentService) Resolve(ctx context.Context, agent *model.User, invokerID string) (*model.ResolvedAgentConfig, error) {
	if !agent.IsAgent() || agent.AgentConfig == nil {
		return nil, errors.New("agent: not an agent user")
	}
	slug := agent.AgentConfig.TemplateSlug
	tpl, err := s.agents.GetTemplate(ctx, slug)
	if err != nil {
		return nil, fmt.Errorf("agent: template %s: %w", slug, err)
	}
	prefs, err := s.agents.GetAgentPrefs(ctx, invokerID, slug)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("agent: prefs: %w", err)
		}
		prefs = &model.UserAgentPrefs{} // never customized — inherit all
	}
	harness := firstNonEmpty(prefs.Harness, tpl.Harness, model.HarnessClaude)
	mdl := firstNonEmpty(prefs.Model, tpl.Model)
	// Model names live in a harness's own namespace: the template's
	// "claude-opus-5" means nothing to codex or a Bedrock model id. When a
	// pref re-pins the harness without picking a model, fall through to that
	// harness's own default instead of handing it a foreign model string.
	if prefs.Model == "" && harness != tpl.Harness {
		mdl = ""
	}
	// API harnesses need an explicit model id (Bedrock has no "default CLI
	// login" to fall back to) — supply the platform default when none is set.
	execMode := ""
	if model.HarnessIsAPI(harness) {
		if mdl == "" {
			mdl = defaultAPIModel(harness)
		}
		execMode = firstNonEmpty(prefs.ExecutionMode, tpl.ExecutionMode, model.ExecutionRunner)
	}
	res := &model.ResolvedAgentConfig{
		Harness:           harness,
		Model:             mdl,
		ExecutionMode:     execMode,
		Persona:           firstNonEmpty(prefs.Persona, tpl.Persona),
		SkillIDs:          tpl.SkillIDs,
		Limits:            mergeLimits(prefs.Limits, tpl.Limits),
		MaxConcurrentRuns: tpl.MaxConcurrentRuns,
		OfflinePolicy:     firstNonEmpty(prefs.OfflinePolicy, model.OfflinePolicyReject),
		FollowUpMode:      firstNonEmpty(prefs.FollowUpMode, model.FollowUpOff),
		FollowUpMins:      prefs.FollowUpMins,
		FollowUpAsk:       prefs.FollowUpAsk,
		AutoAllow:         prefs.AutoAllow,
	}
	if res.FollowUpMins <= 0 {
		res.FollowUpMins = model.DefaultFollowUpMins
	}
	if res.MaxConcurrentRuns <= 0 {
		res.MaxConcurrentRuns = 1
	}
	return res, nil
}

// ListAgents returns the shared agent users (from the template registry).
func (s *AgentService) ListAgents(ctx context.Context) ([]*model.User, error) {
	templates, err := s.agents.ListTemplates(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*model.User, 0, len(templates))
	for _, tpl := range templates {
		u, err := s.users.GetUser(ctx, AgentUserID(tpl.Slug))
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				continue // template without a user row — seed will converge it
			}
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

// GetAgentBySlug fetches one shared agent user.
func (s *AgentService) GetAgentBySlug(ctx context.Context, slug string) (*model.User, error) {
	return s.users.GetUser(ctx, AgentUserID(slug))
}

// AgentPrefsPatch is the caller-editable slice of their own prefs for one
// shared agent. Nil pointer = leave as-is; pointer to "" = reset to inherit.
type AgentPrefsPatch struct {
	Harness       *string            `json:"harness,omitempty"`
	Model         *string            `json:"model,omitempty"`
	ExecutionMode *string            `json:"executionMode,omitempty"`
	Persona       *string            `json:"persona,omitempty"`
	Limits        *model.AgentLimits `json:"limits,omitempty"`
	OfflinePolicy *string            `json:"offlinePolicy,omitempty"`
	FollowUpMode  *string            `json:"followUpMode,omitempty"`
	FollowUpMins  *int               `json:"followUpMins,omitempty"`
	FollowUpAsk   *bool              `json:"followUpAsk,omitempty"`
	// AutoAllow replaces the pre-approved harness tool classes (nil = leave
	// as-is; empty list = clear).
	AutoAllow *[]string `json:"autoAllow,omitempty"`
}

// UpdatePrefs applies a user's edits to THEIR prefs for a shared agent. No
// ownership check — everyone edits only their own row.
func (s *AgentService) UpdatePrefs(ctx context.Context, userID, slug string, patch AgentPrefsPatch) (*model.UserAgentPrefs, error) {
	if _, err := s.agents.GetTemplate(ctx, slug); err != nil {
		return nil, fmt.Errorf("agent: unknown agent %q: %w", slug, err)
	}
	prefs, err := s.agents.GetAgentPrefs(ctx, userID, slug)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		prefs = &model.UserAgentPrefs{UserID: userID, Slug: slug}
	}
	if patch.Harness != nil {
		switch *patch.Harness {
		case "", model.HarnessClaude, model.HarnessCodex, model.HarnessBedrock:
			prefs.Harness = *patch.Harness
		default:
			return nil, fmt.Errorf("agent: unknown harness %q", *patch.Harness)
		}
	}
	if patch.Model != nil {
		prefs.Model = *patch.Model
	}
	if patch.ExecutionMode != nil {
		switch *patch.ExecutionMode {
		case "", model.ExecutionRunner, model.ExecutionServer:
			prefs.ExecutionMode = *patch.ExecutionMode
		default:
			return nil, fmt.Errorf("agent: unknown execution mode %q", *patch.ExecutionMode)
		}
	}
	if patch.Persona != nil {
		prefs.Persona = *patch.Persona
	}
	if patch.Limits != nil {
		if (*patch.Limits == model.AgentLimits{}) {
			prefs.Limits = nil
		} else {
			prefs.Limits = patch.Limits
		}
	}
	if patch.OfflinePolicy != nil {
		switch *patch.OfflinePolicy {
		case "", model.OfflinePolicyReject, model.OfflinePolicyQueue:
			prefs.OfflinePolicy = *patch.OfflinePolicy
		default:
			return nil, fmt.Errorf("agent: unknown offline policy %q", *patch.OfflinePolicy)
		}
	}
	if patch.FollowUpMode != nil {
		switch *patch.FollowUpMode {
		case "", model.FollowUpOff, model.FollowUpWindow, model.FollowUpAlways:
			prefs.FollowUpMode = *patch.FollowUpMode
		default:
			return nil, fmt.Errorf("agent: unknown follow-up mode %q", *patch.FollowUpMode)
		}
	}
	if patch.AutoAllow != nil {
		seen := map[string]bool{}
		var classes []string
		for _, c := range *patch.AutoAllow {
			c = strings.ToLower(strings.TrimSpace(c))
			if !model.ValidAutoAllow(c) {
				return nil, fmt.Errorf("agent: unknown auto-allow class %q: %w", c, ErrValidation)
			}
			if !seen[c] {
				seen[c] = true
				classes = append(classes, c)
			}
		}
		prefs.AutoAllow = classes
	}
	if patch.FollowUpMins != nil {
		mins := *patch.FollowUpMins
		if mins < 0 || mins > 24*60 {
			return nil, fmt.Errorf("agent: follow-up minutes out of range (0–1440)")
		}
		prefs.FollowUpMins = mins
	}
	if patch.FollowUpAsk != nil {
		prefs.FollowUpAsk = *patch.FollowUpAsk
	}
	prefs.UpdatedAt = time.Now()
	if err := s.agents.PutAgentPrefs(ctx, prefs); err != nil {
		return nil, err
	}
	return prefs, nil
}

// GetPrefs returns the user's prefs for a slug (zero-value prefs when never
// customized).
func (s *AgentService) GetPrefs(ctx context.Context, userID, slug string) (*model.UserAgentPrefs, error) {
	prefs, err := s.agents.GetAgentPrefs(ctx, userID, slug)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return &model.UserAgentPrefs{UserID: userID, Slug: slug}, nil
		}
		return nil, err
	}
	return prefs, nil
}

// ---------------------------------------------------------------- skills

// SkillPatch is the editable slice of a skill.
type SkillPatch struct {
	Name         *string `json:"name,omitempty"`
	Description  *string `json:"description,omitempty"`
	Instructions *string `json:"instructions,omitempty"`
}

func validateSkillFields(name, description, instructions string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return fmt.Errorf("agent: skill name required: %w", ErrValidation)
	case len(name) > model.SkillNameMaxLen:
		return fmt.Errorf("agent: skill name too long: %w", ErrValidation)
	case len(description) > model.SkillDescriptionMaxLen:
		return fmt.Errorf("agent: skill description too long: %w", ErrValidation)
	case strings.TrimSpace(instructions) == "":
		return fmt.Errorf("agent: skill instructions required: %w", ErrValidation)
	case len(instructions) > model.SkillInstructionsMaxLen:
		return fmt.Errorf("agent: skill instructions too long: %w", ErrValidation)
	}
	return nil
}

// CreateSkill adds a workspace skill. Any member may define one; edits and
// deletion belong to its author.
func (s *AgentService) CreateSkill(ctx context.Context, authorID, name, description, instructions string) (*model.Skill, error) {
	if err := validateSkillFields(name, description, instructions); err != nil {
		return nil, err
	}
	now := time.Now()
	sk := &model.Skill{
		ID:           store.NewID(),
		Name:         strings.TrimSpace(name),
		Description:  strings.TrimSpace(description),
		Instructions: instructions,
		CreatedBy:    authorID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.agents.PutSkill(ctx, sk); err != nil {
		return nil, err
	}
	return sk, nil
}

// UpdateSkill applies the author's edits.
func (s *AgentService) UpdateSkill(ctx context.Context, callerID, id string, patch SkillPatch) (*model.Skill, error) {
	sk, err := s.agents.GetSkill(ctx, id)
	if err != nil {
		return nil, err
	}
	if sk.CreatedBy != callerID {
		return nil, fmt.Errorf("agent: not the skill author: %w", ErrForbidden)
	}
	if patch.Name != nil {
		sk.Name = strings.TrimSpace(*patch.Name)
	}
	if patch.Description != nil {
		sk.Description = strings.TrimSpace(*patch.Description)
	}
	if patch.Instructions != nil {
		sk.Instructions = *patch.Instructions
	}
	if err := validateSkillFields(sk.Name, sk.Description, sk.Instructions); err != nil {
		return nil, err
	}
	sk.UpdatedAt = time.Now()
	if err := s.agents.PutSkill(ctx, sk); err != nil {
		return nil, err
	}
	return sk, nil
}

// DeleteSkill removes a skill (author-only).
func (s *AgentService) DeleteSkill(ctx context.Context, callerID, id string) error {
	sk, err := s.agents.GetSkill(ctx, id)
	if err != nil {
		return err
	}
	if sk.CreatedBy != callerID {
		return fmt.Errorf("agent: not the skill author: %w", ErrForbidden)
	}
	return s.agents.DeleteSkill(ctx, id)
}

// ListSkills returns every workspace skill.
func (s *AgentService) ListSkills(ctx context.Context) ([]*model.Skill, error) {
	return s.agents.ListSkills(ctx)
}

// GetSkill fetches one skill.
func (s *AgentService) GetSkill(ctx context.Context, id string) (*model.Skill, error) {
	return s.agents.GetSkill(ctx, id)
}

// ---------------------------------------------------------------- memory

// GetMemory returns the (agent, invoker) core memory; ("" , nil) when unset.
func (s *AgentService) GetMemory(ctx context.Context, invokerID, agentID string) (string, error) {
	m, err := s.agents.GetAgentMemory(ctx, invokerID, agentID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	return m.Content, nil
}

// UpdateMemory replaces the (agent, invoker) core memory — buzz-style: the
// agent curates one small document, not an append log.
func (s *AgentService) UpdateMemory(ctx context.Context, invokerID, agentID, content string) error {
	if len(content) > model.AgentMemoryMaxBytes {
		return fmt.Errorf("agent: memory exceeds %d bytes: %w", model.AgentMemoryMaxBytes, ErrValidation)
	}
	return s.agents.PutAgentMemory(ctx, &model.AgentMemory{
		AgentID:   agentID,
		InvokerID: invokerID,
		Content:   content,
		UpdatedAt: time.Now(),
	})
}

// ---------------------------------------------------------- subscriptions

// CreateSubscription makes an agent watch a channel FOR the creator: matches
// run on their machine and quota.
// WatchInput carries the optional standing-order fields of a watcher on top of
// the base channel-subscription params.
type WatchInput struct {
	ThreadRootID string
	Instruction  string
	ActionMode   string
}

func (s *AgentService) CreateSubscription(ctx context.Context, creatorID, slug, parentID, parentType string, keywords []string, heartbeatMins int, watch WatchInput) (*model.AgentSubscription, error) {
	agent, err := s.GetAgentBySlug(ctx, slug)
	if err != nil {
		return nil, err
	}
	clean := make([]string, 0, len(keywords))
	for _, k := range keywords {
		k = strings.ToLower(strings.TrimSpace(k))
		if k != "" && len(k) <= 64 && len(clean) < 10 {
			clean = append(clean, k)
		}
	}
	if heartbeatMins < 0 {
		heartbeatMins = 0
	}
	if heartbeatMins > 0 && heartbeatMins < 15 {
		heartbeatMins = 15 // floor: idle turns burn the creator's quota
	}
	instruction := strings.TrimSpace(watch.Instruction)
	if len(instruction) > 4000 {
		instruction = instruction[:4000]
	}
	mode := watch.ActionMode
	if mode == "" {
		mode = model.WatchActionNotify // safest default
	}
	if !model.ValidWatchActionMode(mode) {
		return nil, fmt.Errorf("%w: unknown action mode %q", ErrValidation, mode)
	}
	sub := &model.AgentSubscription{
		ID:            store.NewID(),
		AgentID:       agent.ID,
		CreatorID:     creatorID,
		ParentID:      parentID,
		ParentType:    parentType,
		ThreadRootID:  strings.TrimSpace(watch.ThreadRootID),
		Instruction:   instruction,
		ActionMode:    mode,
		Keywords:      clean,
		HeartbeatMins: heartbeatMins,
		CreatedAt:     time.Now(),
	}
	if err := s.agents.PutAgentSubscription(ctx, sub); err != nil {
		return nil, err
	}
	return sub, nil
}

// ListSubscriptionsFor returns the creator's subscriptions for one agent.
func (s *AgentService) ListSubscriptionsFor(ctx context.Context, creatorID, slug string) ([]*model.AgentSubscription, error) {
	agent, err := s.GetAgentBySlug(ctx, slug)
	if err != nil {
		return nil, err
	}
	all, err := s.agents.ListAllSubscriptions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*model.AgentSubscription, 0)
	for _, sub := range all {
		if sub.CreatorID == creatorID && sub.AgentID == agent.ID {
			out = append(out, sub)
		}
	}
	return out, nil
}

// ListWatchersInParent returns the viewer's OWN watchers in one channel/DM,
// across all agents — the data the message list uses to badge watched threads.
// Scoped to the viewer's own subscriptions (a watch is personal, like a
// reminder), so it never leaks who else is watching.
func (s *AgentService) ListWatchersInParent(ctx context.Context, viewerID, parentID string) ([]*model.AgentSubscription, error) {
	subs, err := s.agents.ListSubscriptionsByParent(ctx, parentID)
	if err != nil {
		return nil, err
	}
	out := make([]*model.AgentSubscription, 0, len(subs))
	for _, sub := range subs {
		if sub.CreatorID == viewerID {
			out = append(out, sub)
		}
	}
	return out, nil
}

// UpdateSubscription edits a watcher's standing order (creator-only): its
// instruction and/or action mode. The agent and thread scope are fixed — those
// define a different watcher, so changing them means remove + re-add. An empty
// actionMode leaves the mode unchanged; instruction is set as given (may clear).
func (s *AgentService) UpdateSubscription(ctx context.Context, creatorID, parentID, id, instruction, actionMode string) (*model.AgentSubscription, error) {
	subs, err := s.agents.ListSubscriptionsByParent(ctx, parentID)
	if err != nil {
		return nil, err
	}
	for _, sub := range subs {
		if sub.ID != id {
			continue
		}
		if sub.CreatorID != creatorID {
			return nil, fmt.Errorf("agent: not the subscription creator: %w", ErrForbidden)
		}
		if actionMode != "" {
			if !model.ValidWatchActionMode(actionMode) {
				return nil, fmt.Errorf("agent: invalid action mode %q: %w", actionMode, ErrValidation)
			}
			sub.ActionMode = actionMode
		}
		sub.Instruction = strings.TrimSpace(instruction)
		if err := s.agents.PutAgentSubscription(ctx, sub); err != nil {
			return nil, err
		}
		return sub, nil
	}
	return nil, store.ErrNotFound
}

// DeleteSubscription removes a subscription (creator-only).
func (s *AgentService) DeleteSubscription(ctx context.Context, creatorID, parentID, id string) error {
	subs, err := s.agents.ListSubscriptionsByParent(ctx, parentID)
	if err != nil {
		return err
	}
	for _, sub := range subs {
		if sub.ID == id {
			if sub.CreatorID != creatorID {
				return fmt.Errorf("agent: not the subscription creator: %w", ErrForbidden)
			}
			return s.agents.DeleteAgentSubscription(ctx, parentID, id)
		}
	}
	return store.ErrNotFound
}

// LiveRunners returns the user's runners whose lease is still current.
func (s *AgentService) LiveRunners(ctx context.Context, userID string) ([]*model.RunnerRegistration, error) {
	regs, err := s.agents.ListRunners(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	live := regs[:0]
	for _, r := range regs {
		if r.LeaseExpiresAt.After(now) {
			live = append(live, r)
		}
	}
	return live, nil
}

// RunnerHasHarness reports whether any of the given (live) runners detected
// the harness.
func RunnerHasHarness(runners []*model.RunnerRegistration, harness string) bool {
	for _, r := range runners {
		for _, h := range r.Harnesses {
			if h.Name == harness {
				return true
			}
		}
	}
	return false
}

// ---- small override helpers ----

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// mergeLimits resolves each limit field independently:
// invoker prefs ?? template ?? platform default.
func mergeLimits(override *model.AgentLimits, tpl model.AgentLimits) model.AgentLimits {
	def := model.DefaultAgentLimits()
	pick := func(o, t, d int) int {
		switch {
		case o > 0:
			return o
		case t > 0:
			return t
		default:
			return d
		}
	}
	pick64 := func(o, t, d int64) int64 {
		switch {
		case o > 0:
			return o
		case t > 0:
			return t
		default:
			return d
		}
	}
	var ov model.AgentLimits
	if override != nil {
		ov = *override
	}
	return model.AgentLimits{
		MaxTurns:            pick(ov.MaxTurns, tpl.MaxTurns, def.MaxTurns),
		MaxWallClockSec:     pick(ov.MaxWallClockSec, tpl.MaxWallClockSec, def.MaxWallClockSec),
		MaxTokens:           pick64(ov.MaxTokens, tpl.MaxTokens, def.MaxTokens),
		MaxPosts:            pick(ov.MaxPosts, tpl.MaxPosts, def.MaxPosts),
		MaxConsultDepth:     pick(ov.MaxConsultDepth, tpl.MaxConsultDepth, def.MaxConsultDepth),
		MaxChainRounds:      pick(ov.MaxChainRounds, tpl.MaxChainRounds, def.MaxChainRounds),
		MaxTaskWallClockSec: pick(ov.MaxTaskWallClockSec, tpl.MaxTaskWallClockSec, def.MaxTaskWallClockSec),
		MaxTaskTurns:        pick(ov.MaxTaskTurns, tpl.MaxTaskTurns, def.MaxTaskTurns),
	}
}
