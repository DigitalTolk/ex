package service

import (
	"context"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// Projects in runs (plan-projects-design.md §3): which product a run is
// about, so the design agent gets that product's references.

// projectResolver is the ProjectService slice the orchestrator uses.
type projectResolver interface {
	ProjectByToken(ctx context.Context, candidates []string) string
	ProjectByName(ctx context.Context, text string) string
	DesignLayer(ctx context.Context, projectKey string) string
	ScreenImage(ctx context.Context, projectKey, attachmentID string) bool
}

// SetProjects enables project picks and the design-references bundle layer.
// Optional: nil keeps every run project-less.
func (o *Orchestrator) SetProjects(p projectResolver) { o.projects = p }

// resolveProjectPick decides the run's project and the /token that picked it
// (to strip from the prompt; "" when the project came from the thread or by
// name).
//
// Precedence: a /project token on the message, then — for the design agent
// only — the project named in the message's words; then the same two over
// the whole thread, so replies that tweak a mockup keep its project.
//
// For every other agent a token that is ALSO a connector stays a connector
// pick ("/cliffhub" on gg means the API, as it always has) and names are
// never matched: design references ride only explicit picks there.
func (o *Orchestrator) resolveProjectPick(ctx context.Context, invokerID string, agent *model.User, msg *model.Message, parentType string) (key, token string) {
	if o.projects == nil {
		return "", ""
	}
	design := IsDesignAgent(agent)
	if key = o.projects.ProjectByToken(ctx, o.projectCandidates(ctx, parseConnectorTokens(msg.Body), design)); key != "" {
		return key, key
	}
	if design {
		if key = o.projects.ProjectByName(ctx, stripMentionMarkup(msg.Body)); key != "" {
			return key, ""
		}
	}
	if msg.ParentMessageID == "" {
		return "", ""
	}
	msgs, err := o.messages.ListThreadMessages(ctx, invokerID, msg.ParentID, parentType, msg.ParentMessageID)
	if err != nil {
		return "", ""
	}
	var tokens []string
	var text strings.Builder
	for _, m := range msgs {
		tokens = append(tokens, parseConnectorTokens(m.Body)...)
		text.WriteString(stripMentionMarkup(m.Body))
		text.WriteString("\n")
	}
	if key = o.projects.ProjectByToken(ctx, o.projectCandidates(ctx, tokens, design)); key != "" {
		return key, ""
	}
	if design {
		return o.projects.ProjectByName(ctx, text.String()), ""
	}
	return "", ""
}

// projectCandidates drops tokens that name connectors, except for the design
// agent (which has no use for a connector of the same name).
func (o *Orchestrator) projectCandidates(ctx context.Context, tokens []string, design bool) []string {
	if design || o.connectors == nil || len(tokens) == 0 {
		return tokens
	}
	known, err := o.connectors.KnownSlugs(ctx)
	if err != nil {
		return nil // can't tell a connector from a project: attach nothing
	}
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if !known[t] {
			out = append(out, t)
		}
	}
	return out
}

// withoutSlug removes one slug from a pick list.
func withoutSlug(slugs []string, slug string) []string {
	if slug == "" {
		return slugs
	}
	out := slugs[:0:0]
	for _, s := range slugs {
		if s != slug {
			out = append(out, s)
		}
	}
	return out
}

// RunMayReadScreen reports whether run may download attachmentID as one of
// its project's reference screenshots.
func (o *Orchestrator) RunMayReadScreen(ctx context.Context, run *model.Run, attachmentID string) bool {
	return o.projects != nil && run != nil && run.ProjectKey != "" && o.projects.ScreenImage(ctx, run.ProjectKey, attachmentID)
}

// design adds the "# Design references" layer: the run's project references,
// or — for a design-agent run with no project — the list of projects that
// have references so it can ask.
func (b *bundleBuilder) design() {
	added := false
	if b.o.projects != nil && (b.run.ProjectKey != "" || b.run.AgentID == AgentUserID(AgentSlugDesign)) {
		added = b.take(b.o.projects.DesignLayer(b.ctx, b.run.ProjectKey))
	}
	b.stats["designProject"] = b.run.ProjectKey
	b.stats["designReferences"] = added
}

// requiredRunnerFeatures is what a run of this agent needs from the runner
// that claims it: the design agent fetches reference screenshots and posts
// PNG + HTML, so only runners with file tools may take its runs.
func requiredRunnerFeatures(agent *model.User) []string {
	if IsDesignAgent(agent) {
		return []string{model.RunnerFeatureFiles}
	}
	return nil
}

// hasFeatures reports whether a runner advertising have covers every need.
func hasFeatures(have map[string]bool, need []string) bool {
	for _, f := range need {
		if !have[f] {
			return false
		}
	}
	return true
}
