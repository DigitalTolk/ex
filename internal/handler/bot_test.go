package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// handlerBotStore is service.BotStore in memory, writing bots into the shared
// mock user store the way the real one writes their user rows.
type handlerBotStore struct {
	users     *mockUserStore
	usernames map[string]string
	tokens    map[string]*model.BotToken
	getErr    error
}

func newHandlerBotStore(users *mockUserStore) *handlerBotStore {
	return &handlerBotStore{users: users, usernames: map[string]string{}, tokens: map[string]*model.BotToken{}}
}

func (s *handlerBotStore) CreateBot(ctx context.Context, u *model.User) error {
	s.usernames[u.Username] = u.ID
	return s.users.CreateUser(ctx, u)
}

func (s *handlerBotStore) UpdateBot(_ context.Context, u *model.User, previous string) error {
	delete(s.usernames, previous)
	s.usernames[u.Username] = u.ID
	return nil
}

func (s *handlerBotStore) UsernameOwner(_ context.Context, username string) (string, error) {
	if id, ok := s.usernames[username]; ok {
		return id, nil
	}
	return "", store.ErrNotFound
}

func (s *handlerBotStore) PutBotToken(_ context.Context, t *model.BotToken) error {
	s.tokens[t.TokenHash] = t
	return nil
}

func (s *handlerBotStore) GetBotToken(_ context.Context, hash string) (*model.BotToken, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	if t, ok := s.tokens[hash]; ok {
		return t, nil
	}
	return nil, store.ErrNotFound
}

func (s *handlerBotStore) ListBotTokens(_ context.Context, botID string) ([]*model.BotToken, error) {
	var out []*model.BotToken
	for _, t := range s.tokens {
		if t.BotUserID == botID {
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *handlerBotStore) DeleteBotToken(_ context.Context, hash string) error {
	delete(s.tokens, hash)
	return nil
}

// --- Mattermost service collaborators ---

type hmmChannels struct {
	channels  map[string]*model.Channel
	createErr error
	addErr    error
}

func (c *hmmChannels) Create(_ context.Context, userID, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	if c.createErr != nil {
		return nil, c.createErr
	}
	now := time.UnixMilli(1_700_000_000_000)
	ch := &model.Channel{ID: "ch-" + name, Name: name, Slug: name, Type: chanType, Description: description, CreatedBy: userID, CreatedAt: now, UpdatedAt: now}
	c.channels[ch.ID] = ch
	return ch, nil
}

func (c *hmmChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	if ch, ok := c.channels[id]; ok {
		return ch, nil
	}
	return nil, fmt.Errorf("channel: get: %w", store.ErrNotFound)
}

func (c *hmmChannels) AddMember(context.Context, string, string, string, model.ChannelRole) error {
	return c.addErr
}

type hmmMembers struct {
	members map[string]*model.ChannelMembership
}

func (m *hmmMembers) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if mem, ok := m.members[channelID+"#"+userID]; ok {
		return mem, nil
	}
	return nil, store.ErrNotFound
}

type hmmMessages struct {
	sent []string
	err  error
}

func (m *hmmMessages) Send(_ context.Context, userID, parentID, parentType, body, parentMessageID string, _ ...string) (*model.Message, error) {
	if m.err != nil {
		return nil, m.err
	}
	m.sent = append(m.sent, strings.Join([]string{userID, parentID, parentType, body, parentMessageID}, "|"))
	return &model.Message{ID: "m-1", ParentID: parentID, AuthorID: userID, Body: body, CreatedAt: time.UnixMilli(1_700_000_000_500)}, nil
}

type hmmDMs struct{ err error }

func (d *hmmDMs) GetOrCreateDM(_ context.Context, a, b string) (*model.Conversation, error) {
	if d.err != nil {
		return nil, d.err
	}
	return &model.Conversation{ID: "dm-1", ParticipantIDs: []string{a, b}, CreatedBy: a, CreatedAt: time.UnixMilli(1_700_000_000_000)}, nil
}

type hmmMarkup struct{}

func (hmmMarkup) TranslateMarkup(_ context.Context, text string) string {
	return strings.ReplaceAll(text, "~inc-0007", "~[ch-inc-0007|inc-0007]")
}

// botAPIFixture is the router with the bot admin API and the Mattermost API
// over in-memory stores, one bot with a token, and an admin and a member with
// session tokens.
type botAPIFixture struct {
	router    http.Handler
	jwt       *auth.JWTManager
	users     *mockUserStore
	bots      *handlerBotStore
	botSvc    *service.BotService
	channels  *hmmChannels
	members   *hmmMembers
	messages  *hmmMessages
	dms       *hmmDMs
	bot       *model.User
	botToken  string
	adminJWT  string
	memberJWT string
}

func newBotAPIFixture(t *testing.T) *botAPIFixture {
	t.Helper()
	ctx := context.Background()
	f := &botAPIFixture{
		jwt:      auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour),
		users:    newMockUserStore(),
		channels: &hmmChannels{channels: map[string]*model.Channel{"ch-incidents": {ID: "ch-incidents", Name: "incidents"}}},
		members:  &hmmMembers{members: map[string]*model.ChannelMembership{}},
		messages: &hmmMessages{},
		dms:      &hmmDMs{},
	}
	f.users.users["u-admin"] = &model.User{ID: "u-admin", SystemRole: model.SystemRoleAdmin, Status: "active", AuthProvider: model.AuthProviderOIDC}
	f.users.users["u-member"] = &model.User{ID: "u-member", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	cache := newMockCache()
	userSvc := service.NewUserService(f.users, cache, nil, nil)
	f.bots = newHandlerBotStore(f.users)
	f.botSvc = service.NewBotService(f.bots, f.users, userSvc, cache, nil)
	mm := service.NewMattermostService(f.channels, f.members, f.users, f.messages, f.dms, hmmMarkup{})
	f.router = NewRouter(&Deps{
		Auth: &AuthHandler{}, User: NewUserHandler(userSvc, nil),
		Channel: &ChannelHandler{}, Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: f.jwt, AppVersion: "test", AllowOrigins: []string{"*"},
		Bot:        NewBotHandler(f.botSvc),
		Mattermost: NewMattermostHandler(f.botSvc, userSvc, mm),
	})

	admin := service.BotActor{ID: "u-admin", Role: model.SystemRoleAdmin}
	bot, err := f.botSvc.Create(ctx, admin, service.BotInput{Username: "incident-bot", DisplayName: "Incident Bot", Description: "Opens incident channels"})
	if err != nil {
		t.Fatalf("create bot: %v", err)
	}
	issued, err := f.botSvc.CreateToken(ctx, admin, bot.ID, "CliffHub")
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	f.bot, f.botToken = bot, issued.Secret
	f.adminJWT, _ = f.jwt.GenerateAccessToken(f.users.users["u-admin"])
	f.memberJWT, _ = f.jwt.GenerateAccessToken(f.users.users["u-member"])
	return f
}

// do sends a request with `Authorization: <authorization>` (none when empty).
func (f *botAPIFixture) do(method, path, authorization, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return out
}

func TestBotHandler_AdminManagesBotsAndTokens(t *testing.T) {
	f := newBotAPIFixture(t)
	admin := "Bearer " + f.adminJWT

	rec := f.do(http.MethodPost, "/api/v1/admin/bots", admin, `{"username":"general-bot","displayName":"General Bot","description":"Posts announcements"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	created := decodeBody[model.BotAccount](t, rec)
	if created.Username != "general-bot" || created.DisplayName != "General Bot" || created.Description != "Posts announcements" || created.OwnerID != "u-admin" || created.Status != "active" {
		t.Fatalf("created = %+v", created)
	}

	rec = f.do(http.MethodGet, "/api/v1/admin/bots", admin, "")
	listed := decodeBody[[]model.BotAccount](t, rec)
	names := []string{listed[0].Username, listed[1].Username}
	slices.Sort(names)
	if rec.Code != http.StatusOK || !slices.Equal(names, []string{"general-bot", "incident-bot"}) {
		t.Fatalf("list = %d %v", rec.Code, names)
	}

	rec = f.do(http.MethodPatch, "/api/v1/admin/bots/"+created.ID, admin, `{"username":"announcer","displayName":"Announcer","description":""}`)
	if rec.Code != http.StatusOK || decodeBody[model.BotAccount](t, rec).Username != "announcer" {
		t.Fatalf("update = %d %s", rec.Code, rec.Body.String())
	}

	rec = f.do(http.MethodPost, "/api/v1/admin/bots/"+created.ID+"/disable", admin, "")
	if rec.Code != http.StatusOK || decodeBody[model.BotAccount](t, rec).Status != "deactivated" {
		t.Fatalf("disable = %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(http.MethodPost, "/api/v1/admin/bots/"+created.ID+"/enable", admin, "")
	if rec.Code != http.StatusOK || decodeBody[model.BotAccount](t, rec).Status != "active" {
		t.Fatalf("enable = %d %s", rec.Code, rec.Body.String())
	}

	rec = f.do(http.MethodPost, "/api/v1/admin/bots/"+created.ID+"/tokens", admin, `{"description":"CliffHub"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create token = %d %s", rec.Code, rec.Body.String())
	}
	issued := decodeBody[model.BotTokenIssued](t, rec)
	if len(issued.Secret) != 26 || issued.Token.Description != "CliffHub" || strings.Contains(rec.Body.String(), "tokenHash") {
		t.Fatalf("issued = %s", rec.Body.String())
	}

	rec = f.do(http.MethodGet, "/api/v1/admin/bots/"+created.ID+"/tokens", admin, "")
	tokens := decodeBody[[]model.BotToken](t, rec)
	if rec.Code != http.StatusOK || len(tokens) != 1 || tokens[0].ID != issued.Token.ID || strings.Contains(rec.Body.String(), issued.Secret) {
		t.Fatalf("list tokens = %d %s", rec.Code, rec.Body.String())
	}

	// The new bot's token works on the Mattermost API until it is revoked.
	if rec := f.do(http.MethodGet, "/api/v4/users/me", "Bearer "+issued.Secret, ""); rec.Code != http.StatusOK {
		t.Fatalf("users/me with the new token = %d", rec.Code)
	}
	rec = f.do(http.MethodDelete, "/api/v1/admin/bots/"+created.ID+"/tokens/"+issued.Token.ID, admin, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(http.MethodGet, "/api/v4/users/me", "Bearer "+issued.Secret, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("users/me with a revoked token = %d", rec.Code)
	}
}

func TestBotHandler_Refusals(t *testing.T) {
	f := newBotAPIFixture(t)
	member, admin := "Bearer "+f.memberJWT, "Bearer "+f.adminJWT
	id := f.bot.ID
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/admin/bots", ""},
		{http.MethodPost, "/api/v1/admin/bots", `{"username":"x-bot"}`},
		{http.MethodPatch, "/api/v1/admin/bots/" + id, `{"username":"x-bot"}`},
		{http.MethodPost, "/api/v1/admin/bots/" + id + "/enable", ""},
		{http.MethodPost, "/api/v1/admin/bots/" + id + "/disable", ""},
		{http.MethodGet, "/api/v1/admin/bots/" + id + "/tokens", ""},
		{http.MethodPost, "/api/v1/admin/bots/" + id + "/tokens", `{"description":"x"}`},
		{http.MethodDelete, "/api/v1/admin/bots/" + id + "/tokens/t-1", ""},
	} {
		if rec := f.do(c.method, c.path, member, c.body); rec.Code != http.StatusForbidden {
			t.Errorf("member %s %s = %d, want 403", c.method, c.path, rec.Code)
		}
	}
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/admin/bots"},
		{http.MethodPatch, "/api/v1/admin/bots/" + id},
		{http.MethodPost, "/api/v1/admin/bots/" + id + "/tokens"},
	} {
		if rec := f.do(c.method, c.path, admin, `{"nope":1}`); rec.Code != http.StatusBadRequest {
			t.Errorf("unknown field %s %s = %d, want 400", c.method, c.path, rec.Code)
		}
	}
	// No claims at all (the handler outside its middleware) is nobody.
	if got := botActor(httptest.NewRequest(http.MethodGet, "/", nil)); got != (service.BotActor{}) {
		t.Errorf("botActor without claims = %+v", got)
	}
}

func TestUserHandler_ListUsersOffersBotsOnlyWhenAsked(t *testing.T) {
	f := newBotAPIFixture(t)
	f.users.users["u-inc"] = &model.User{ID: "u-inc", DisplayName: "Inca", Email: "inca@example.test", Status: "active"}
	member := "Bearer " + f.memberJWT

	ids := func(rec *httptest.ResponseRecorder) []string {
		var out []string
		for _, u := range decodeBody[[]model.User](t, rec) {
			out = append(out, u.ID)
		}
		return out
	}
	if got := ids(f.do(http.MethodGet, "/api/v1/users?q=inc", member, "")); slices.Contains(got, f.bot.ID) {
		t.Fatalf("plain search offered the bot: %v", got)
	}
	rec := f.do(http.MethodGet, "/api/v1/users?q=inc&bots=true", member, "")
	if got := ids(rec); !slices.Contains(got, f.bot.ID) || !slices.Contains(got, "u-inc") {
		t.Fatalf("invitable search = %v, want the person and the bot", got)
	}
	// A bot is labelled as one, with its handle; a person's record is as before.
	for _, u := range decodeBody[[]map[string]any](t, rec) {
		switch u["id"] {
		case f.bot.ID:
			if u["isBot"] != true || u["username"] != "incident-bot" {
				t.Errorf("bot projection = %v", u)
			}
		case "u-inc":
			if _, has := u["isBot"]; has {
				t.Errorf("person projection = %v", u)
			}
		}
	}
}

func TestMattermostAPI_Authentication(t *testing.T) {
	f := newBotAPIFixture(t)
	for name, authorization := range map[string]string{
		"no header":     "",
		"basic scheme":  "Basic " + f.botToken,
		"no token":      "Bearer",
		"unknown token": "Bearer " + strings.Repeat("a", 26),
		"session token": "Bearer " + f.adminJWT,
		"empty token":   "Token  ",
	} {
		rec := f.do(http.MethodGet, "/api/v4/users/me", authorization, "")
		body := decodeBody[mmError](t, rec)
		if rec.Code != http.StatusUnauthorized || body.ID != mmErrSession || body.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: %d %+v", name, rec.Code, body)
		}
	}
	// Mattermost takes the scheme in any case, and "Token" too.
	for _, authorization := range []string{"bearer " + f.botToken, "Token " + f.botToken, "TOKEN " + f.botToken} {
		if rec := f.do(http.MethodGet, "/api/v4/users/me", authorization, ""); rec.Code != http.StatusOK {
			t.Errorf("%q = %d", authorization, rec.Code)
		}
	}
	// A bot token drives nothing else.
	if rec := f.do(http.MethodGet, "/api/v1/users?q=inc", "Bearer "+f.botToken, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("bot token on /api/v1 = %d", rec.Code)
	}
	// A failed token lookup is a server error, not a rejected token.
	f.bots.getErr = errors.New("boom")
	rec := f.do(http.MethodGet, "/api/v4/users/me", "Bearer "+f.botToken, "")
	if body := decodeBody[mmError](t, rec); rec.Code != http.StatusInternalServerError || body.ID != mmErrServer {
		t.Errorf("failed lookup = %d %+v", rec.Code, body)
	}
}

func TestMattermostAPI_Users(t *testing.T) {
	f := newBotAPIFixture(t)
	bearer := "Bearer " + f.botToken

	rec := f.do(http.MethodGet, "/api/v4/users/me", bearer, "")
	me := decodeBody[mmUser](t, rec)
	if rec.Code != http.StatusOK || me.ID != f.bot.ID || me.Username != "incident-bot" || !me.IsBot || me.FirstName != "Incident Bot" ||
		me.BotDescription != "Opens incident channels" || me.Roles != "system_user" || me.CreateAt != f.bot.CreatedAt.UnixMilli() || me.DeleteAt != 0 {
		t.Fatalf("users/me = %d %+v", rec.Code, me)
	}

	f.users.users["u-alice"] = &model.User{ID: "u-alice", Email: "alice.o+inc@example.test", DisplayName: "Alice O Example", SystemRole: model.SystemRoleAdmin, Status: "active", TimeZone: "Europe/Stockholm"}
	f.users.emailIndex["alice.o+inc@example.test"] = f.users.users["u-alice"]
	rec = f.do(http.MethodGet, "/api/v4/users/email/alice.o+inc@example.test", bearer, "")
	alice := decodeBody[mmUser](t, rec)
	if rec.Code != http.StatusOK || alice.ID != "u-alice" || alice.Username != "alice.oinc" || alice.FirstName != "Alice" || alice.LastName != "O Example" ||
		alice.Roles != "system_admin system_user" || alice.IsBot || alice.Timezone["automaticTimezone"] != "Europe/Stockholm" {
		t.Fatalf("users/email = %d %+v", rec.Code, alice)
	}

	gone := &model.User{ID: "u-gone", Email: "gone@example.test", DisplayName: "Gone", SystemRole: model.SystemRoleGuest, Status: "deactivated", UpdatedAt: time.UnixMilli(1_700_000_000_000)}
	f.users.emailIndex[gone.Email] = gone
	rec = f.do(http.MethodGet, "/api/v4/users/email/gone@example.test", bearer, "")
	if u := decodeBody[mmUser](t, rec); u.DeleteAt != 1_700_000_000_000 || u.Roles != "system_guest" {
		t.Fatalf("deactivated guest = %+v", u)
	}

	rec = f.do(http.MethodGet, "/api/v4/users/email/nobody@example.test", bearer, "")
	if body := decodeBody[mmError](t, rec); rec.Code != http.StatusNotFound || body.ID != mmErrNoUser {
		t.Fatalf("unknown email = %d %+v", rec.Code, body)
	}
	// The token checks out, but reading the bot's profile fails.
	failing := NewMattermostHandler(f.botSvc, service.NewUserService(&getFailUserStore{f.users}, nil, nil, nil), nil)
	req := httptest.NewRequest(http.MethodGet, "/api/v4/users/me", nil)
	req.Header.Set("Authorization", bearer)
	rec = httptest.NewRecorder()
	failing.Authenticate(http.HandlerFunc(failing.Me)).ServeHTTP(rec, req)
	if body := decodeBody[mmError](t, rec); rec.Code != http.StatusInternalServerError || body.ID != mmErrServer {
		t.Fatalf("users/me with a failed read = %d %+v", rec.Code, body)
	}
}

func TestMattermostAPI_UsernameFallbacks(t *testing.T) {
	for _, c := range []struct {
		user model.User
		want string
	}{
		{model.User{ID: "B-1", IsBot: true, Username: "alerts"}, "alerts"},
		{model.User{ID: "B-1", IsBot: true, DisplayName: "Old Alerts!"}, "old-alerts"},
		{model.User{ID: "B-1", IsBot: true, DisplayName: "!!!"}, "b-1"},
		{model.User{ID: "U-1", Email: "Jo_Doe-2@example.test"}, "jo_doe-2"},
	} {
		if got := mmUsername(&c.user); got != c.want {
			t.Errorf("mmUsername(%+v) = %q, want %q", c.user, got, c.want)
		}
	}
	if millis(time.Time{}) != 0 {
		t.Error("a zero time is 0")
	}
}

func TestMattermostAPI_CreateChannel(t *testing.T) {
	f := newBotAPIFixture(t)
	bearer := "Bearer " + f.botToken

	rec := f.do(http.MethodPost, "/api/v4/channels", bearer, `{"team_id":"team-1","name":"inc-0007","display_name":"INC-0007 - Payments API down","type":"O","header":"Severity: critical","purpose":"Incident channel for INC-0007 - Payments API down","unknown_field":true}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	ch := decodeBody[mmChannel](t, rec)
	if ch.ID != "ch-inc-0007" || ch.Name != "inc-0007" || ch.TeamID != "team-1" || ch.Type != "O" || ch.DisplayName != "INC-0007 - Payments API down" ||
		ch.Header != "Severity: critical" || ch.Purpose != "Incident channel for INC-0007 - Payments API down" || ch.CreatorID != f.bot.ID || ch.CreateAt != 1_700_000_000_000 {
		t.Fatalf("channel = %+v", ch)
	}
	stored := f.channels.channels["ch-inc-0007"]
	if stored.Type != model.ChannelTypePublic || stored.Description != "Incident channel for INC-0007 - Payments API down" {
		t.Fatalf("stored = %+v", stored)
	}

	rec = f.do(http.MethodPost, "/api/v4/channels", bearer, `{"team_id":"team-1","name":"inc-0008","display_name":"INC-0008","type":"P"}`)
	if rec.Code != http.StatusCreated || f.channels.channels["ch-inc-0008"].Type != model.ChannelTypePrivate {
		t.Fatalf("private create = %d %s", rec.Code, rec.Body.String())
	}

	for _, c := range []struct{ body, id string }{
		{`{`, mmErrBody},
		{`{"name":"x","display_name":"X","type":"O"}`, "model.channel.is_valid.team_id.app_error"},
		{`{"team_id":"t","name":"x","type":"O"}`, "model.channel.is_valid.display_name.app_error"},
		{`{"team_id":"t","name":"x","display_name":"X","type":"D"}`, "model.channel.is_valid.type.app_error"},
	} {
		rec := f.do(http.MethodPost, "/api/v4/channels", bearer, c.body)
		if body := decodeBody[mmError](t, rec); rec.Code != http.StatusBadRequest || body.ID != c.id {
			t.Errorf("%s = %d %+v, want 400 %s", c.body, rec.Code, body, c.id)
		}
	}

	valid := `{"team_id":"t","name":"inc-0007","display_name":"X","type":"O"}`
	for _, c := range []struct {
		err    error
		status int
		id     string
	}{
		{fmt.Errorf("channel: a channel with this name already exists: %w", store.ErrAlreadyExists), http.StatusBadRequest, mmErrChannelExists},
		{apperr.Invalid("channel: name must be lowercase letters, digits, and hyphens"), http.StatusBadRequest, mmErrParam},
		{apperr.Forbidden("channel: guests cannot create channels"), http.StatusForbidden, mmErrPermissions},
		{errors.New("boom"), http.StatusInternalServerError, mmErrServer},
	} {
		f.channels.createErr = c.err
		rec := f.do(http.MethodPost, "/api/v4/channels", bearer, valid)
		if body := decodeBody[mmError](t, rec); rec.Code != c.status || body.ID != c.id || body.StatusCode != c.status {
			t.Errorf("%v = %d %+v, want %d %s", c.err, rec.Code, body, c.status, c.id)
		}
	}
}

func TestMattermostAPI_DirectChannel(t *testing.T) {
	f := newBotAPIFixture(t)
	bearer := "Bearer " + f.botToken

	rec := f.do(http.MethodPost, "/api/v4/channels/direct", bearer, `["u-zed","`+f.bot.ID+`"]`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("direct = %d %s", rec.Code, rec.Body.String())
	}
	ch := decodeBody[mmChannel](t, rec)
	pair := []string{"u-zed", f.bot.ID}
	slices.Sort(pair)
	if ch.ID != "dm-1" || ch.Type != "D" || ch.Name != pair[0]+"__"+pair[1] || ch.TeamID != "" || ch.CreatorID != f.bot.ID || ch.UpdateAt != 0 {
		t.Fatalf("direct channel = %+v", ch)
	}

	if rec := f.do(http.MethodPost, "/api/v4/channels/direct", bearer, `{}`); rec.Code != http.StatusBadRequest {
		t.Errorf("not a list = %d", rec.Code)
	}
	rec = f.do(http.MethodPost, "/api/v4/channels/direct", bearer, `["u-a","u-b"]`)
	if body := decodeBody[mmError](t, rec); rec.Code != http.StatusForbidden || body.ID != mmErrPermissions {
		t.Errorf("without the bot = %d %+v", rec.Code, body)
	}
	f.dms.err = fmt.Errorf("conversation: get user B: %w", store.ErrNotFound)
	rec = f.do(http.MethodPost, "/api/v4/channels/direct", bearer, `["`+f.bot.ID+`","u-ghost"]`)
	if body := decodeBody[mmError](t, rec); rec.Code != http.StatusNotFound || body.ID != mmErrNoUser {
		t.Errorf("unknown user = %d %+v", rec.Code, body)
	}
}

func TestMattermostAPI_AddChannelMember(t *testing.T) {
	f := newBotAPIFixture(t)
	bearer := "Bearer " + f.botToken
	f.users.users["u-alice"] = &model.User{ID: "u-alice"}
	f.members.members["ch-incidents#u-alice"] = &model.ChannelMembership{ChannelID: "ch-incidents", UserID: "u-alice", Role: model.ChannelRoleMember, JoinedAt: time.UnixMilli(1_700_000_000_000)}

	rec := f.do(http.MethodPost, "/api/v4/channels/ch-incidents/members", bearer, `{"user_id":"u-alice"}`)
	member := decodeBody[mmMember](t, rec)
	if rec.Code != http.StatusCreated || member.ChannelID != "ch-incidents" || member.UserID != "u-alice" || member.Roles != "channel_user" ||
		member.SchemeAdmin || !member.SchemeUser || member.LastUpdateAt != 1_700_000_000_000 || member.NotifyProps["desktop"] != "default" {
		t.Fatalf("member = %d %+v", rec.Code, member)
	}

	// Already in, as an admin: answered as is.
	f.channels.addErr = fmt.Errorf("channel: add member: %w", store.ErrAlreadyExists)
	f.members.members["ch-incidents#u-alice"].Role = model.ChannelRoleOwner
	rec = f.do(http.MethodPost, "/api/v4/channels/ch-incidents/members", bearer, `{"user_id":"u-alice"}`)
	if m := decodeBody[mmMember](t, rec); rec.Code != http.StatusCreated || m.Roles != "channel_user channel_admin" || !m.SchemeAdmin {
		t.Fatalf("existing owner = %d %+v", rec.Code, m)
	}

	for _, body := range []string{`{`, `{}`} {
		rec := f.do(http.MethodPost, "/api/v4/channels/ch-incidents/members", bearer, body)
		if e := decodeBody[mmError](t, rec); rec.Code != http.StatusBadRequest || e.ID != mmErrParam {
			t.Errorf("%s = %d %+v", body, rec.Code, e)
		}
	}
	for _, c := range []struct {
		user   string
		err    error
		status int
		id     string
	}{
		{"u-ghost", nil, http.StatusNotFound, mmErrNoUser},
		{"u-alice", fmt.Errorf("channel: %w", service.ErrForbidden), http.StatusForbidden, mmErrPermissions},
		{"u-alice", service.ErrMemberDeactivated, http.StatusBadRequest, mmErrDeactivated},
	} {
		f.channels.addErr = c.err
		rec := f.do(http.MethodPost, "/api/v4/channels/ch-incidents/members", bearer, `{"user_id":"`+c.user+`"}`)
		if e := decodeBody[mmError](t, rec); rec.Code != c.status || e.ID != c.id {
			t.Errorf("%s / %v = %d %+v, want %d %s", c.user, c.err, rec.Code, e, c.status, c.id)
		}
	}
}

func TestMattermostAPI_CreatePost(t *testing.T) {
	f := newBotAPIFixture(t)
	bearer := "Bearer " + f.botToken

	rec := f.do(http.MethodPost, "/api/v4/posts", bearer, `{"channel_id":"ch-incidents","message":"@all Further discussion on Incident INC-0007 at ~inc-0007","pending_post_id":"p-1","props":{"from_bot":"true"}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("post = %d %s", rec.Code, rec.Body.String())
	}
	post := decodeBody[mmPost](t, rec)
	if post.ID != "m-1" || post.UserID != f.bot.ID || post.ChannelID != "ch-incidents" || post.Message != "@all Further discussion on Incident INC-0007 at ~inc-0007" ||
		post.PendingPostID != "p-1" || post.CreateAt != 1_700_000_000_500 || post.Props == nil || post.Metadata == nil {
		t.Fatalf("post = %+v", post)
	}
	want := f.bot.ID + "|ch-incidents|" + service.ParentChannel + "|@all Further discussion on Incident INC-0007 at ~[ch-inc-0007|inc-0007]|"
	if len(f.messages.sent) != 1 || f.messages.sent[0] != want {
		t.Fatalf("sent %v, want %q", f.messages.sent, want)
	}

	// A direct channel, as a thread reply.
	rec = f.do(http.MethodPost, "/api/v4/posts", bearer, `{"channel_id":"dm-1","message":"You manage INC-0007","root_id":"m-0"}`)
	if rec.Code != http.StatusCreated || decodeBody[mmPost](t, rec).RootID != "m-0" {
		t.Fatalf("dm post = %d %s", rec.Code, rec.Body.String())
	}
	if got := f.messages.sent[1]; got != f.bot.ID+"|dm-1|"+service.ParentConversation+"|You manage INC-0007|m-0" {
		t.Fatalf("dm sent %q", got)
	}

	if rec := f.do(http.MethodPost, "/api/v4/posts", bearer, `[`); rec.Code != http.StatusBadRequest {
		t.Errorf("bad body = %d", rec.Code)
	}
	rec = f.do(http.MethodPost, "/api/v4/posts", bearer, `{"message":"x"}`)
	if e := decodeBody[mmError](t, rec); rec.Code != http.StatusBadRequest || e.ID != mmErrParam {
		t.Errorf("no channel = %d %+v", rec.Code, e)
	}
	for _, c := range []struct {
		err    error
		status int
		id     string
	}{
		{service.ErrChannelArchived, http.StatusForbidden, mmErrArchived},
		{fmt.Errorf("message: get conversation: %w", store.ErrNotFound), http.StatusNotFound, mmErrNoChannel},
		{fmt.Errorf("message: not a channel member: %w", service.ErrForbidden), http.StatusForbidden, mmErrPermissions},
		{apperr.Invalid("message: body or attachments required"), http.StatusBadRequest, mmErrParam},
	} {
		f.messages.err = c.err
		rec := f.do(http.MethodPost, "/api/v4/posts", bearer, `{"channel_id":"ch-incidents","message":"x"}`)
		if e := decodeBody[mmError](t, rec); rec.Code != c.status || e.ID != c.id {
			t.Errorf("%v = %d %+v, want %d %s", c.err, rec.Code, e, c.status, c.id)
		}
	}
}
