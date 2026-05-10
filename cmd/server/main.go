package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	ex "github.com/DigitalTolk/ex"
	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/handler"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// wsOriginPatternsFromCORS converts the CORS allow-list (which holds
// scheme-qualified origins like "https://app.example.com" or
// "tauri://localhost") into host patterns suitable for
// websocket.AcceptOptions.OriginPatterns. The "*" sentinel is
// preserved so downstream callers can opt back into dev wildcard mode.
func wsOriginPatternsFromCORS(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, raw := range origins {
		if raw == "*" {
			return []string{"*"}
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			continue
		}
		out = append(out, u.Hostname())
	}
	return out
}

func main() {
	ctx := context.Background()

	// ------------------------------------------------------------------ Config
	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// ------------------------------------------------------------------ DynamoDB
	db, err := store.New(ctx, store.DBConfig{
		Region:   cfg.AWSRegion,
		Endpoint: cfg.DynamoDBEndpoint,
		Table:    cfg.DynamoDBTable,
	})
	if err != nil {
		slog.Error("failed to init DynamoDB", "error", err)
		os.Exit(1)
	}

	if cfg.IsDev() {
		if err := db.EnsureTable(ctx); err != nil {
			slog.Error("failed to ensure DynamoDB table", "error", err)
			os.Exit(1)
		}
	}

	// ------------------------------------------------------------------ Redis (cache)
	redisCache, err := cache.NewRedisCache(cfg.RedisURL)
	if err != nil {
		slog.Error("failed to init Redis cache", "error", err)
		os.Exit(1)
	}

	// ------------------------------------------------------------------ Redis (pub/sub)
	redisPubSub, err := pubsub.NewRedisPubSub(cfg.RedisURL)
	if err != nil {
		slog.Error("failed to init Redis pub/sub", "error", err)
		os.Exit(1)
	}

	// ------------------------------------------------------------------ Stores (with adapters to bridge store/service interfaces)
	userStore := handler.NewUserStoreAdapter(store.NewUserStore(db))
	channelStore := handler.NewChannelStoreAdapter(store.NewChannelStore(db))
	membershipStore := handler.NewMembershipStoreAdapter(store.NewMembershipStore(db))
	conversationStore := handler.NewConversationStoreAdapter(store.NewConversationStore(db))
	messageStore := handler.NewMessageStoreAdapter(store.NewMessageStore(db))
	threadFollowStore := handler.NewThreadFollowStoreAdapter(store.NewThreadFollowStore(db))
	parentIndexStore := handler.NewParentIndexAdapter(store.NewParentIndexStore(db))
	userStateStore := handler.NewUserStateStoreAdapter(store.NewUserStateStore(db))
	inviteStore := handler.NewInviteStoreAdapter(store.NewInviteStore(db))
	tokenStore := handler.NewTokenStoreAdapter(store.NewTokenStore(db))
	emojiStore := store.NewEmojiStore(db)
	attachmentStore := store.NewAttachmentStore(db)

	// ------------------------------------------------------------------ Auth
	jwtMgr := auth.NewJWTManager(cfg.JWTSecret, cfg.JWTAccessTTL, cfg.JWTRefreshTTL)

	var oidcAdapter service.OIDCProvider
	if cfg.OIDCIssuer != "" {
		var oidcProvider *auth.OIDCProvider
		oidcProvider, err = auth.NewOIDCProvider(ctx, cfg.OIDCIssuer, cfg.OIDCClientID, cfg.OIDCClientSecret, cfg.OIDCRedirectURL())
		if err != nil {
			slog.Error("failed to init OIDC provider", "error", err)
			os.Exit(1)
		}
		oidcAdapter = handler.NewOIDCAdapter(oidcProvider)
	}

	// ------------------------------------------------------------------ S3 (avatars)
	// Init when ANY S3 setting is in play: a custom endpoint (minio in
	// dev), an explicit access key (CI / static creds), or just a
	// bucket name (the AWS-prod path with role-based credentials, where
	// neither endpoint nor static keys are set).
	var s3Client *storage.S3Client
	if cfg.S3Endpoint != "" || cfg.S3AccessKey != "" || cfg.S3Bucket != "" {
		s3Client, err = storage.NewS3Client(ctx, storage.S3Config{
			Endpoint:       cfg.S3Endpoint,
			PublicEndpoint: cfg.S3PublicEndpoint,
			Bucket:         cfg.S3Bucket,
			AccessKey:      cfg.S3AccessKey,
			SecretKey:      cfg.S3SecretKey,
			Region:         cfg.S3Region,
		})
		if err != nil {
			slog.Warn("S3 not available, avatar uploads disabled", "error", err)
			s3Client = nil
		}
	}

	// ------------------------------------------------------------------ Broker
	broker := pubsub.NewBroker(redisPubSub)
	defer func() { _ = broker.Close() }()

	// ------------------------------------------------------------------ Services
	brokerAdapter := handler.NewBrokerAdapter(broker)
	authSvc := service.NewAuthService(userStore, tokenStore, inviteStore, membershipStore, channelStore, jwtMgr, oidcAdapter, redisCache)
	var avatarSigner service.AvatarSigner
	if s3Client != nil {
		avatarSigner = s3Client
	}
	userSvc := service.NewUserService(userStore, redisCache, avatarSigner, redisPubSub)
	userSvc.SetMediaURLCache(redisCache)
	userSvc.SetTokenStore(tokenStore)
	channelSvc := service.NewChannelService(channelStore, membershipStore, userStore, messageStore, redisCache, brokerAdapter, redisPubSub)
	authSvc.SetChannelJoiner(channelSvc)
	convSvc := service.NewConversationService(conversationStore, userStore, redisCache, brokerAdapter, redisPubSub)
	convSvc.SetMediaURLCache(redisCache)
	convSvc.SetUserProfileResolver(userSvc)
	messageSvc := service.NewMessageService(messageStore, membershipStore, conversationStore, redisPubSub, brokerAdapter)
	messageSvc.SetThreadFollowStore(threadFollowStore)
	messageSvc.SetUserStateStore(userStateStore)
	messageSvc.SetParentIndex(parentIndexStore)
	messageSvc.SetActivator(convSvc)
	messageSvc.SetConversationUnreadTracker(convSvc)
	userStateSvc := service.NewUserStateService(userStateStore, redisPubSub)
	emojiSvc := service.NewEmojiService(emojiStore, userStore, redisPubSub)
	if s3Client != nil {
		emojiSvc.SetSigner(s3Client)
	}
	emojiSvc.SetMediaURLCache(redisCache)
	presenceSvc := service.NewPresenceService(redisCache, redisPubSub)
	var attachmentSigner service.AttachmentSigner
	if s3Client != nil {
		attachmentSigner = s3Client
	}
	attachmentSvc := service.NewAttachmentService(attachmentStore, attachmentSigner, redisPubSub)
	attachmentSvc.SetMediaURLCache(redisCache)
	attachmentSvc.SetAccessChecker(messageSvc)
	messageSvc.SetAttachmentManager(attachmentSvc)
	notificationSvc := service.NewNotificationService(redisPubSub, membershipStore, conversationStore, channelStore, userStore, messageStore)
	notificationSvc.SetPresence(presenceSvc)
	notificationSvc.SetThreadFollowStore(threadFollowStore)
	notificationSvc.SetUserStateService(userStateSvc)
	oneSignalPush, err := service.NewOneSignalPushSender(service.OneSignalConfig{
		AppID:     cfg.OneSignalAppID,
		APIKey:    cfg.OneSignalRESTAPIKey,
		PublicURL: cfg.BaseURL,
	})
	if err != nil {
		slog.Warn("OneSignal mobile push disabled", "error", err)
	} else if oneSignalPush != nil {
		asyncOneSignalPush := service.NewAsyncMobilePushSender(oneSignalPush, 0, 0)
		defer asyncOneSignalPush.Close()
		notificationSvc.SetMobilePushSender(asyncOneSignalPush)
	}
	messageSvc.SetNotifier(notificationSvc)
	settingsSvc := service.NewSettingsService(store.NewSettingsStore(db))
	attachmentSvc.SetUploadLimits(settingsSvc)

	// ------------------------------------------------------------------ Handlers
	authH := handler.NewAuthHandler(authSvc, jwtMgr)
	userH := handler.NewUserHandler(userSvc, s3Client)
	userStateH := handler.NewUserStateHandler(userStateSvc, messageSvc, convSvc)
	channelH := handler.NewChannelHandler(channelSvc, messageSvc)
	convH := handler.NewConversationHandler(convSvc, messageSvc)
	wsH := handler.NewWSHandler(broker, channelSvc, convSvc, presenceSvc)
	wsH.SetPublisher(redisPubSub)
	wsH.SetUserService(userSvc)
	uploadH := handler.NewUploadHandler(s3Client)
	emojiH := handler.NewEmojiHandler(emojiSvc)
	presenceH := handler.NewPresenceHandler(presenceSvc)
	attachmentH := handler.NewAttachmentHandler(attachmentSvc)
	adminH := handler.NewAdminHandler(settingsSvc)
	threadH := handler.NewThreadHandler(messageSvc)
	draftSvc := service.NewDraftService(store.NewDraftStore(db), messageStore, membershipStore, conversationStore, redisPubSub)
	draftH := handler.NewDraftHandler(draftSvc)
	categorySvc := service.NewCategoryService(store.NewCategoryStore(db), redisPubSub)
	sidebarH := handler.NewSidebarHandler(channelSvc, convSvc, categorySvc)

	// ------------------------------------------------------------------ Search
	// NewClient returns nil for an empty URL; downstream wiring degrades
	// to no-ops when the search package isn't configured. Setting
	// OPENSEARCH_AWS_REGION switches to a SigV4-signing client backed by
	// the SDK's default credential chain — that's the IAM-role path on
	// AWS-hosted deployments (managed OpenSearch / Serverless).
	var searchClient *search.Client
	if cfg.OpenSearchAWSRegion != "" {
		searchClient, err = search.NewAWSClient(ctx, cfg.OpenSearchURL, search.AWSSigning{
			Region:  cfg.OpenSearchAWSRegion,
			Service: cfg.OpenSearchAWSService,
		})
		if err != nil {
			slog.Error("failed to init AWS-signed OpenSearch client", "error", err)
			os.Exit(1)
		}
	} else {
		searchClient = search.NewClient(cfg.OpenSearchURL)
	}
	if searchClient != nil {
		if err := searchClient.EnsureIndices(ctx); err != nil {
			slog.Warn("search: ensure indices failed", "error", err)
		}
	}
	reindexSrc := newReindexSources(userStore, channelStore, conversationStore, messageStore)
	searchReindexer := search.NewReindexer(searchClient, reindexSrc)
	if searchClient != nil && searchReindexer != nil {
		searchReindexer.SetAttachmentResolver(newAttachmentResolver(attachmentStore))
		adminH.SetSearch(searchClient, searchReindexer)
	}
	if searchClient != nil {
		idx := search.NewIndexer(searchClient)
		if live, ok := idx.(*search.LiveIndexer); ok {
			live.SetAttachmentResolver(newAttachmentResolver(attachmentStore))
		}
		messageSvc.SetIndexer(idx)
		channelSvc.SetIndexer(idx)
		userSvc.SetIndexer(idx)
		authSvc.SetIndexer(idx)
	}
	searcher := search.NewService(searchClient)
	searchAccess := newSearchAccess(membershipStore, conversationStore)
	searchH := handler.NewSearchHandler(searcher, searchAccess)
	if searchClient != nil {
		ids := newIDSearcher(searcher)
		userSvc.SetSearcher(ids)
		channelSvc.SetSearcher(ids)
	}

	// ------------------------------------------------------------------ Frontend FS
	var frontendDist fs.FS
	frontendDist, err = fs.Sub(ex.FrontendFS, "frontend/dist")
	if err != nil {
		slog.Warn("frontend assets not embedded, SPA disabled", "error", err)
		frontendDist = nil
	}

	// Derived from the embedded index.html so a rebuild changes the
	// version automatically — no ldflags or env vars to wire up.
	appVersion := handler.AppVersion(frontendDist)
	versionH := handler.NewVersionHandler(appVersion)
	wsH.SetVersion(appVersion)
	// Mirror the HTTP CORS allow-list onto the WebSocket Origin check
	// (host-only patterns). Without this the upgrade would fail closed
	// to same-origin in production, breaking the Tauri/Capacitor mobile
	// shells that legitimately load from non-HTTP origins.

	// ------------------------------------------------------------------ Router
	allowOrigins := []string{"*"}
	if !cfg.IsDev() {
		allowOrigins = []string{
			cfg.BaseURL,
			"tauri://localhost",
			"capacitor://localhost",
			"http://localhost",
		}
	}
	wsH.SetOriginPolicy(wsOriginPatternsFromCORS(allowOrigins))
	unfurlSvc := service.NewUnfurlService(redisCache)
	if s3Client != nil {
		// Proxy preview images through S3 (folder `unfurl/`) so viewers
		// don't hit upstream origins directly. S3 lifecycle rule should
		// expire `unfurl/` keys after ~30 days (configured in IaC).
		unfurlSvc.SetImageStore(s3Client)
	}
	unfurlSvc.SetMediaURLCache(redisCache)
	unfurlH := handler.NewUnfurlHandler(unfurlSvc)
	router := handler.NewRouter(&handler.Deps{
		Auth:         authH,
		User:         userH,
		UserState:    userStateH,
		Channel:      channelH,
		Conversation: convH,
		WS:           wsH,
		Upload:       uploadH,
		Emoji:        emojiH,
		Presence:     presenceH,
		Attachment:   attachmentH,
		Admin:        adminH,
		Thread:       threadH,
		Draft:        draftH,
		Version:      versionH,
		Unfurl:       unfurlH,
		Sidebar:      sidebarH,
		Search:       searchH,
		JWT:          jwtMgr,
		FrontendFS:   frontendDist,
		AppVersion:   appVersion,
		AllowOrigins: allowOrigins,
	})

	// ------------------------------------------------------------------ Server
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	backgroundCtx, stopBackground := context.WithCancel(context.Background())
	defer stopBackground()
	go userSvc.RunExpiredStatusSweeper(backgroundCtx, time.Minute, 0)

	// Start in a goroutine so we can listen for shutdown signals.
	go func() {
		slog.Info("server starting",
			"port", cfg.Port,
			"env", cfg.Env,
			"table", cfg.DynamoDBTable,
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	// ------------------------------------------------------------------ Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	slog.Info("shutting down", "signal", sig.String())
	stopBackground()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("server forced to shutdown", "error", err)
		os.Exit(1)
	}

	slog.Info("server stopped")
}
