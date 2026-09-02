package model

import "time"

// UserKind discriminates humans from agent instances on the shared user
// record. The zero value ("") is a human so every pre-existing row keeps its
// meaning without a migration.
type UserKind string

const (
	UserKindHuman UserKind = "" // implicit on all existing rows
	UserKindAgent UserKind = "agent"
)

// Harness names an agent backend. claude/codex are LOCAL CLI harnesses the
// runner drives by spawning a process; bedrock is an API harness — the agent
// loop calls a hosted LLM (AWS Bedrock Converse) instead of a local CLI, so
// it has the chat/workspace tool surface but NO local shell or filesystem.
const (
	HarnessClaude  = "claude"
	HarnessCodex   = "codex"
	HarnessBedrock = "bedrock"
)

// HarnessIsAPI reports whether a harness runs as a hosted-LLM API loop rather
// than a spawned local CLI. API harnesses can execute server-side (no desktop
// app needed) and never touch the invoker's shell/files.
func HarnessIsAPI(harness string) bool {
	return harness == HarnessBedrock
}

// Execution modes for API harnesses. Runner = the loop runs on the invoker's
// desktop app (their machine's AWS credentials); Server = the backend runs
// the loop (SSO-federated credentials), so the agent answers with no desktop
// app open. CLI harnesses are always runner-executed.
const (
	ExecutionRunner = "runner"
	ExecutionServer = "server"
)

// Per-invoker agent availability, derived at read time (never stored on the
// agent — agents belong to no one). NeedsSetup means the CALLER's runners
// lack the harness their pin resolves to; Offline means no live runner.
const (
	AgentStatusActive     = "active"
	AgentStatusNeedsSetup = "needs_setup"
	AgentStatusOffline    = "offline"
)

// AgentLimits are the hard bounds the orchestrator enforces per run. The
// zero value of any field means "no override" at the config layer; the
// resolved value is never zero (platform defaults apply last).
type AgentLimits struct {
	MaxTurns int `json:"maxTurns,omitempty" dynamodbav:"maxTurns,omitempty"`
	// MaxWallClockSec caps CONVERSATION runs — ambient invocations (watch,
	// heartbeat, follow-up) where the expected output is a short reply and a
	// stuck harness should die fast.
	MaxWallClockSec int   `json:"maxWallClockSec,omitempty" dynamodbav:"maxWallClockSec,omitempty"`
	MaxTokens       int64 `json:"maxTokens,omitempty" dynamodbav:"maxTokens,omitempty"`
	MaxPosts        int   `json:"maxPosts,omitempty" dynamodbav:"maxPosts,omitempty"`
	MaxConsultDepth int   `json:"maxConsultDepth,omitempty" dynamodbav:"maxConsultDepth,omitempty"`
	// MaxChainRounds bounds agent-to-agent handoffs per conversation chain:
	// a human invocation is round 0; each @mention handoff starts the next
	// round. The INVOKER's resolved value rides the run snapshot, so "how
	// long may a debate I start run" is a per-user tunable.
	MaxChainRounds int `json:"maxChainRounds,omitempty" dynamodbav:"maxChainRounds,omitempty"`
	// MaxTaskWallClockSec is the HARD ceiling for direct-@mention runs, where
	// the user may have asked for real work (coding, research) that
	// legitimately runs long. A direct run doesn't get this up front — every
	// run starts on the short MaxWallClockSec window and earns extensions by
	// producing events (see Orchestrator.ReportEvents); this is the absolute
	// cap those extensions can never pass. Runaway backstop, not a pace-setter.
	MaxTaskWallClockSec int `json:"maxTaskWallClockSec,omitempty" dynamodbav:"maxTaskWallClockSec,omitempty"`
	// MaxTaskTurns is the turn budget for direct runs. A turn is one harness
	// iteration (every tool call consumes one), so real tasks burn them fast —
	// the conversation budget (MaxTurns) starves a coding task at ~13 tool
	// calls.
	MaxTaskTurns int `json:"maxTaskTurns,omitempty" dynamodbav:"maxTaskTurns,omitempty"`
}

// WallClockFor returns the HARD wall-clock ceiling for a run mode: direct
// mentions get the task cap, ambient modes (watch/heartbeat/followup) the
// short conversation cap. Zero fields (runs snapshotted before the task cap
// existed, or unresolved configs) fall back to platform defaults.
func (l AgentLimits) WallClockFor(mode string) time.Duration {
	def := DefaultAgentLimits()
	// Coding-task runs have NO wall-clock cap by decision (plan-coding-agent):
	// the rolling idle deadline (silence kills) and the Stop button are the
	// only reapers. The "ceiling" is just a far horizon so the run token and
	// HardDeadline math stay finite.
	if mode == RunModeTask {
		return taskModeHorizon
	}
	if mode == RunModeDirect {
		sec := l.MaxTaskWallClockSec
		if sec <= 0 {
			sec = def.MaxTaskWallClockSec
		}
		return time.Duration(sec) * time.Second
	}
	sec := l.MaxWallClockSec
	if sec <= 0 {
		sec = def.MaxWallClockSec
	}
	return time.Duration(sec) * time.Second
}

// TurnsFor returns the turn budget for a run mode — task depth for direct
// mentions, the short conversation budget for ambient modes. Zero fields fall
// back to platform defaults.
func (l AgentLimits) TurnsFor(mode string) int {
	def := DefaultAgentLimits()
	if mode == RunModeTask {
		return TaskModeUnlimitedTurns
	}
	if mode == RunModeDirect {
		if l.MaxTaskTurns > 0 {
			return l.MaxTaskTurns
		}
		return def.MaxTaskTurns
	}
	if l.MaxTurns > 0 {
		return l.MaxTurns
	}
	return def.MaxTurns
}

// DefaultAgentLimits is the platform floor applied when neither the caller's
// prefs nor the template override a field.
//
// MaxTurns counts HARNESS iterations — every MCP tool round (set_state,
// get_thread, post_message) consumes one — so it must leave room for a few
// tool calls plus the reply. 3 (the plan's inter-agent round cap, a different
// bound that arrives with consults in Phase 3) starved trivial tasks.
func DefaultAgentLimits() AgentLimits {
	return AgentLimits{
		MaxTurns:        16,
		MaxWallClockSec: 300,
		MaxTokens:       200_000,
		MaxPosts:        10,
		MaxConsultDepth: 1,
		// 6 rounds ≈ three exchanges each for a two-agent debate. Field-tested:
		// 12 dragged (users manually stopping threads); anyone who wants epic
		// debates raises "Discussion rounds" in their agent prefs.
		MaxChainRounds: 6,
		// 2h: coding/build tasks routinely outlive the 5-min conversation cap
		// (field report: real tasks were being killed mid-work). This is the
		// runaway backstop — runs complete when done, not when this expires.
		MaxTaskWallClockSec: 7200,
		// 128: deep enough for real multi-file coding sessions; still finite.
		MaxTaskTurns: 128,
	}
}

// AgentTemplate is a workspace-level agent definition ("gg", "qib"). One
// shared agent user exists per template — agents belong to NO ONE. Runs are
// attributed to whoever invoked them, and execute on the invoker's own
// machine with the invoker's per-user preferences applied. Admin-managed.
type AgentTemplate struct {
	Slug        string `json:"slug" dynamodbav:"slug"`
	DisplayName string `json:"displayName" dynamodbav:"displayName"`
	Harness     string `json:"harness" dynamodbav:"harness"`
	Model       string `json:"model,omitempty" dynamodbav:"model,omitempty"`
	// ExecutionMode applies to API harnesses (bedrock): "runner" (default) or
	// "server". Empty/ignored for CLI harnesses, which are always runner-run.
	ExecutionMode     string      `json:"executionMode,omitempty" dynamodbav:"executionMode,omitempty"`
	Persona           string      `json:"persona" dynamodbav:"persona"`
	SkillIDs          []string    `json:"skillIDs,omitempty" dynamodbav:"skillIDs,omitempty"`
	Limits            AgentLimits `json:"limits" dynamodbav:"limits"`
	MaxConcurrentRuns int         `json:"maxConcurrentRuns" dynamodbav:"maxConcurrentRuns"`
	CreatedAt         time.Time   `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt         time.Time   `json:"updatedAt" dynamodbav:"updatedAt"`
}

// AgentConfig marks a user row as one of the shared agent users. It carries
// identity only — behavior lives on the template plus each invoker's
// UserAgentPrefs, resolved per run.
type AgentConfig struct {
	TemplateSlug string `json:"templateSlug" dynamodbav:"templateSlug"`
}

// UserAgentPrefs are ONE USER's preferences for how a shared agent behaves
// when THEY invoke it — the prompt they edit, the harness pin, the model.
// Nil/empty fields inherit the template. Stored per (userID, slug); never on
// the agent, which is shared.
type UserAgentPrefs struct {
	UserID string `json:"userID" dynamodbav:"userID"`
	Slug   string `json:"slug" dynamodbav:"slug"`

	Harness string       `json:"harness,omitempty" dynamodbav:"harness,omitempty"`
	Model   string       `json:"model,omitempty" dynamodbav:"model,omitempty"`
	Persona string       `json:"persona,omitempty" dynamodbav:"persona,omitempty"`
	Limits  *AgentLimits `json:"limits,omitempty" dynamodbav:"limits,omitempty"`
	// ExecutionMode (API harnesses only): "runner" | "server". "" inherits.
	ExecutionMode string `json:"executionMode,omitempty" dynamodbav:"executionMode,omitempty"`
	// OfflinePolicy: "" inherits the platform default (reject).
	OfflinePolicy string `json:"offlinePolicy,omitempty" dynamodbav:"offlinePolicy,omitempty"`

	// Thread follow-ups: whether MY invocations of this agent keep listening
	// when I reply in the same thread WITHOUT re-tagging it. "" inherits the
	// platform default (off). Runs on my quota — my agent, my choice.
	FollowUpMode string `json:"followUpMode,omitempty" dynamodbav:"followUpMode,omitempty"`
	FollowUpMins int    `json:"followUpMins,omitempty" dynamodbav:"followUpMins,omitempty"`
	// FollowUpAsk: the agent must ask me (approval gate) before actually
	// posting a follow-up reply.
	FollowUpAsk bool `json:"followUpAsk,omitempty" dynamodbav:"followUpAsk,omitempty"`
	// AutoAllow lists harness tool CLASSES (AutoAllow*) this user pre-approves
	// for runs of this agent — the "don't ask me again for reads" dial. The
	// runner's permission gateway honors it locally; everything else still
	// raises an approval card.
	AutoAllow []string `json:"autoAllow,omitempty" dynamodbav:"autoAllow,omitempty"`

	UpdatedAt time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

// Harness tool classes a user may pre-approve (UserAgentPrefs.AutoAllow).
const (
	AutoAllowRead  = "read"  // Read / Glob / Grep / notebook reads
	AutoAllowEdit  = "edit"  // Edit / MultiEdit / Write / NotebookEdit
	AutoAllowShell = "shell" // Bash
	AutoAllowWeb   = "web"   // WebFetch / WebSearch
)

// ValidAutoAllow reports whether c names a known tool class.
func ValidAutoAllow(c string) bool {
	return c == AutoAllowRead || c == AutoAllowEdit || c == AutoAllowShell || c == AutoAllowWeb
}

// Follow-up modes.
const (
	FollowUpOff    = "off"    // default: mentions only
	FollowUpWindow = "window" // follow for FollowUpMins after the agent's last post
	FollowUpAlways = "always" // follow the thread indefinitely
)

// DefaultFollowUpMins is the window when the pref enables follow-ups without
// picking a duration.
const DefaultFollowUpMins = 10

// ResolvedAgentConfig is the effective configuration a run executes under:
// invoker prefs ?? template ?? platform default, computed at run start and
// snapshotted onto the Run row so mid-run edits never change an in-flight
// run (plan-v2 §4).
type ResolvedAgentConfig struct {
	Harness           string      `json:"harness"`
	Model             string      `json:"model"`
	ExecutionMode     string      `json:"executionMode"`
	Persona           string      `json:"persona"`
	SkillIDs          []string    `json:"skillIDs,omitempty"`
	Limits            AgentLimits `json:"limits"`
	MaxConcurrentRuns int         `json:"maxConcurrentRuns"`
	OfflinePolicy     string      `json:"offlinePolicy"`
	FollowUpMode      string      `json:"followUpMode"`
	FollowUpMins      int         `json:"followUpMins"`
	FollowUpAsk       bool        `json:"followUpAsk"`
	AutoAllow         []string    `json:"autoAllow,omitempty"`
}

// RunState is the run lifecycle state machine. Direct mode at Phase 1 uses:
// queued → acknowledged → running → completed | failed | canceled.
type RunState string

const (
	RunStateQueued       RunState = "queued"
	RunStateAcknowledged RunState = "acknowledged"
	RunStateRunning      RunState = "running"
	RunStateCompleted    RunState = "completed"
	RunStateFailed       RunState = "failed"
	RunStateCanceled     RunState = "canceled"
)

// Terminal reports whether the state accepts no further work. Tool calls and
// runner events against a terminal run are rejected.
func (s RunState) Terminal() bool {
	return s == RunStateCompleted || s == RunStateFailed || s == RunStateCanceled
}

// RunSpend accumulates the resources a run has consumed, updated from
// runner-reported usage events. Runner figures are untrusted input — the
// orchestrator clamps and enforces against the run's limits (plan-v2 §9).
type RunSpend struct {
	Turns        int   `json:"turns" dynamodbav:"turns"`
	InputTokens  int64 `json:"inputTokens" dynamodbav:"inputTokens"`
	OutputTokens int64 `json:"outputTokens" dynamodbav:"outputTokens"`
	Posts        int   `json:"posts" dynamodbav:"posts"`
}

// Run is one bounded agent task: invoked by a human mention, executed by the
// owner's runner, audited via its EVT# timeline.
type Run struct {
	ID      string `json:"id" dynamodbav:"id"`
	AgentID string `json:"agentID" dynamodbav:"agentID"` // shared agent user id
	// OwnerID is whose MACHINE executes the run. Agents belong to no one, so
	// this is always the invoker at Phase 1 — kept as a separate field because
	// it answers a different question (where does it run) than InvokerID does
	// (whose task, whose permissions, whose prefs).
	OwnerID      string `json:"ownerID" dynamodbav:"ownerID"`
	InvokerID    string `json:"invokerID" dynamodbav:"invokerID"`
	ParentID     string `json:"parentID" dynamodbav:"parentID"`
	ParentType   string `json:"parentType" dynamodbav:"parentType"`
	ThreadRootID string `json:"threadRootID,omitempty" dynamodbav:"threadRootID,omitempty"`
	MessageID    string `json:"messageID" dynamodbav:"messageID"` // invoking message (state reactions land here)

	State  RunState `json:"state" dynamodbav:"state"`
	Mode   string   `json:"mode" dynamodbav:"mode"` // "direct" at Phase 1
	Prompt string   `json:"prompt" dynamodbav:"prompt"`

	// Round is the agent-to-agent handoff depth: 0 = human-invoked; an agent
	// whose reply @mentions another agent starts that agent at Round+1. The
	// orchestrator refuses rounds past the chain cap — the anti-loop bound
	// from plan.md §5.
	Round int `json:"round,omitempty" dynamodbav:"round,omitempty"`
	// PendingAgentIDs sequences a multi-agent human invocation ("@gg & @qib
	// discuss…"): only the first agent starts immediately; each terminal run
	// kicks the next, so every later agent SEES the earlier replies instead
	// of producing a parallel stateless answer.
	PendingAgentIDs []string `json:"pendingAgentIDs,omitempty" dynamodbav:"pendingAgentIDs,omitempty"`
	// CoInvoked lists the display names of ALL agents the invoking message
	// summoned, in mention order. >1 entry means parallel peers: the bundle
	// renders the roster so ordered task splits ("one do X, the other Y")
	// resolve deterministically by position instead of racing.
	CoInvoked []string `json:"coInvoked,omitempty" dynamodbav:"coInvoked,omitempty"`
	// AskFirst (follow-up runs): the invoker requires an approval gate before
	// the agent posts its reply.
	AskFirst bool `json:"askFirst,omitempty" dynamodbav:"askFirst,omitempty"`
	// WatchInstruction + ActionMode carry a watcher's standing order into the
	// run (watch/heartbeat modes). ActionMode also gates posting: notify/draft
	// runs are barred from public posts server-side.
	WatchInstruction string `json:"watchInstruction,omitempty" dynamodbav:"watchInstruction,omitempty"`
	ActionMode       string `json:"actionMode,omitempty" dynamodbav:"actionMode,omitempty"`

	// Config snapshot — what this run actually executes under.
	Harness       string   `json:"harness" dynamodbav:"harness"`
	Model         string   `json:"model,omitempty" dynamodbav:"model,omitempty"`
	ExecutionMode string   `json:"executionMode,omitempty" dynamodbav:"executionMode,omitempty"`
	PersonaHash   string   `json:"personaHash" dynamodbav:"personaHash"`
	Persona       string   `json:"-" dynamodbav:"persona"` // full text for the runner; hash for display
	SkillIDs      []string `json:"skillIDs,omitempty" dynamodbav:"skillIDs,omitempty"`
	// ConnectorSlugs: the /connector tokens the invoking message carried —
	// the user's explicit pick of which external services this run may use.
	// The runner only syncs docs + injects credentials for these.
	ConnectorSlugs []string `json:"connectorSlugs,omitempty" dynamodbav:"connectorSlugs,omitempty"`
	// TaskID binds the run to a coding task (RunModeTask): its thread root is
	// the task card, its budget is uncapped, and the runner prepares the
	// project workspace before the harness starts.
	TaskID string `json:"taskID,omitempty" dynamodbav:"taskID,omitempty"`
	// AutoAllow: the invoker's pre-approved harness tool classes, snapshotted
	// so the runner's permission gateway can skip the card for them.
	AutoAllow []string    `json:"autoAllow,omitempty" dynamodbav:"autoAllow,omitempty"`
	Limits    AgentLimits `json:"limits" dynamodbav:"limits"`

	Spend RunSpend `json:"spend" dynamodbav:"spend"`

	RunnerID       string     `json:"runnerID,omitempty" dynamodbav:"runnerID,omitempty"`
	LeaseExpiresAt *time.Time `json:"leaseExpiresAt,omitempty" dynamodbav:"leaseExpiresAt,omitempty"`
	// Deadline is the ROLLING kill time: every run starts on the short
	// conversation window and each event batch extends it (harness activity =
	// stay alive; silence = die soon). HardDeadline is the absolute ceiling
	// extensions can never pass — WallClockFor(mode) from claim time. Zero
	// HardDeadline (pre-field runs) means no extensions.
	Deadline     time.Time `json:"deadline" dynamodbav:"deadline"`
	HardDeadline time.Time `json:"hardDeadline,omitempty" dynamodbav:"hardDeadline,omitempty"`

	FailReason string    `json:"failReason,omitempty" dynamodbav:"failReason,omitempty"`
	CreatedAt  time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt" dynamodbav:"updatedAt"`

	// EventsArchived is set once a terminal run's timeline has been rolled into
	// a single object-storage blob and the per-event EVT# rows pruned from the
	// hot table — completed runs are the bulk of event volume, so this keeps
	// DynamoDB small. Timeline reads for such runs load from the archive
	// instead of the EVT# rows; live runs keep their events in DynamoDB.
	EventsArchived bool `json:"eventsArchived,omitempty" dynamodbav:"eventsArchived,omitempty"`
}

// RunEvent is one append-only timeline row. Seq is assigned by the writer
// that owns the sequence (orchestrator for lifecycle events, runner batches
// carry their own runner-side seq offset) and writes are idempotent on
// (RunID, Seq) so a retried batch cannot duplicate the timeline.
type RunEvent struct {
	RunID     string         `json:"runID" dynamodbav:"-"`
	Seq       int64          `json:"seq" dynamodbav:"seq"`
	ActorID   string         `json:"actorID" dynamodbav:"actorID"`
	Type      string         `json:"type" dynamodbav:"type"`
	Payload   map[string]any `json:"payload,omitempty" dynamodbav:"payload,omitempty"`
	CreatedAt time.Time      `json:"createdAt" dynamodbav:"createdAt"`
}

// RunDigest is the ≤5-bullet summary written at terminal state, read into
// other agents' context bundles (plan-v2 §8). InvokerID keeps the "whose
// invocation was this" attribution — the agent itself is shared.
type RunDigest struct {
	RunID     string    `json:"runID" dynamodbav:"-"`
	AgentID   string    `json:"agentID" dynamodbav:"agentID"`
	InvokerID string    `json:"invokerID" dynamodbav:"invokerID"`
	Summary   string    `json:"summary" dynamodbav:"summary"`
	State     RunState  `json:"state" dynamodbav:"state"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
}

// Offline policies: what a mention does when the invoker has no live runner.
// Reject (default) fails fast with a legible notice; queue holds the run
// until the invoker's desktop app comes online (bounded — see the
// orchestrator's queue TTL).
const (
	OfflinePolicyReject = "reject"
	OfflinePolicyQueue  = "queue"
)

// Approval lifecycle states.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
	ApprovalDenied   = "denied"
	ApprovalExpired  = "expired"
)

// Approval is one blocking human-in-the-loop gate inside a run (plan-v2 §7):
// the agent's request_approval tool call parks until the INVOKER decides or
// the deadline lapses (which resolves as denied{approval_timeout} inside the
// tool call — the harness never hits its own MCP timeout first).
type Approval struct {
	ID        string `json:"id" dynamodbav:"id"`
	RunID     string `json:"runID" dynamodbav:"runID"`
	AgentID   string `json:"agentID" dynamodbav:"agentID"`
	InvokerID string `json:"invokerID" dynamodbav:"invokerID"` // the only user who may decide

	Summary string `json:"summary" dynamodbav:"summary"`
	Risk    string `json:"risk,omitempty" dynamodbav:"risk,omitempty"`
	// Kind is the harness tool class (AutoAllow*) for permission-gateway
	// approvals — lets the card offer "always allow reads for this agent".
	Kind string `json:"kind,omitempty" dynamodbav:"kind,omitempty"`
	// Options turns the gate into a multiple-choice question (the ask_user
	// tool): the invoker picks one instead of approve/deny, and the pick
	// lands in Choice. Empty = plain yes/no approval.
	Options []string `json:"options,omitempty" dynamodbav:"options,omitempty"`
	Choice  string   `json:"choice,omitempty" dynamodbav:"choice,omitempty"`

	// ReplyText makes this an editable REPLY PROPOSAL (the propose_reply tool):
	// a reply the agent drafted for the invoker to approve/edit/cancel. When
	// set, approving posts this text (or the invoker's edit) in the thread as
	// the agent; denying posts nothing. ReplyThreadRoot is where it lands, and
	// ReplyToMessageID is the message it answers (shown for context in the UI).
	ReplyText        string `json:"replyText,omitempty" dynamodbav:"replyText,omitempty"`
	ReplyThreadRoot  string `json:"replyThreadRoot,omitempty" dynamodbav:"replyThreadRoot,omitempty"`
	ReplyToMessageID string `json:"replyToMessageID,omitempty" dynamodbav:"replyToMessageID,omitempty"`

	// Note is what the invoker typed alongside the decision — "no, use the
	// seed DB instead" — relayed to the agent inside the blocked tool call
	// (the deny message of a permission prompt, the text of a denied
	// request_approval), so a refusal comes with direction, not silence.
	Note      string     `json:"note,omitempty" dynamodbav:"note,omitempty"`
	State     string     `json:"state" dynamodbav:"state"`
	Deadline  time.Time  `json:"deadline" dynamodbav:"deadline"`
	DecidedBy string     `json:"decidedBy,omitempty" dynamodbav:"decidedBy,omitempty"`
	DecidedAt *time.Time `json:"decidedAt,omitempty" dynamodbav:"decidedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt" dynamodbav:"createdAt"`
}

// Approval option bounds (ask_user).
const (
	ApprovalMaxOptions   = 5
	ApprovalOptionMaxLen = 120
)

// Artifact is a run-produced document too large or too durable for a chat
// message (plan-v2 §7). Content is stored inline (small, capped) — the
// drawer is the viewer; S3 offload arrives if artifacts outgrow this.
type Artifact struct {
	ID        string    `json:"id" dynamodbav:"id"`
	RunID     string    `json:"runID" dynamodbav:"runID"`
	AgentID   string    `json:"agentID" dynamodbav:"agentID"`
	InvokerID string    `json:"invokerID" dynamodbav:"invokerID"`
	Kind      string    `json:"kind" dynamodbav:"kind"` // freeform: "markdown", "diff", …
	Title     string    `json:"title" dynamodbav:"title"`
	Content   string    `json:"content,omitempty" dynamodbav:"content,omitempty"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
}

// Artifact bounds.
const (
	ArtifactMaxBytes = 64 * 1024
	ArtifactsPerRun  = 5
	// Raw API responses (auto-captured connector_call bodies) get their own,
	// larger budget — they exist so a human can audit what the agent actually
	// saw, and a research-y run makes a dozen calls.
	ArtifactKindAPIResponse    = "api_response"
	APIResponseArtifactsPerRun = 25
)

// Skill is a named instruction pack agents can pull in mid-run via
// invoke_skill (plan.md §2c, chat-scoped at this phase: a skill carries
// instructions, not extra tool grants — the tool surface is fixed and
// already bounded by the invoker's permissions).
type Skill struct {
	ID           string    `json:"id" dynamodbav:"id"`
	Name         string    `json:"name" dynamodbav:"name"`
	Description  string    `json:"description" dynamodbav:"description"`
	Instructions string    `json:"instructions" dynamodbav:"instructions"`
	CreatedBy    string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt    time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

// Skill bounds.
const (
	SkillNameMaxLen         = 64
	SkillDescriptionMaxLen  = 256
	SkillInstructionsMaxLen = 8 * 1024
)

// AgentMemory is one agent's self-maintained "core" memory FOR ONE INVOKER
// (buzz's engrams, scoped to our shared-agent model: a memory written while
// serving Alice must never leak into a bundle Bob's run reads — bundles are
// invoker-visible by contract). Injected into every bundle; replaced whole
// via the update_memory tool.
type AgentMemory struct {
	AgentID   string    `json:"agentID" dynamodbav:"agentID"`
	InvokerID string    `json:"invokerID" dynamodbav:"invokerID"`
	Content   string    `json:"content" dynamodbav:"content"`
	UpdatedAt time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

// AgentMemoryMaxBytes caps the core memory (buzz keeps ~10KB healthy).
const AgentMemoryMaxBytes = 8 * 1024

// AgentSubscription makes an agent WATCH a channel for its creator: human
// messages matching the filter invoke the agent un-mentioned, on the
// CREATOR's machine and quota (they opted in). HeartbeatMins > 0 adds
// periodic idle check-ins.
type AgentSubscription struct {
	ID         string `json:"id" dynamodbav:"id"`
	AgentID    string `json:"agentID" dynamodbav:"agentID"`
	CreatorID  string `json:"creatorID" dynamodbav:"creatorID"` // whose quota/machine
	ParentID   string `json:"parentID" dynamodbav:"parentID"`
	ParentType string `json:"parentType" dynamodbav:"parentType"`
	// Keywords: any-match (case-insensitive substring) triggers; empty means
	// every human message triggers. Kept deliberately simpler than buzz's
	// evalexpr filters — no expression engine to time-box.
	Keywords []string `json:"keywords,omitempty" dynamodbav:"keywords,omitempty"`
	// ThreadRootID scopes the watcher to ONE thread (the message it was
	// attached to). Empty = the whole channel/conversation. When set, only
	// messages in that thread trigger.
	ThreadRootID string `json:"threadRootID,omitempty" dynamodbav:"threadRootID,omitempty"`
	// Instruction is the creator's standing order — what to watch for and what
	// to do ("DM me if the budget comes up", "draft answers I'd give"). Injected
	// into the watch run's prompt. Empty = the agent's default watch behavior.
	Instruction string `json:"instruction,omitempty" dynamodbav:"instruction,omitempty"`
	// ActionMode caps what the watcher may DO on a trigger (WatchAction*). Empty
	// defaults to notify — the safest: DM the creator, never post publicly.
	ActionMode    string     `json:"actionMode,omitempty" dynamodbav:"actionMode,omitempty"`
	HeartbeatMins int        `json:"heartbeatMins,omitempty" dynamodbav:"heartbeatMins,omitempty"`
	LastRunAt     *time.Time `json:"lastRunAt,omitempty" dynamodbav:"lastRunAt,omitempty"`
	// PendingCatchUp marks triggers this watcher COULDN'T act on — creator
	// offline, or the agent already busy in the thread. Instead of one run
	// per missed message (overwhelming: 20 messages = 20 runs = 20 DMs) the
	// flag coalesces them: the reconcile sweep starts ONE catch-up run
	// covering everything since PendingSince, then clears it.
	PendingCatchUp bool       `json:"pendingCatchUp,omitempty" dynamodbav:"pendingCatchUp,omitempty"`
	PendingSince   *time.Time `json:"pendingSince,omitempty" dynamodbav:"pendingSince,omitempty"`
	// PendingOffline records that at least one missed trigger happened while
	// the creator was OFFLINE (vs merely agent-busy). Offline backlogs on a
	// local CLI harness are processed only with the creator's consent — the
	// sweep notifies instead of auto-running, and CatchUpNotifiedAt dedupes
	// that ask (re-armed when the flags clear). Busy-only backlogs auto-run.
	PendingOffline    bool       `json:"pendingOffline,omitempty" dynamodbav:"pendingOffline,omitempty"`
	CatchUpNotifiedAt *time.Time `json:"catchUpNotifiedAt,omitempty" dynamodbav:"catchUpNotifiedAt,omitempty"`
	CreatedAt         time.Time  `json:"createdAt" dynamodbav:"createdAt"`
}

// Watcher action modes — the safety dial, ascending in autonomy. Enforced
// server-side: notify/draft runs cannot post publicly (only DM the creator).
const (
	WatchActionNotify     = "notify"     // DM the creator only; never posts publicly
	WatchActionDraft      = "draft"      // DM the creator a ready-to-send reply; never posts
	WatchActionReply      = "reply"      // may post publicly, but must request_approval first
	WatchActionAutonomous = "autonomous" // may post publicly with no approval
)

// ValidWatchActionMode reports whether m is a known action mode.
func ValidWatchActionMode(m string) bool {
	switch m {
	case WatchActionNotify, WatchActionDraft, WatchActionReply, WatchActionAutonomous:
		return true
	}
	return false
}

// WatchModePostsPrivately reports whether a watcher in this mode is barred from
// posting publicly (notify/draft may only DM the creator).
func WatchModePostsPrivately(m string) bool {
	return m == WatchActionNotify || m == WatchActionDraft
}

// Run modes beyond plain mentions.
const (
	RunModeDirect    = "direct"
	RunModeWatch     = "watch"     // subscription-triggered
	RunModeHeartbeat = "heartbeat" // periodic idle check-in
	RunModeFollowUp  = "followup"  // un-tagged invoker reply in a followed thread
	RunModeTask      = "task"      // bound to a coding task (uncapped, workspace-backed)
)

// Task-mode budgets: "no limits" by decision. The horizon exists only so
// deadlines and run tokens stay finite; the idle reaper is what actually
// ends a stuck task. (taskModeHorizon stays unexported: tygo cannot mirror a
// time.Duration expression into the SPA's generated types.)
const (
	taskModeHorizon        = 30 * 24 * time.Hour
	TaskModeUnlimitedTurns = 1 << 30
)

// TaskModeHorizon returns the far ceiling used for task-mode runs.
func TaskModeHorizon() time.Duration { return taskModeHorizon }

// ModeUncapped reports whether a run mode is exempt from turn/token budgets.
func ModeUncapped(mode string) bool { return mode == RunModeTask }

// TaskClaim is one agent's atomic claim on a part of a co-invoked task
// ("hindi", "auth.go") — first write wins, so two agents invoked together
// can split work without racing. Scoped to a thread; rows carry a TTL.
type TaskClaim struct {
	ParentID     string    `json:"parentID" dynamodbav:"parentID"`
	ThreadRootID string    `json:"threadRootID" dynamodbav:"threadRootID"`
	Label        string    `json:"label" dynamodbav:"label"`
	AgentID      string    `json:"agentID" dynamodbav:"agentID"`
	InvokerID    string    `json:"invokerID" dynamodbav:"invokerID"`
	CreatedAt    time.Time `json:"createdAt" dynamodbav:"createdAt"`
}

// TaskClaimLabelMaxLen bounds claim labels.
const TaskClaimLabelMaxLen = 64

// AgentThreadFollow marks that an agent recently posted in a thread while
// serving an invoker. The invoker's later UN-TAGGED replies in that thread
// re-invoke the agent (per the invoker's follow-up prefs) — like a person
// who stays in a conversation they just spoke in. Distinct from the human
// notification ThreadFollow. Rows carry a TTL.
type AgentThreadFollow struct {
	ParentID     string    `json:"parentID" dynamodbav:"parentID"`
	ParentType   string    `json:"parentType" dynamodbav:"parentType"`
	ThreadRootID string    `json:"threadRootID" dynamodbav:"threadRootID"`
	AgentID      string    `json:"agentID" dynamodbav:"agentID"`
	InvokerID    string    `json:"invokerID" dynamodbav:"invokerID"`
	LastPostAt   time.Time `json:"lastPostAt" dynamodbav:"lastPostAt"`
}

// RunnerHarness is one detected CLI on a runner host.
type RunnerHarness struct {
	Name    string `json:"name" dynamodbav:"name"`
	Version string `json:"version,omitempty" dynamodbav:"version,omitempty"`
	Authed  bool   `json:"authed" dynamodbav:"authed"`
}

// RunnerRegistration is a live runner process on one of the owner's
// machines. Rows carry a DynamoDB TTL so dead runners self-reap.
type RunnerRegistration struct {
	RunnerID       string          `json:"runnerID" dynamodbav:"runnerID"`
	OwnerID        string          `json:"ownerID" dynamodbav:"ownerID"`
	Host           string          `json:"host" dynamodbav:"host"`
	OS             string          `json:"os" dynamodbav:"os"`
	Harnesses      []RunnerHarness `json:"harnesses" dynamodbav:"harnesses"`
	LeaseExpiresAt time.Time       `json:"leaseExpiresAt" dynamodbav:"leaseExpiresAt"`
	CreatedAt      time.Time       `json:"createdAt" dynamodbav:"createdAt"`
}
