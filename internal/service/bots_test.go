package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeBotStore keeps bots in the shared mock user store, the way the real one
// writes the user row, with the username claims and tokens beside it.
type fakeBotStore struct {
	users     *mockUserStore
	usernames map[string]string
	tokens    map[string]*model.BotToken
	createErr error
	updateErr error
	ownerErr  error
	putErr    error
	getErr    error
	listErr   error
	deleteErr error
}

func newFakeBotStore(users *mockUserStore) *fakeBotStore {
	return &fakeBotStore{users: users, usernames: map[string]string{}, tokens: map[string]*model.BotToken{}}
}

func (f *fakeBotStore) CreateBot(_ context.Context, u *model.User) error {
	if f.createErr != nil {
		return f.createErr
	}
	f.usernames[u.Username] = u.ID
	f.users.users[u.ID] = u
	return nil
}

func (f *fakeBotStore) UpdateBot(_ context.Context, u *model.User, previous string) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	delete(f.usernames, previous)
	f.usernames[u.Username] = u.ID
	return nil
}

func (f *fakeBotStore) UsernameOwner(_ context.Context, username string) (string, error) {
	if f.ownerErr != nil {
		return "", f.ownerErr
	}
	id, ok := f.usernames[username]
	if !ok {
		return "", store.ErrNotFound
	}
	return id, nil
}

func (f *fakeBotStore) PutBotToken(_ context.Context, t *model.BotToken) error {
	if f.putErr != nil {
		return f.putErr
	}
	f.tokens[t.TokenHash] = t
	return nil
}

func (f *fakeBotStore) GetBotToken(_ context.Context, hash string) (*model.BotToken, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	t, ok := f.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	return t, nil
}

func (f *fakeBotStore) ListBotTokens(_ context.Context, botID string) ([]*model.BotToken, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []*model.BotToken
	for _, t := range f.tokens {
		if t.BotUserID == botID {
			out = append(out, t)
		}
	}
	slices.SortFunc(out, func(a, b *model.BotToken) int { return a.CreatedAt.Compare(b.CreatedAt) })
	return out, nil
}

func (f *fakeBotStore) DeleteBotToken(_ context.Context, hash string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.tokens, hash)
	return nil
}

type botFixture struct {
	svc     *BotService
	store   *fakeBotStore
	users   *mockUserStore
	cache   *mockCache
	pub     *mockPublisher
	userSvc *UserService
}

func newBotFixture() *botFixture {
	users := newMockUserStore()
	cache := newMockCache()
	pub := newMockPublisher()
	userSvc := NewUserService(users, cache, nil, pub)
	bots := newFakeBotStore(users)
	return &botFixture{
		svc:     NewBotService(bots, users, userSvc, cache, pub),
		store:   bots,
		users:   users,
		cache:   cache,
		pub:     pub,
		userSvc: userSvc,
	}
}

var botAdmin = BotActor{ID: "u-admin", Role: model.SystemRoleAdmin}

// published lists the types of the events published on channel.
func (f *botFixture) published(channel string) []string {
	var out []string
	for _, p := range f.pub.published {
		if p.channel == channel {
			out = append(out, p.event.Type)
		}
	}
	return out
}

func (f *botFixture) createBot(t *testing.T, username string) *model.User {
	t.Helper()
	bot, err := f.svc.Create(context.Background(), botAdmin, BotInput{Username: username, DisplayName: "Bot " + username})
	if err != nil {
		t.Fatalf("Create %s: %v", username, err)
	}
	return bot
}

func TestBots_OnlyAdminsManageBots(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	for _, actor := range []BotActor{{ID: "u-1", Role: model.SystemRoleMember}, {ID: "u-2", Role: model.SystemRoleGuest}, {Role: model.SystemRoleAdmin}} {
		_, listErr := f.svc.List(ctx, actor)
		_, createErr := f.svc.Create(ctx, actor, BotInput{Username: "bot"})
		_, updateErr := f.svc.Update(ctx, actor, "b", BotInput{Username: "bot"})
		_, enableErr := f.svc.SetEnabled(ctx, actor, "b", true)
		_, tokensErr := f.svc.ListTokens(ctx, actor, "b")
		_, tokenErr := f.svc.CreateToken(ctx, actor, "b", "x")
		revokeErr := f.svc.RevokeToken(ctx, actor, "b", "t")
		for name, err := range map[string]error{"List": listErr, "Create": createErr, "Update": updateErr, "SetEnabled": enableErr, "ListTokens": tokensErr, "CreateToken": tokenErr, "RevokeToken": revokeErr} {
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("%s by %+v = %v, want forbidden", name, actor, err)
			}
		}
	}
}

func TestBots_CreateMakesAnActiveBotOwnedByItsAdmin(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot, err := f.svc.Create(ctx, botAdmin, BotInput{Username: "  Incident-Bot ", DisplayName: " Incident Bot ", Description: " Opens incident channels "})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if bot.Username != "incident-bot" || bot.DisplayName != "Incident Bot" || bot.BotDescription != "Opens incident channels" {
		t.Fatalf("bot = %+v", bot)
	}
	if !bot.IsBot || bot.Status != "active" || bot.SystemRole != model.SystemRoleMember || bot.BotOwnerID != "u-admin" {
		t.Fatalf("bot = %+v", bot)
	}
	if bot.Email != strings.ToLower(bot.ID)+"@bots.ex.invalid" {
		t.Fatalf("email = %q", bot.Email)
	}
	if got := f.published(pubsub.GlobalChannelEvents()); !slices.Equal(got, []string{events.EventBotChanged}) {
		t.Fatalf("published %v", got)
	}

	// A display name defaults to the username.
	plain, err := f.svc.Create(ctx, botAdmin, BotInput{Username: "general-bot"})
	if err != nil || plain.DisplayName != "general-bot" {
		t.Fatalf("Create without a display name = %+v, %v", plain, err)
	}

	listed, err := f.svc.List(ctx, botAdmin)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	ids := []string{listed[0].ID, listed[1].ID}
	slices.Sort(ids)
	want := []string{bot.ID, plain.ID}
	slices.Sort(want)
	if !slices.Equal(ids, want) {
		t.Fatalf("List = %v, want %v", ids, want)
	}
}

func TestBots_CreateRefusesInvalidInput(t *testing.T) {
	f := newBotFixture()
	for name, in := range map[string]BotInput{
		"too short":            {Username: "ab"},
		"too long":             {Username: strings.Repeat("a", 23)},
		"starts with a digit":  {Username: "1bot"},
		"bad character":        {Username: "bot@x"},
		"a group mention":      {Username: "here"},
		"long display name":    {Username: "bot", DisplayName: strings.Repeat("x", 65)},
		"long description":     {Username: "bot", Description: strings.Repeat("x", 1025)},
		"empty":                {},
		"uppercase after trim": {Username: " A "},
	} {
		if _, err := f.svc.Create(context.Background(), botAdmin, in); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: Create = %v, want a validation error", name, err)
		}
	}
	if len(f.users.users) != 0 {
		t.Fatalf("refused input created %d accounts", len(f.users.users))
	}
}

func TestBots_CreateRefusesATakenUsername(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	f.createBot(t, "incident-bot")
	if _, err := f.svc.Create(ctx, botAdmin, BotInput{Username: "incident-bot"}); !errors.Is(err, ErrBotUsernameTaken) {
		t.Fatalf("Create with a taken username = %v", err)
	}
	// Taken between the check and the write.
	f.store.createErr = store.ErrAlreadyExists
	if _, err := f.svc.Create(ctx, botAdmin, BotInput{Username: "other-bot"}); !errors.Is(err, ErrBotUsernameTaken) {
		t.Fatalf("Create losing the race = %v", err)
	}
}

func TestBots_CreateStoreFailures(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	boom := errors.New("boom")
	f.store.ownerErr = boom
	if _, err := f.svc.Create(ctx, botAdmin, BotInput{Username: "bot"}); !errors.Is(err, boom) || errors.Is(err, ErrBotUsernameTaken) {
		t.Fatalf("Create with a failed username check = %v", err)
	}
	f.store.ownerErr = nil
	f.store.createErr = boom
	if _, err := f.svc.Create(ctx, botAdmin, BotInput{Username: "bot"}); !errors.Is(err, boom) {
		t.Fatalf("Create with a failed write = %v", err)
	}
}

func TestBots_UpdateRewritesTheProfile(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot := f.createBot(t, "incident-bot")
	f.pub.published = nil
	// Cached lists hold the old name.
	if _, err := f.svc.List(ctx, botAdmin); err != nil {
		t.Fatalf("List: %v", err)
	}

	updated, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "incidents", DisplayName: "Incidents", Description: "New"})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Username != "incidents" || updated.DisplayName != "Incidents" || updated.BotDescription != "New" {
		t.Fatalf("updated = %+v", updated)
	}
	if owner := f.store.usernames["incidents"]; owner != bot.ID {
		t.Fatalf("new username owner = %q", owner)
	}
	if _, held := f.store.usernames["incident-bot"]; held {
		t.Fatal("old username still held")
	}
	if got := f.published(pubsub.UserEvents()); !slices.Equal(got, []string{events.EventUserUpdated}) {
		t.Fatalf("user events %v", got)
	}
	if got := f.published(pubsub.GlobalChannelEvents()); !slices.Equal(got, []string{events.EventBotChanged}) {
		t.Fatalf("global events %v", got)
	}
	listed, err := f.svc.List(ctx, botAdmin)
	if err != nil || len(listed) != 1 || listed[0].Username != "incidents" {
		t.Fatalf("List after Update = %+v, %v", listed, err)
	}

	// Keeping its own username is fine.
	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "incidents", DisplayName: "Again"}); err != nil {
		t.Fatalf("Update keeping the username: %v", err)
	}
}

// A bot migrated from Mattermost has no username yet; an admin gives it one.
func TestBots_UpdateGivesAMigratedBotAUsername(t *testing.T) {
	f := newBotFixture()
	f.users.users["b-old"] = &model.User{ID: "b-old", DisplayName: "Alerts", IsBot: true, Status: "active"}
	updated, err := f.svc.Update(context.Background(), botAdmin, "b-old", BotInput{Username: "alerts"})
	if err != nil || updated.Username != "alerts" || updated.DisplayName != "alerts" {
		t.Fatalf("Update = %+v, %v", updated, err)
	}
}

func TestBots_UpdateRefusals(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot := f.createBot(t, "incident-bot")
	f.createBot(t, "general-bot")
	f.users.users["u-person"] = &model.User{ID: "u-person", DisplayName: "Person"}
	webhookBot := WebhookBotUserID("wh-1")
	f.users.users[webhookBot] = &model.User{ID: webhookBot, IsBot: true}

	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "x"}); !errors.Is(err, ErrValidation) {
		t.Errorf("invalid input: %v", err)
	}
	for _, id := range []string{"missing", "u-person", webhookBot} {
		if _, err := f.svc.Update(ctx, botAdmin, id, BotInput{Username: "fine"}); !errors.Is(err, ErrNotFound) {
			t.Errorf("Update %s = %v, want not found", id, err)
		}
	}
	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "general-bot"}); !errors.Is(err, ErrBotUsernameTaken) {
		t.Errorf("Update to a taken username = %v", err)
	}
	f.store.updateErr = store.ErrAlreadyExists
	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "fresh"}); !errors.Is(err, ErrBotUsernameTaken) {
		t.Errorf("Update losing the race = %v", err)
	}
	boom := errors.New("boom")
	f.store.updateErr = boom
	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "fresh"}); !errors.Is(err, boom) {
		t.Errorf("Update with a failed write = %v", err)
	}
	f.store.updateErr = nil
	f.store.ownerErr = boom
	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "fresh"}); !errors.Is(err, boom) {
		t.Errorf("Update with a failed username check = %v", err)
	}
	f.users.getUserErr = boom
	if _, err := f.svc.Update(ctx, botAdmin, bot.ID, BotInput{Username: "fresh"}); !errors.Is(err, boom) || errors.Is(err, ErrNotFound) {
		t.Errorf("Update with a failed read = %v", err)
	}
}

func TestBots_SetEnabledDeactivatesAndReactivates(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot := f.createBot(t, "incident-bot")
	f.pub.published = nil

	disabled, err := f.svc.SetEnabled(ctx, botAdmin, bot.ID, false)
	if err != nil || disabled.Status != "deactivated" {
		t.Fatalf("disable = %+v, %v", disabled, err)
	}
	if got := f.published(pubsub.GlobalChannelEvents()); !slices.Equal(got, []string{events.EventBotChanged}) {
		t.Fatalf("global events %v", got)
	}
	enabled, err := f.svc.SetEnabled(ctx, botAdmin, bot.ID, true)
	if err != nil || enabled.Status != "active" {
		t.Fatalf("enable = %+v, %v", enabled, err)
	}

	if _, err := f.svc.SetEnabled(ctx, botAdmin, "missing", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetEnabled of a missing bot = %v", err)
	}
	boom := errors.New("boom")
	f.users.updateErr = boom
	if _, err := f.svc.SetEnabled(ctx, botAdmin, bot.ID, false); !errors.Is(err, boom) {
		t.Fatalf("SetEnabled with a failed write = %v", err)
	}
}

func TestBots_TokensAreIssuedListedAndRevoked(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot := f.createBot(t, "incident-bot")
	f.pub.published = nil

	issued, err := f.svc.CreateToken(ctx, botAdmin, bot.ID, " CliffHub ")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	// Mattermost's format: 26 lowercase base32 characters.
	if !regexp.MustCompile(`^[a-z2-7]{26}$`).MatchString(issued.Secret) {
		t.Fatalf("secret %q", issued.Secret)
	}
	sum := sha256.Sum256([]byte(issued.Secret))
	if issued.Token.TokenHash != hex.EncodeToString(sum[:]) || issued.Token.Description != "CliffHub" || issued.Token.BotUserID != bot.ID || issued.Token.CreatedBy != "u-admin" {
		t.Fatalf("token = %+v", issued.Token)
	}
	if got := f.published(pubsub.GlobalChannelEvents()); !slices.Equal(got, []string{events.EventBotChanged}) {
		t.Fatalf("global events %v", got)
	}
	second, err := f.svc.CreateToken(ctx, botAdmin, bot.ID, "Staging")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	if second.Secret == issued.Secret {
		t.Fatal("two tokens share a secret")
	}
	second.Token.CreatedAt = issued.Token.CreatedAt.Add(time.Second)
	f.store.tokens[second.Token.TokenHash].CreatedAt = second.Token.CreatedAt

	tokens, err := f.svc.ListTokens(ctx, botAdmin, bot.ID)
	if err != nil || len(tokens) != 2 || tokens[0].ID != issued.Token.ID {
		t.Fatalf("ListTokens = %+v, %v", tokens, err)
	}

	f.pub.published = nil
	if err := f.svc.RevokeToken(ctx, botAdmin, bot.ID, issued.Token.ID); err != nil {
		t.Fatalf("RevokeToken: %v", err)
	}
	if _, err := f.svc.Authenticate(ctx, issued.Secret); !errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("revoked token authenticates: %v", err)
	}
	if got := f.published(pubsub.GlobalChannelEvents()); !slices.Equal(got, []string{events.EventBotChanged}) {
		t.Fatalf("global events %v", got)
	}
	if err := f.svc.RevokeToken(ctx, botAdmin, bot.ID, issued.Token.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoking it again = %v", err)
	}
}

func TestBots_TokenRefusalsAndFailures(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot := f.createBot(t, "incident-bot")
	for _, d := range []string{"", "   ", strings.Repeat("x", 256)} {
		if _, err := f.svc.CreateToken(ctx, botAdmin, bot.ID, d); !errors.Is(err, ErrValidation) {
			t.Errorf("CreateToken(%q) = %v, want a validation error", d, err)
		}
	}
	if _, err := f.svc.CreateToken(ctx, botAdmin, "missing", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("CreateToken for a missing bot = %v", err)
	}
	if _, err := f.svc.ListTokens(ctx, botAdmin, "missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ListTokens for a missing bot = %v", err)
	}
	boom := errors.New("boom")
	f.store.putErr = boom
	if _, err := f.svc.CreateToken(ctx, botAdmin, bot.ID, "x"); !errors.Is(err, boom) {
		t.Errorf("CreateToken with a failed write = %v", err)
	}
	f.store.putErr = nil
	issued, err := f.svc.CreateToken(ctx, botAdmin, bot.ID, "x")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	f.store.deleteErr = boom
	if err := f.svc.RevokeToken(ctx, botAdmin, bot.ID, issued.Token.ID); !errors.Is(err, boom) {
		t.Errorf("RevokeToken with a failed delete = %v", err)
	}
	f.store.listErr = boom
	if err := f.svc.RevokeToken(ctx, botAdmin, bot.ID, issued.Token.ID); !errors.Is(err, boom) {
		t.Errorf("RevokeToken with a failed list = %v", err)
	}
}

func TestBots_Authenticate(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	bot := f.createBot(t, "incident-bot")
	issued, err := f.svc.CreateToken(ctx, botAdmin, bot.ID, "CliffHub")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}

	claims, err := f.svc.Authenticate(ctx, issued.Secret)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if claims.UserID != bot.ID || claims.SystemRole != model.SystemRoleMember || claims.DisplayName != bot.DisplayName || claims.Email != bot.Email || claims.Scope != "" {
		t.Fatalf("claims = %+v", claims)
	}

	for _, secret := range []string{"", "not-a-token"} {
		if _, err := f.svc.Authenticate(ctx, secret); !errors.Is(err, ErrBotTokenInvalid) {
			t.Errorf("Authenticate(%q) = %v", secret, err)
		}
	}

	// Disabled, its tokens stop working.
	if _, err := f.svc.SetEnabled(ctx, botAdmin, bot.ID, false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, err := f.svc.Authenticate(ctx, issued.Secret); !errors.Is(err, ErrBotTokenInvalid) {
		t.Errorf("a disabled bot's token = %v", err)
	}

	// A token naming an account that isn't a managed bot (a person, a webhook's
	// bot), or none at all, authenticates nobody.
	webhookBot := WebhookBotUserID("wh-1")
	f.users.users[webhookBot] = &model.User{ID: webhookBot, IsBot: true, Status: "active"}
	f.users.users["u-person"] = &model.User{ID: "u-person", Status: "active"}
	for _, owner := range []string{webhookBot, "u-person", "gone"} {
		f.store.tokens[hashBotToken("secret-"+owner)] = &model.BotToken{ID: "t-" + owner, BotUserID: owner}
		if _, err := f.svc.Authenticate(ctx, "secret-"+owner); !errors.Is(err, ErrBotTokenInvalid) {
			t.Errorf("token of %s = %v", owner, err)
		}
	}

	// A failed lookup is not a verdict.
	boom := errors.New("boom")
	f.users.getUserErr = boom
	if _, err := f.svc.Authenticate(ctx, issued.Secret); !errors.Is(err, boom) || errors.Is(err, ErrBotTokenInvalid) {
		t.Errorf("Authenticate with a failed user read = %v", err)
	}
	f.store.getErr = boom
	if _, err := f.svc.Authenticate(ctx, issued.Secret); !errors.Is(err, boom) || errors.Is(err, ErrBotTokenInvalid) {
		t.Errorf("Authenticate with a failed token read = %v", err)
	}
}

func TestUserBots_BotAccountsListsManagedBotsFromTheCache(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	webhookBot := WebhookBotUserID("wh-1")
	f.users.users[webhookBot] = &model.User{ID: webhookBot, IsBot: true}
	f.users.users["u-person"] = &model.User{ID: "u-person", DisplayName: "Person"}
	f.users.users["b-migrated"] = &model.User{ID: "b-migrated", DisplayName: "Alerts", IsBot: true, AvatarKey: "avatars/b.webp", BotOwnerID: "u-admin"}

	bots, err := f.userSvc.BotAccounts(ctx)
	if err != nil || len(bots) != 1 || bots[0].ID != "b-migrated" {
		t.Fatalf("BotAccounts = %+v, %v", bots, err)
	}
	calls := f.users.listCalls
	cached, err := f.userSvc.BotAccounts(ctx)
	if err != nil || f.users.listCalls != calls {
		t.Fatalf("second BotAccounts read the store (%d → %d calls), err %v", calls, f.users.listCalls, err)
	}
	if len(cached) != 1 || cached[0].AvatarKey != "avatars/b.webp" || cached[0].BotOwnerID != "u-admin" {
		t.Fatalf("cached bot = %+v", cached)
	}

	f.users.listErr = errors.New("boom")
	f.cache.values = map[string]interface{}{}
	if _, err := f.userSvc.BotAccounts(ctx); err == nil {
		t.Fatal("BotAccounts with a failed list succeeded")
	}

	// Without a cache it reads the store every time.
	f.users.listErr = nil
	noCache := NewUserService(f.users, nil, nil, nil)
	if bots, err := noCache.BotAccounts(ctx); err != nil || len(bots) != 1 {
		t.Fatalf("uncached BotAccounts = %+v, %v", bots, err)
	}
}

func TestUserBots_SearchInvitableAddsMatchingBots(t *testing.T) {
	f := newBotFixture()
	ctx := context.Background()
	f.users.users["u-inc"] = &model.User{ID: "u-inc", DisplayName: "Inca Person", Status: "active"}
	f.users.users["b-1"] = &model.User{ID: "b-1", DisplayName: "Incident Bot", Username: "incident-bot", IsBot: true, Status: "active"}
	f.users.users["b-2"] = &model.User{ID: "b-2", DisplayName: "Pager", Username: "inc-pager", IsBot: true, Status: "active"}
	f.users.users["b-3"] = &model.User{ID: "b-3", DisplayName: "General", Username: "general-bot", IsBot: true, Status: "active"}
	f.userSvc.SetSearcher(fakeUserSearcher{ids: []string{"u-inc"}})

	// Search alone never offers a bot.
	people, err := f.userSvc.Search(ctx, "inc", 10)
	if err != nil || len(people) != 1 || people[0].ID != "u-inc" {
		t.Fatalf("Search = %+v, %v", people, err)
	}

	got, err := f.userSvc.SearchInvitable(ctx, "INC", 10)
	if err != nil {
		t.Fatalf("SearchInvitable: %v", err)
	}
	ids := make([]string, len(got))
	for i, u := range got {
		ids[i] = u.ID
	}
	if ids[0] != "u-inc" || len(ids) != 3 || !slices.Contains(ids, "b-1") || !slices.Contains(ids, "b-2") {
		t.Fatalf("SearchInvitable = %v, want the person, then the bot matched by name and the one matched by username", ids)
	}

	// The limit holds people and bots together.
	capped, err := f.userSvc.SearchInvitable(ctx, "inc", 2)
	if err != nil || len(capped) != 2 || capped[0].ID != "u-inc" {
		t.Fatalf("capped SearchInvitable = %+v, %v", capped, err)
	}

	f.users.listErr = errors.New("boom")
	f.cache.values = map[string]interface{}{}
	if _, err := f.userSvc.SearchInvitable(ctx, "inc", 10); err == nil {
		t.Fatal("SearchInvitable with a failed bot list succeeded")
	}
	// No searcher: the people search itself fails.
	plain := NewUserService(f.users, nil, nil, nil)
	if _, err := plain.SearchInvitable(ctx, "inc", 10); err == nil {
		t.Fatal("SearchInvitable with a failed search succeeded")
	}
}
