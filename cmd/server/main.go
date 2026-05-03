package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
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
	messageSvc := service.NewMessageService(messageStore, membershipStore, conversationStore, redisPubSub, brokerAdapter)
	messageSvc.SetThreadFollowStore(threadFollowStore)
	messageSvc.SetActivator(convSvc)
	emojiSvc := service.NewEmojiService(emojiStore, userStore, redisPubSub)
	if s3Client != nil {
		emojiSvc.SetSigner(s3Client)
	}
	emojiSvc.SetMediaURLCache(redisCache)
	presenceSvc := service.NewPresenceService(broker, redisPubSub)
	var attachmentSigner service.AttachmentSigner
	if s3Client != nil {
		attachmentSigner = s3Client
	}
	attachmentSvc := service.NewAttachmentService(attachmentStore, attachmentSigner, redisPubSub)
	attachmentSvc.SetMediaURLCache(redisCache)
	messageSvc.SetAttachmentManager(attachmentSvc)
	notificationSvc := service.NewNotificationService(redisPubSub, membershipStore, conversationStore, channelStore, userStore, messageStore)
	notificationSvc.SetPresence(presenceSvc)
	notificationSvc.SetThreadFollowStore(threadFollowStore)
	messageSvc.SetNotifier(notificationSvc)
	settingsSvc := service.NewSettingsService(store.NewSettingsStore(db))
	attachmentSvc.SetUploadLimits(settingsSvc)

	// ------------------------------------------------------------------ Handlers
	authH := handler.NewAuthHandler(authSvc, jwtMgr)
	userH := handler.NewUserHandler(userSvc, s3Client)
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

	// ------------------------------------------------------------------ Router
	allowOrigins := []string{"*"}
	if !cfg.IsDev() {
		allowOrigins = []string{cfg.BaseURL, "tauri://localhost"}
	}
	unfurlSvc := service.NewUnfurlService(redisCache)
	if s3Client != nil {
		// Proxy preview images through S3 (folder `unfurl/`) so viewers
		// don't hit upstream origins directly. S3 lifecycle rule should
		// expire `unfurl/` keys after ~30 days (configured in IaC).
		unfurlSvc.SetImageStore(s3Client)
	}
	unfurlSvc.SetMediaURLCache(redisCache)
	unfurlH := handler.NewUnfurlHandler(unfurlSvc)
	router := handler.NewRouter(authH, userH, channelH, convH, wsH, uploadH, emojiH, presenceH, attachmentH, adminH, threadH, draftH, versionH, unfurlH, sidebarH, searchH, jwtMgr, frontendDist, appVersion, allowOrigins)

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
