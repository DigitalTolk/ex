package app

import (
	"context"
	"log/slog"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// agentSystem is agents-as-users and everything that runs them: the run
// orchestrator, runner pairing, shared context, connectors, server-side
// Bedrock execution, coding tasks and projects.
type agentSystem struct {
	runnerTokens *agents.RunnerTokenService
	svc          *agents.AgentService
	orch         *agents.Orchestrator
	context      *agents.ContextService
	connectors   *agents.ConnectorService
	// engine is nil unless server-side Bedrock execution is enabled.
	engine      *agents.ServerEngine
	codingTasks *agents.CodingTaskService
	projects    *agents.ProjectService
}

// loadBedrockConfig is a seam over the AWS config load so its failure arm is
// testable.
var loadBedrockConfig = awsconfig.LoadDefaultConfig

func (a *App) buildAgents(context.Context) error {
	cfg, in, c, ag := a.cfg, &a.infra, &a.chat, &a.agents

	// ex-runner installs: pairing, renewal, the Runners page, and the
	// revocation check behind every runner route. Deactivation and password
	// reset disconnect an account's runners with its sessions.
	ag.runnerTokens = agents.NewRunnerTokenService(in.tokens, c.users, in.jwt)
	ag.runnerTokens.SetPublisher(in.pubsub)
	ag.runnerTokens.SetRequireDeviceKey(cfg.RunnerRequireDeviceKey)
	c.users.SetRunnerRevoker(ag.runnerTokens)
	c.auth.SetRunnerRevoker(ag.runnerTokens)

	// Agents-as-users + the run orchestrator. Additive: agents ride the
	// existing user rows, runs/timelines are new RUN# items, fan-out uses the
	// existing pub/sub.
	ag.svc = agents.NewAgentService(store.NewAgentStore(in.db), in.users)
	// Agent prefs are partitioned by user, so the admin panel's "how many
	// people have their own settings" and its reset both walk the roster.
	ag.svc.SetUserLister(in.users)
	ag.orch = agents.NewOrchestrator(store.NewRunStore(in.db), ag.svc, in.users, c.messages, in.pubsub, in.jwt)
	c.users.SetAutomationStopper(ag.orch) // deactivating an account stops its agents
	c.messages.SetAgentDispatcher(ag.orch)
	// Deleting a chat sweeps its agent-run activity logs (a thread root sweeps
	// every reply's logs too).
	c.messages.SetRunLogPurger(ag.orch)
	// Agent posts carry used-skill badges (picks + invoke_skill calls).
	c.messages.SetRunSkillResolver(ag.orch.RunSkillBadges)
	ag.orch.SetOwnerDMResolver(c.conversations)
	// A scheduled order with no channel lives in the creator's DM with the agent.
	ag.svc.SetDMResolver(c.conversations)
	// Shared context (CTX#): visibility rides the message-service access
	// check, so context is readable exactly where the chat is.
	ag.context = agents.NewContextService(store.NewContextStore(in.db), c.messages)
	ag.orch.SetContextService(ag.context)
	// Tier terminal runs' timelines to S3 (hot events stay in DynamoDB while a
	// run is live; on completion they roll into one object and the hot rows
	// are pruned). No S3 configured → events stay in DynamoDB.
	if in.s3 != nil {
		ag.orch.SetEventArchive(storage.NewEventArchive(in.s3))
	}

	// Connectors: external-service API docs bundles + per-user credentials
	// (installed via the SPA, shipped to the invoker's runner per run).
	ag.connectors = agents.NewConnectorService(store.NewConnectorStore(in.db))
	// Connector endpoints are fetched server-side WITH a user's credential,
	// so production refuses plain HTTP and non-routable targets outright
	// (SSRF); a dev workspace may point a connector at a service on the same
	// machine.
	agents.AllowPrivateConnectorTargets(cfg.IsDev())
	ag.orch.SetConnectorRegistry(ag.connectors)
	ag.engine = newServerEngine(cfg, ag.orch, ag.connectors)
	if ag.engine != nil {
		ag.orch.SetServerEngine(ag.engine)
	}
	// The connector catalog is SOURCED from the standalone
	// connector-provider: ex pulls docs + admin auth from it (never the
	// reverse). The sync loop starts with the other background workers, so
	// shutdown stops it; admins re-pull via POST /api/v1/connectors/sync.
	if cfg.ConnectorProviderURL != "" {
		ag.connectors.SetProvider(cfg.ConnectorProviderURL, cfg.ConnectorProviderKey)
	}

	// The invoker's hidden skills prune the bundle's "# Workspace skills" index.
	ag.orch.SetSkillPrefs(c.userState)
	// Agent runs see the files on the messages they answer (transcript
	// markers, Bedrock content blocks, runner downloads) and may post their
	// own files back.
	ag.orch.SetAttachments(c.attachments)

	// Coding tasks: the deterministic task layer around the dev agent —
	// project channels, task threads, lifecycle gates. The orchestrator reads
	// tasks for dispatch/claim/bundles; the task service owns creation and
	// transitions.
	tasks := store.NewTaskStore(in.db)
	ag.orch.SetTaskStore(tasks)
	ag.codingTasks = agents.NewCodingTaskService(tasks, c.channels, c.messages, in.users, ag.svc, ag.orch)
	ag.codingTasks.SetBaseURL(cfg.BaseURL)
	// Projects page + design references: the same project rows coding tasks
	// learn, plus screenshots the design agent copies from.
	ag.projects = agents.NewProjectService(tasks, c.attachments)
	ag.projects.SetPublisher(in.pubsub)
	ag.orch.SetProjects(ag.projects)
	return nil
}

// newServerEngine enables server-side Bedrock execution: agents with
// harness=bedrock and executionMode=server run their Converse loop in THIS
// process on the task role's credentials — they answer with no desktop app
// open, and connector calls never leave the backend. Off (nil) unless
// BEDROCK_REGION is set, and when the AWS config cannot load; server-mode
// invocations then keep failing legibly.
func newServerEngine(cfg *config.Config, orch *agents.Orchestrator, connectors *agents.ConnectorService) *agents.ServerEngine {
	if cfg.BedrockRegion == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(cfg.BedrockRegion)}
	// Local dev: the environment's AWS_* creds belong to dynamodb-local, so
	// Bedrock gets its own static credentials when provided.
	if cfg.BedrockAccessKeyID != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.BedrockAccessKeyID, cfg.BedrockSecretAccessKey, cfg.BedrockSessionToken)))
	}
	awsCfg, err := loadBedrockConfig(ctx, opts...)
	if err != nil {
		slog.Error("bedrock: aws config load failed; server-side agents disabled", "error", err)
		return nil
	}
	engine := agents.NewServerEngine(orch, connectors, bedrockruntime.NewFromConfig(awsCfg))
	// The bridged workspace tools (channels, DMs, reminders, skills, …) speak
	// this process's own run-tool HTTP API over loopback, with the run's
	// token — full parity with a desktop runner's tool surface.
	engine.SetRunAPIBase("http://127.0.0.1:" + cfg.Port)
	slog.Info("bedrock server engine enabled", "region", cfg.BedrockRegion)
	return engine
}
