package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/handler"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// chat is the messaging core: accounts, channels, conversations, messages
// and everything around them (media, drafts, activity, reminders, …).
type chat struct {
	// mailer is nil when no transport is configured (links relayed by hand).
	mailer email.Sender

	auth          *service.AuthService
	users         *service.UserService
	channels      *service.ChannelService
	conversations *service.ConversationService
	messages      *service.MessageService
	mentions      *service.MentionDirectory
	userState     *service.UserStateService
	emoji         *service.EmojiService
	presence      *service.PresenceService
	attachments   *service.AttachmentService
	settings      *service.SettingsService
	unfurl        *service.UnfurlService
	webhooks      *service.IncomingWebhookService
	bots          *service.BotService
	userGroups    *service.UserGroupService
	mattermost    *service.MattermostService
	commands      *service.CommandService
	// directorySync is nil without the Microsoft 365 integration.
	directorySync *service.DirectorySyncService
	drafts        *service.DraftService
	activity      *service.ActivityService
	reminders     *service.ReminderService
	scheduled     *service.ScheduledMessageService
	categories    *service.CategoryService
	sidebar       *service.SidebarService
	messageLinks  *service.MessageLinkService
}

// userGroupCopyTTL bounds how long a user group's Redis copy can lag a
// change: every committed change deletes it, and this caps a copy a reader
// stored just after that delete (or a delete that failed).
const userGroupCopyTTL = 5 * time.Minute

// newGraphClient is a seam over the Microsoft Graph constructor: the
// configuration exposes no endpoint overrides, so tests point the client at a
// local server through it.
var newGraphClient = msgraph.New

// memberCopyTTL bounds a channel's shared member copy (service.CachedMemberships)
// for a generation move that was lost: the copy is otherwise valid until the
// channel's next membership change. The same window as the notification
// audience's backstop.
const memberCopyTTL = 5 * time.Minute

func (a *App) buildChat(ctx context.Context) error {
	cfg, in, c := a.cfg, &a.infra, &a.chat
	broker := handler.NewBrokerAdapter(in.broker)

	// ------------------------------------------------------------- Accounts
	c.auth = service.NewAuthService(in.users, in.tokens, in.invites, in.memberships, in.channels, in.jwt, in.oidc, in.cache)
	// Redis backs single-use password-reset tickets (guest accounts only).
	c.auth.SetPasswordResetStore(in.cache)
	mailer, err := buildMailer(ctx, cfg)
	if err != nil {
		return err
	}
	c.mailer = mailer
	c.auth.SetMailer(mailer, cfg.BaseURL)
	c.auth.SetGuestLoginAnyRole(cfg.GuestLoginAnyRole)
	c.auth.SetSessionMaxAge(cfg.SessionMaxAge)
	c.auth.SetAllowedEmailDomains(cfg.OIDCAllowedEmailDomains)
	var avatarSigner service.AvatarSigner
	if in.s3 != nil {
		avatarSigner = in.s3
	}
	c.users = service.NewUserService(in.users, in.cache, avatarSigner, in.pubsub)
	c.users.SetMediaURLCache(in.cache)
	c.users.SetTokenStore(in.tokens)
	if in.s3 != nil {
		c.users.SetAvatarObjects(in.s3)
	}

	// ------------------------------------------------------------- Channels + conversations
	// Member lists and membership checks — the access check behind nearly
	// every request — read a shared copy that stays valid while the channel's
	// audience generation holds (every membership write moves it).
	members := service.NewCachedMemberships(in.memberships, cache.NewMemberLists(in.cache.Client(), memberCopyTTL))
	c.channels = service.NewChannelService(in.channels, members, in.users, in.messages, in.cache, broker, in.pubsub)
	c.channels.SetDeactivatedAccounts(c.users)
	c.auth.SetChannelJoiner(c.channels)
	c.conversations = service.NewConversationService(in.conversations, in.users, in.cache, broker, in.pubsub)
	c.conversations.SetMediaURLCache(in.cache)
	c.conversations.SetUserProfileResolver(c.users)
	// A group that became a private channel is read through that channel's
	// membership, never its frozen participant list.
	c.conversations.SetChannelMemberships(members)

	// ------------------------------------------------------------- Messages
	c.messages = service.NewMessageServiceFromDeps(service.MessageServiceDeps{
		Messages:      in.messages,
		Memberships:   members,
		Conversations: in.conversations,
		Publisher:     in.pubsub,
		Broker:        broker,
		// Unread is tracked with one seq counter per parent (channel or
		// conversation). The counter lives on the parent store; the per-user
		// last-read on the membership store for channels and the conversation
		// store for conversations — UnreadSeqAdapter binds the two halves.
		ChannelSeq:      handler.NewUnreadSeqAdapter(in.channels.IncrementMessageSeq, in.channels.CurrentMessageSeq, in.memberships.SetChannelLastRead),
		ConversationSeq: handler.NewUnreadSeqAdapter(in.conversations.IncrementMessageSeq, in.conversations.CurrentMessageSeq, in.conversations.SetConversationLastRead),
		ThreadFollows:   in.threadFollows,
		UserState:       in.userState,
		ParentIndex:     in.parentIndex,
		Markdown:        service.NewMarkdownRenderer(),
		Activator:       c.conversations,
		Channels:        in.channels,
	})
	// Mention pills render the CURRENT name/slug of the ID they carry, never
	// the text the poster typed beside it (one cached batch read per render).
	c.mentions = service.NewMentionDirectory(c.users, in.channels)
	c.messages.SetMentionResolver(c.mentions)
	c.messages.SetDeactivatedAccounts(c.users)

	c.userState = service.NewUserStateService(in.userState, in.pubsub)

	// ------------------------------------------------------------- Media
	c.emoji = service.NewEmojiService(in.emojis, in.users, in.pubsub)
	if in.s3 != nil {
		c.emoji.SetSigner(in.s3)
	}
	c.emoji.SetMediaURLCache(in.cache)
	c.emoji.SetFrequencyStore(in.cache)
	c.emoji.SetCatalogCache(in.cache)

	// ------------------------------------------------------------- Presence
	c.presence = service.NewPresenceService(in.cache, in.pubsub)
	// Scope presence changes to the channels and DMs the subject belongs to,
	// so a connect/disconnect fans out only to people who share a context
	// with them rather than to every connected client.
	c.presence.SetPresenceAudienceResolver(presenceAudience(c.channels, c.conversations))

	var attachmentSigner service.AttachmentSigner
	if in.s3 != nil {
		attachmentSigner = in.s3
	}
	c.attachments = service.NewAttachmentService(in.attachments, attachmentSigner, in.pubsub)
	c.attachments.SetMediaURLCache(in.cache)
	c.attachments.SetAccessChecker(c.messages)
	// Every instance must verify the media grants every other one signed.
	c.attachments.SetMediaGrantKey([]byte(cfg.JWTSecret))
	c.messages.SetAttachmentManager(c.attachments)

	c.settings = service.NewSettingsService(store.NewSettingsStore(in.db))
	c.settings.SetPublisher(in.pubsub)
	c.attachments.SetUploadLimits(c.settings)
	c.unfurl = service.NewUnfurlService(in.cache)
	if in.s3 != nil {
		// Proxy preview images through S3 (folder `unfurl/`) so viewers
		// don't hit upstream origins directly. S3 lifecycle rule should
		// expire `unfurl/` keys after ~30 days (configured in IaC).
		c.unfurl.SetImageStore(in.s3)
	}
	c.unfurl.SetMediaURLCache(in.cache)

	// ------------------------------------------------------------- Webhooks
	c.webhooks = service.NewIncomingWebhookService(store.NewIncomingWebhookStore(in.db), c.channels, c.messages, c.unfurl, cfg.BaseURL)
	c.webhooks.SetDMResolver(c.conversations)
	c.webhooks.SetUserResolver(c.users)
	c.webhooks.SetBotProvisioner(c.users)
	c.webhooks.SetMembershipResolver(members)
	c.webhooks.SetPublisher(in.pubsub)

	// ------------------------------------------------------------- Bots + the Mattermost-compatible API
	// Admins manage bot accounts and their tokens; an integration written
	// against Mattermost's REST API acts as a bot with one, through the same
	// services the app uses (the webhooks' Mattermost markup translation
	// included).
	botStore := store.NewBotStore(in.db)
	c.bots = service.NewBotService(botStore, in.users, c.users, in.cache, in.pubsub)

	// ------------------------------------------------------------- User groups
	// "@oncall" pings every member who can see the message, as a direct
	// @-mention: typed handles become group mentions on send, the fan-out
	// expands them, pills and alert text show the current handle, and a
	// demotion to guest leaves every group.
	c.userGroups = service.NewUserGroupService(store.NewUserGroupStore(in.db), c.users, botStore, in.pubsub)
	// A group mention reads the group from Redis; the store stays the source.
	c.userGroups.SetCopies(cache.NewUserGroupCopies(in.cache.Client(), userGroupCopyTTL))
	c.messages.SetUserGroups(c.userGroups)
	c.mentions.SetUserGroups(c.userGroups)
	c.users.SetUserGroups(c.userGroups)
	c.mattermost = service.NewMattermostService(c.channels, members, in.users, c.messages, c.conversations, c.webhooks)

	// ------------------------------------------------------------- Microsoft 365 (Graph)
	// App-only Graph client keyed to the same Azure AD app registration the
	// workspace signs in through — no per-user account linking. Enables
	// login-time profile enrichment (phone + manager) and /mstmeetings.
	c.commands = service.NewCommandService()
	graph, err := newGraphClient(msgraph.Config{
		TenantID:     cfg.MSTenantID,
		ClientID:     cfg.MSClientID,
		ClientSecret: cfg.MSClientSecret,
	})
	if err != nil {
		return fmt.Errorf("failed to init Microsoft Graph client: %w", err)
	}
	if graph != nil {
		directory := service.NewMSDirectoryService(graph, in.users)
		c.auth.SetDirectory(directory)
		c.auth.SetPublisher(in.pubsub)
		// Periodic re-sync: Entra edits (new manager, changed number) must
		// propagate without waiting for each owner's next login. Redis-lock
		// elected, so a cluster sweeps once per window; started with the
		// other background jobs.
		c.directorySync = service.NewDirectorySyncService(directory, in.users, in.cache, in.pubsub, in.cache, store.NewID)
		// Offboarding: an account disabled or deleted in Entra is
		// deactivated (sessions ended) by the next status sweep, minutes
		// later, and reactivated once it can sign in again.
		c.directorySync.SetStatusSync(directory, c.users)
		// User groups linked to Microsoft 365: members synced from Entra by
		// the same status sweep; a sign-in records its user for the next sync.
		c.userGroups.SetMicrosoft(service.UserGroupMicrosoftDeps{
			Directory: service.NewMSGroupDirectory(graph),
			Index:     cache.NewEntraUserIndex(in.cache.Client()),
			Accounts:  in.users,
			Locker:    in.cache,
			Cache:     in.cache,
			IndexTTL:  3 * cfg.MSStatusSyncInterval,
			NewToken:  store.NewID,
		})
		c.directorySync.SetUserGroupSync(c.userGroups)
		c.auth.SetEntraUserNoter(c.userGroups)
		c.commands.Register(service.NewTeamsMeetingCommand(service.TeamsMeetingDeps{
			Meetings:      graph,
			Sender:        c.messages,
			Users:         c.users,
			Memberships:   members,
			Conversations: in.conversations,
			Channels:      in.channels,
		}))
		slog.Info("Microsoft 365 integration enabled", "tenant", cfg.MSTenantID)
	}

	// ------------------------------------------------------------- Drafts
	c.drafts = service.NewDraftService(store.NewRedisDraftStore(in.cache.Client()), in.messages, members, in.conversations, in.pubsub)
	// A group message becoming a private channel, its drafts going along.
	c.channels.SetConversationConverter(in.conversations, c.drafts)
	// Fold draft-clear into every composer send: a successful message send or
	// command run clears the scope's draft server-side, so the client makes
	// no separate clear request.
	c.messages.SetDraftClearer(c.drafts)
	c.commands.SetDraftClearer(c.drafts)

	// ------------------------------------------------------------- Activity + reminders
	// Reaction hints land in the message author's activity stream. Reminders
	// come due as the reminder bot's posts; one the bot can't post falls back
	// to the owner's activity stream plus a desktop/mobile alert (NotifyDirect,
	// wired with the notifier).
	c.activity = service.NewActivityService(store.NewRedisActivityStore(in.cache.Client()), in.pubsub)
	c.activity.SetChannelResolver(c.channels)      // snapshot channel slug onto reaction activity items
	c.activity.SetMemberLister(c.messages)         // who holds items about an edited/deleted message
	c.messages.SetActivityRecorder(c.activity)     // reactions, message edits/deletes, mark-unread
	c.channels.SetActivityRecorder(c.activity)     // "added you to ~channel", leaving, reading
	c.conversations.SetActivityTracker(c.activity) // reading a conversation reads its items
	c.userState.SetActivityTracker(c.activity)     // seeing a thread reads its items
	c.reminders = service.NewReminderService(store.NewRedisReminderStore(in.cache.Client()), in.messages, c.messages)
	c.reminders.SetPublisher(in.pubsub)        // reminders.changed: every device keeps its pending list current
	c.channels.SetReminderSync(c.reminders)    // losing a channel takes its pending reminders
	c.channels.SetThreadStateSync(c.userState) // ...and its threads' unread markers
	c.messages.SetReminderSync(c.reminders)    // deleting/editing a message reaches its reminders
	c.reminders.SetOwnerLookup(in.users)       // a deactivated owner's reminders are dropped when due, never sent
	c.users.SetReminderCanceller(c.reminders)  // deactivating an account stops all its reminders at once
	// Alert text — popups, pushes, Activity rows, reminders — names each
	// mention by its ID's current name, as the rendered message does.
	c.activity.SetMentionResolver(c.mentions)
	c.activity.SetDeactivatedAccounts(c.users)
	c.reminders.SetMentionResolver(c.mentions)
	// Due reminders are the reminder bot's posts: a reply tagging the people
	// added, or a DM to the owner linking the message.
	c.reminders.SetBot(c.messages, c.users, c.conversations, cfg.BaseURL)
	// Scheduled messages: composed now, posted at their time through the
	// normal send path (notifications included).
	c.scheduled = service.NewScheduledMessageService(store.NewScheduledMessageStore(in.db), c.messages, c.attachments, in.pubsub)
	c.scheduled.SetDraftClearer(c.drafts) // scheduling empties the composer's draft, like a send

	// ------------------------------------------------------------- Sidebar
	c.categories = service.NewCategoryService(store.NewCategoryStore(in.db), in.pubsub)
	// Server-owned reordering: drag-drops arrive as events (item + anchor);
	// the service computes every position and commits transactionally.
	c.sidebar = service.NewSidebarService(in.memberships, in.conversations, store.NewCategoryStore(in.db), store.NewSidebarOrderStore(in.db), in.pubsub)

	// Links to other messages in this workspace unfurl as rich, access-gated
	// message-preview cards (Slack/Mattermost style) instead of being scraped.
	c.messageLinks = service.NewMessageLinkService(
		cfg.BaseURL, in.channels, members, in.conversations, in.messages, c.users, c.attachments,
	)
	return nil
}

// buildMailer builds the transactional-mail transport. Mail is OPTIONAL: with
// nothing configured it returns a nil sender — invites and resets still mint
// their links, they just aren't delivered, and the admin relays them by hand
// (the admin email panel reports that state rather than pretending mail
// works). A malformed sender address or a bad transport setting is a
// misconfiguration, not an opt-out, and fails the boot.
func buildMailer(ctx context.Context, cfg *config.Config) (email.Sender, error) {
	m, err := newMailer(ctx, cfg)
	if err != nil {
		if !errors.Is(err, email.ErrNotConfigured) {
			return nil, fmt.Errorf("failed to init mail transport (provider %s): %w", cfg.EmailProvider, err)
		}
		slog.Warn("no mail transport configured; invite and password-reset links must be relayed by hand",
			"provider", cfg.EmailProvider)
		return nil, nil
	}
	slog.Info("transactional email enabled", "provider", cfg.EmailProvider)
	return m, nil
}

// newMailer builds the configured transactional-mail transport. It returns
// email.ErrNotConfigured when the selected provider has no settings, which
// buildMailer treats as "run without mail" rather than a failure.
func newMailer(ctx context.Context, cfg *config.Config) (email.Sender, error) {
	if cfg.EmailProvider == "ses" {
		return email.NewSESSender(ctx, email.SESConfig{
			// SES shares the deployment's AWS region and credential chain
			// with DynamoDB and S3, so an IAM-role deploy needs no extra
			// secrets.
			Region:           cfg.AWSRegion,
			From:             cfg.EmailFrom,
			ConfigurationSet: cfg.SESConfigurationSet,
		})
	}
	return email.NewSMTPSender(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPass, cfg.EmailFrom,
		email.TLSPolicy(cfg.SMTPTLSPolicy))
}
