package service

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/paginate"
)

// botsCacheKey holds the bot accounts (BotAccounts) for rosterCacheTTL, and is
// dropped with the roster on every service write to an account
// (forgetCachedUser).
const botsCacheKey = "users:bots"

// botEntry is one cached bot. model.User keeps the owner and avatar key out of
// JSON, so they are stored beside it.
type botEntry struct {
	User      model.User `json:"user"`
	AvatarKey string     `json:"avatarKey,omitempty"`
	OwnerID   string     `json:"ownerID,omitempty"`
}

// isBotAccount reports a bot of the kind admins manage: one they created, or
// one migrated from Mattermost. The bot behind an incoming webhook belongs to
// its webhook.
func isBotAccount(u *model.User) bool {
	return u != nil && u.IsBot && !isBotUserID(u.ID)
}

// BotAccounts returns the bot accounts admins manage, disabled ones included,
// oldest first. Bots are a handful of rows among the accounts, so they are
// filtered out of the paged user partition, and the result shared through the
// cache like the roster.
func (s *UserService) BotAccounts(ctx context.Context) ([]*model.User, error) {
	var entries []botEntry
	if s.cache != nil && s.cache.Get(ctx, botsCacheKey, &entries) == nil {
		bots := make([]*model.User, len(entries))
		for i := range entries {
			bots[i] = &entries[i].User
			bots[i].AvatarKey, bots[i].BotOwnerID = entries[i].AvatarKey, entries[i].OwnerID
		}
		return bots, nil
	}
	users, err := paginate.All(ctx, func(ctx context.Context, cursor string) ([]*model.User, string, error) {
		return s.users.ListUsers(ctx, rosterPageSize, cursor)
	}, rosterMaxPages)
	if err != nil {
		return nil, fmt.Errorf("user: list bots: %w", err)
	}
	bots := slices.DeleteFunc(users, func(u *model.User) bool { return !isBotAccount(u) })
	entries = make([]botEntry, len(bots))
	for i, b := range bots {
		normalizeUserProfile(b)
		entries[i] = botEntry{User: *b, AvatarKey: b.AvatarKey, OwnerID: b.BotOwnerID}
	}
	if s.cache != nil {
		_ = s.cache.Set(ctx, botsCacheKey, entries, rosterCacheTTL)
	}
	return bots, nil
}

// SearchInvitable is Search plus the bots whose name or username matches:
// whoever can be added to a channel. A bot posts only where it is a member,
// so this is how one gets into a channel; everywhere else bots stay out of
// user search.
func (s *UserService) SearchInvitable(ctx context.Context, query string, limit int) ([]*model.User, error) {
	people, err := s.Search(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	bots, err := s.BotAccounts(ctx)
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(query))
	var matched []*model.User
	for _, b := range bots {
		if len(people)+len(matched) >= limit {
			break
		}
		if strings.Contains(strings.ToLower(b.DisplayName), q) || strings.Contains(b.Username, q) {
			matched = append(matched, b)
		}
	}
	s.resolveAvatars(ctx, matched)
	return append(people, matched...), nil
}
