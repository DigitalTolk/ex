// Package agents is the agent subsystem: agents-as-users and their templates,
// skills and standing orders (AgentService), the run orchestrator with its
// approval gates, cross-instance turn coordination and coding-task layer,
// runner pairing tokens, shared channel context, connectors (API docs bundles
// plus per-user credentials, synced from the connector provider), server-side
// Bedrock execution (ServerEngine) and projects.
//
// It builds on the chat core in internal/service — posting, reading and
// access checks go through the service layer's exported API and narrow
// interfaces — and never the other way round: internal/service does not import
// this package; it reaches agents only through interfaces it defines
// (AgentDispatcher, RunLogPurger, AutomationStopper, RunnerRevoker, …), wired
// in internal/app.
package agents
