package app

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/handler"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// httpLayer is the HTTP surface: the handlers that take setter-injected
// collaborators (so the wiring check can see them) and the server.
type httpLayer struct {
	ws          *handler.WSHandler
	presence    *handler.PresenceHandler
	userState   *handler.UserStateHandler
	runnerToken *handler.RunnerTokenHandler
	agent       *handler.AgentHandler
	agentRun    *handler.AgentRunToolHandler
	unfurl      *handler.UnfurlHandler
	sidebar     *handler.SidebarHandler
	server      *http.Server
}

func (a *App) buildHTTP(context.Context) error {
	cfg, in, c, ag, s, h := a.cfg, &a.infra, &a.chat, &a.agents, &a.search, &a.http

	// ------------------------------------------------------------- Agents
	// The Runners list joins each paired install with its live runner.
	h.runnerToken = handler.NewRunnerTokenHandler(ag.runnerTokens)
	h.runnerToken.SetLiveRunners(ag.svc)
	h.agent = handler.NewAgentHandler(ag.svc, ag.orch, c.users)
	// The Run Activity Drawer is readable by anyone who can read the channel
	// the run happened in, not just the invoker.
	h.agent.SetTimelineAccess(c.messages)
	h.agent.SetRunFiles(c.attachments)
	h.agentRun = handler.NewAgentRunToolHandler(ag.orch, c.messages, ag.context, ag.svc)
	h.agentRun.SetBaseURL(cfg.BaseURL)
	h.agentRun.SetAttachments(c.attachments)
	// Ex-wide agent tools (channels, DMs, search, reactions) — every check
	// runs against the INVOKER's access, never the agent's.
	h.agentRun.SetWorkspace(handler.AgentWorkspaceDeps{
		Channels:      c.channels,
		Conversations: c.conversations,
		Searcher:      s.searcher,
		SearchAccess:  s.access,
		Reminders:     c.reminders,
	})

	// ------------------------------------------------------------- Chat
	h.userState = handler.NewUserStateHandler(c.userState, c.messages, c.conversations)
	h.userState.SetSkillLookup(ag.svc)
	h.ws = handler.NewWSHandler(in.broker, c.channels, c.conversations, c.presence)
	h.ws.SetNotificationAckRecorder(in.cache)
	// One-time upgrade tickets: the browser can't send an Authorization
	// header on a WebSocket, and the old ?token= fallback leaked the JWT into
	// URL logs. Redis-backed so any instance can redeem a ticket.
	h.ws.SetTicketStore(in.cache)
	h.ws.SetPublisher(in.pubsub)
	h.ws.SetUserService(c.users)
	h.ws.SetReplayer(in.inbox)
	h.presence = handler.NewPresenceHandler(c.presence)
	// Shared agents always read as online — they're services, not sockets.
	h.presence.SetAlwaysOnline(alwaysOnlineAgents(ag.svc))
	admin := handler.NewAdminHandler(c.settings)
	// Mail diagnostics: an admin can read the effective transport and send a
	// real test message through it.
	admin.SetMailer(c.mailer, cfg.EmailProvider, cfg.EmailFrom)
	if s.client != nil {
		admin.SetSearch(s.client, s.reindexer)
		admin.SetMappingRebuilder(s.mappingRebuilder)
	}
	h.sidebar = handler.NewSidebarHandler(c.channels, c.conversations, c.categories)
	h.sidebar.SetSidebarService(c.sidebar)

	// ------------------------------------------------------------- Frontend
	frontendDist := frontendDist(a.frontend)
	// Derived from the embedded index.html so a rebuild changes the version
	// automatically — no ldflags or env vars to wire up.
	appVersion := handler.AppVersion(frontendDist)
	h.ws.SetVersion(appVersion)

	// ------------------------------------------------------------- Router
	allowOrigins := corsOrigins(cfg)
	// Mirror the HTTP CORS allow-list onto the WebSocket Origin check
	// (host-only patterns). Without this the upgrade would fail closed to
	// same-origin in production, breaking the Tauri/Capacitor mobile shells
	// that legitimately load from non-HTTP origins.
	h.ws.SetOriginPolicy(wsOriginPatternsFromCORS(allowOrigins))
	h.unfurl = handler.NewUnfurlHandler(c.unfurl)
	h.unfurl.SetMessageLinks(c.messageLinks)
	router := handler.NewRouter(&handler.Deps{
		Auth:         handler.NewAuthHandler(c.auth, in.jwt),
		User:         handler.NewUserHandler(c.users, in.s3),
		UserState:    h.userState,
		Channel:      handler.NewChannelHandler(c.channels, c.messages),
		Conversation: handler.NewConversationHandler(c.conversations, c.messages),
		WS:           h.ws,
		Upload:       handler.NewUploadHandler(in.s3),
		Emoji:        handler.NewEmojiHandler(c.emoji),
		Presence:     h.presence,
		Attachment:   handler.NewAttachmentHandler(c.attachments),
		Admin:        admin,
		Thread:       handler.NewThreadHandler(c.messages),
		Draft:        handler.NewDraftHandler(c.drafts),
		Version:      handler.NewVersionHandler(appVersion),
		Unfurl:       h.unfurl,
		Sidebar:      h.sidebar,
		// Ghost filtering: hits are verified against the canonical stores so
		// a user/channel deleted straight from DynamoDB (nothing de-indexed
		// it) never surfaces from a stale index. The user resolver is the
		// CACHE-FIRST service — not the raw store — so per-keystroke
		// autocomplete stays off DynamoDB for warm IDs.
		Search:       handler.NewSearchHandler(s.searcher, s.access, c.users, c.channels),
		Webhook:      handler.NewWebhookHandler(c.webhooks),
		Activity:     handler.NewActivityHandler(c.activity, c.reminders),
		Command:      handler.NewCommandHandler(c.commands),
		Agent:        h.agent,
		AgentRunner:  handler.NewAgentRunnerHandler(ag.svc, ag.orch),
		RunnerToken:  h.runnerToken,
		AgentRunTool: h.agentRun,
		Context:      handler.NewContextHandler(ag.context),
		Connector:    handler.NewConnectorHandler(ag.connectors, ag.orch),
		CodingTask:   handler.NewCodingTaskHandler(ag.codingTasks, ag.orch),
		Project:      handler.NewProjectHandler(ag.projects),
		JWT:          in.jwt,
		FrontendFS:   frontendDist,
		AppVersion:   appVersion,
		// Frontend-only Sentry opt-in — served to every UI surface via meta tags.
		SentryFrontend: handler.SentryFrontendConfig{
			DSN:                     cfg.SentryFrontendDSN,
			TracesSampleRate:        cfg.SentryFrontendTracesSampleRate,
			ReplaySessionSampleRate: cfg.SentryFrontendReplaySessionSampleRate,
			ReplayErrorSampleRate:   cfg.SentryFrontendReplayErrorSampleRate,
		},
		AllowOrigins: allowOrigins,
		BaseURL:      cfg.BaseURL,
		// The browser PUTs presigned uploads straight at the storage
		// endpoint; a plain-http endpoint (local MinIO) must be CSP
		// allow-listed or every upload dies with "Failed to fetch".
		UploadConnectSrc: uploadConnectSrcOrigins(cfg.S3PublicEndpoint, cfg.S3Endpoint),
		RateLimiter:      middleware.NewRedisRateLimiter(in.cache.Client()),
		// ACCESS_LOG_ENABLED=false → only 5xx requests reach the log.
		DisableAccessLog: !cfg.AccessLogEnabled,
		// Scheduled messages: compose now, deliver at a chosen time.
		ScheduledMessage: handler.NewScheduledMessageHandler(c.scheduled),
	})

	// ------------------------------------------------------------- Server
	h.server = &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	a.drainWS = h.ws.Drain
	a.waitNotifyFanOut = c.messages.WaitForNotifyFanOut
	a.waitInboxFanOut = in.pubsub.WaitForInboxFanOut
	return nil
}

// frontendDist is the SPA inside the embedded build output; nil (SPA
// disabled) when it is not there.
func frontendDist(fsys fs.FS) fs.FS {
	dist, err := fs.Sub(fsys, "dist")
	if err != nil {
		slog.Warn("frontend assets not embedded, SPA disabled", "error", err)
		return nil
	}
	return dist
}

// corsOrigins is the HTTP CORS allow-list: any origin in development, else
// the app's own origin and the native shells' (Tauri/Capacitor) origins.
func corsOrigins(cfg *config.Config) []string {
	if cfg.IsDev() {
		return []string{"*"}
	}
	return []string{
		cfg.BaseURL,
		"tauri://localhost",
		"capacitor://localhost",
		"http://localhost",
	}
}
