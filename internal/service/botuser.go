package service

import (
	"context"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Bots get their own ID namespace so they can never collide with a user's
// ULID, and an RFC 2606 .invalid address so nothing can ever be delivered to
// them. The separator salts the webhook→bot digest.
const (
	botUserIDPrefix      = "bot-"
	botIDDomainSeparator = "ex:webhook-bot-user:v1\x00"
	botEmailDomain       = "bots.ex.invalid"
)

var botIDEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// WebhookBotUserID derives a webhook's bot account ID.
//
// DO NOT use the webhook ID directly. It is a bearer credential (POST
// /hooks/{id} has no other auth), while the bot ID is published to every
// recipient as the message authorID, in participantIDs, and by
// /api/v1/users/batch. The digest keeps derivation idempotent — same webhook,
// same bot, no stored mapping — without leaking the credential.
func WebhookBotUserID(webhookID string) string {
	sum := sha256.Sum256([]byte(botIDDomainSeparator + webhookID))
	return botUserIDPrefix + botIDEncoding.EncodeToString(sum[:15])
}

func isBotUserID(id string) bool { return strings.HasPrefix(id, botUserIDPrefix) }

// EnsureBotUser returns the machine account for botID, creating it on first
// use and renaming it when the webhook's username changes. Conversations
// created before a rename keep their label: UserConversation.DisplayName is
// snapshotted at creation.
func (s *UserService) EnsureBotUser(ctx context.Context, botID, displayName string) (*model.User, error) {
	// A human's ULID here would overwrite their account with IsBot set.
	if !isBotUserID(botID) {
		return nil, fmt.Errorf("user: %q is not a bot account ID", botID)
	}
	name := sanitizeBotDisplayName(displayName)

	existing, err := s.users.GetUser(ctx, botID)
	if err == nil && existing != nil {
		if existing.DisplayName != name {
			existing.DisplayName = name
			existing.UpdatedAt = time.Now()
			// Cosmetic: a failed rename must not fail the delivery.
			if uerr := s.users.UpdateUser(ctx, existing); uerr == nil && s.cache != nil {
				_ = s.cache.Delete(ctx, "user:"+botID)
			}
		}
		return existing, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("user: get bot: %w", err)
	}

	now := time.Now()
	bot := &model.User{
		ID:          botID,
		Email:       botID + "@" + botEmailDomain,
		DisplayName: name,
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
		IsBot:       true,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.users.CreateUser(ctx, bot); err != nil {
		// A concurrent delivery won the race; its row is authoritative.
		if errors.Is(err, store.ErrAlreadyExists) {
			won, getErr := s.users.GetUser(ctx, botID)
			if getErr != nil {
				return nil, fmt.Errorf("user: get bot after race: %w", getErr)
			}
			return won, nil
		}
		return nil, fmt.Errorf("user: create bot: %w", err)
	}
	return bot, nil
}

// sanitizeBotDisplayName bounds the name the way human display names are
// bounded. Webhook Username has no length limit of its own.
func sanitizeBotDisplayName(raw string) string {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "Webhook"
	}
	if utf8.RuneCountInString(name) > MaxUserDisplayNameLen {
		name = string([]rune(name)[:MaxUserDisplayNameLen])
	}
	return name
}
