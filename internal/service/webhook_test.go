package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeWebhookStore struct {
	items     map[string]*model.IncomingWebhook
	createErr error
	updateErr error
	deleteErr error
}

func (f *fakeWebhookStore) Create(_ context.Context, wh *model.IncomingWebhook) error {
	if f.createErr != nil {
		return f.createErr
	}
	if f.items == nil {
		f.items = map[string]*model.IncomingWebhook{}
	}
	f.items[wh.ID] = wh
	return nil
}
func (f *fakeWebhookStore) Get(_ context.Context, id string) (*model.IncomingWebhook, error) {
	if wh, ok := f.items[id]; ok {
		return wh, nil
	}
	return nil, store.ErrNotFound
}
func (f *fakeWebhookStore) List(context.Context) ([]*model.IncomingWebhook, error) {
	out := make([]*model.IncomingWebhook, 0, len(f.items))
	for _, wh := range f.items {
		out = append(out, wh)
	}
	return out, nil
}
func (f *fakeWebhookStore) Update(_ context.Context, wh *model.IncomingWebhook) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	if f.items == nil {
		f.items = map[string]*model.IncomingWebhook{}
	}
	f.items[wh.ID] = wh
	return nil
}
func (f *fakeWebhookStore) Delete(_ context.Context, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.items, id)
	return nil
}

type fakeWebhookChannels struct {
	byID   map[string]*model.Channel
	bySlug map[string]*model.Channel
}

func (f fakeWebhookChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	if ch, ok := f.byID[id]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}
func (f fakeWebhookChannels) GetBySlug(_ context.Context, slug string) (*model.Channel, error) {
	if ch, ok := f.bySlug[slug]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

type fakeWebhookImageProxy struct{}

func (fakeWebhookImageProxy) ProxyImageURL(_ context.Context, rawURL string) string {
	return "/api/v1/media/proxied/" + rawURL
}

func (fakeWebhookImageProxy) ProxyImageWithSize(_ context.Context, rawURL string) (string, int, int) {
	return "/api/v1/media/proxied/" + rawURL, 320, 240
}

type fakeWebhookDMResolver struct {
	conversations map[string]*model.Conversation
}

func (f *fakeWebhookDMResolver) GetOrCreateDM(_ context.Context, userA, userB string) (*model.Conversation, error) {
	if f.conversations == nil {
		f.conversations = map[string]*model.Conversation{}
	}
	id := userA + "__" + userB
	conv := &model.Conversation{ID: id, Type: model.ConversationTypeDM, ParticipantIDs: []string{userA, userB}}
	f.conversations[id] = conv
	return conv, nil
}

// fakeWebhookBots stands in for UserService's bot provisioning: it hands back
// a bot account for the requested ID and records the display name it was asked
// to label it with.
type fakeWebhookBots struct {
	err   error
	names map[string]string
}

func (f *fakeWebhookBots) EnsureBotUser(_ context.Context, botID, displayName string) (*model.User, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.names == nil {
		f.names = map[string]string{}
	}
	f.names[botID] = displayName
	return &model.User{ID: botID, DisplayName: displayName, IsBot: true}, nil
}

type fakeWebhookUsers struct {
	users []*model.User
	err   error
}

func (f fakeWebhookUsers) List(context.Context, int, string) ([]*model.User, string, error) {
	if f.err != nil {
		return nil, "", f.err
	}
	return f.users, "", nil
}

func TestIncomingWebhookService_CreateAndExecuteMattermostPayload(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	override := &model.Channel{ID: "ch-2", Name: "Builds", Slug: "builds", Type: model.ChannelTypePublic}
	webhooks := &fakeWebhookStore{}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch, override.ID: override},
		bySlug: map[string]*model.Channel{ch.Slug: ch, override.Slug: override},
	}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example")

	wh, err := svc.Create(ctx, "admin-1", &model.IncomingWebhook{
		Title: "CI", ChannelID: ch.ID, Username: "ci", ProfileImageURL: "https://example.com/icon.png",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if wh.ID == "" || svc.URL(wh) != "https://chat.example/hooks/"+wh.ID {
		t.Fatalf("unexpected webhook identity/url: %#v url=%q", wh, svc.URL(wh))
	}
	if wh.ProfileImageURL == "" || wh.ProfileImageURL == "https://example.com/icon.png" {
		t.Fatalf("profile image was not proxied: %q", wh.ProfileImageURL)
	}

	err = svc.Execute(ctx, wh.ID, IncomingWebhookPayload{
		Text:     "build done <https://example.com/log|logs> <!here>",
		Channel:  "#builds",
		Username: "bot",
		IconURL:  "https://example.com/override.png",
		Attachments: []model.MessageAttachment{{
			Color: "#ff8000", Pretext: "pre", Text: "body", Title: "Report",
			Fields:   []model.MessageAttachmentField{{Title: "Status", Value: "OK", Short: true}},
			ImageURL: "https://example.com/image.png", ThumbURL: "https://example.com/thumb.png",
			Footer: "footer", FooterIcon: "https://example.com/footer.png",
		}},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	if msg.ParentID != override.ID || msg.Body != "build done [logs](https://example.com/log) @here" || msg.WebhookUsername != "bot" {
		t.Fatalf("unexpected message: %#v", msg)
	}
	if msg.WebhookAvatarURL == "" || len(msg.MessageAttachments) != 1 {
		t.Fatalf("expected webhook avatar and attachment: %#v", msg)
	}
	if msg.MessageAttachments[0].ImageURL == "https://example.com/image.png" || msg.MessageAttachments[0].ThumbURL == "" {
		t.Fatalf("attachment images were not proxied: %#v", msg.MessageAttachments[0])
	}
}

func TestIncomingWebhookService_LockToChannelIgnoresOverride(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	override := &model.Channel{ID: "ch-2", Name: "Other", Slug: "other"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, LockToChannel: true, Username: "locked", CreatedAt: time.Now()},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch, override.ID: override},
		bySlug: map[string]*model.Channel{ch.Slug: ch, override.Slug: override},
	}, msgSvc, nil, "")
	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hello", Channel: "other"}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got := onlyStoredMessage(t, messages).ParentID; got != ch.ID {
		t.Fatalf("message parent = %q, want locked channel %q", got, ch.ID)
	}
}

func TestIncomingWebhookService_CreateAcceptsBracketTitle(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{}}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example/")

	// "[]" is a valid (non-blank) title — creation must succeed, not fail
	// silently, and the title must be preserved verbatim.
	created, err := svc.Create(ctx, "admin", &model.IncomingWebhook{Title: "[]", ChannelID: ch.ID})
	if err != nil {
		t.Fatalf("Create with bracket title: %v", err)
	}
	if created.Title != "[]" {
		t.Fatalf("bracket title not preserved: %#v", created)
	}
}

func TestIncomingWebhookService_ValidationListDeleteAndOverrides(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, Username: "stored", ProfileImageURL: "stored-avatar", CreatedAt: time.Now()},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch},
		bySlug: map[string]*model.Channel{ch.Slug: ch},
	}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example/")

	if got := svc.URL(nil); got != "" {
		t.Fatalf("URL(nil) = %q", got)
	}
	if err := svc.Delete(ctx, ""); err == nil {
		t.Fatal("Delete empty id succeeded")
	}
	if _, err := svc.Create(ctx, "", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID}); err == nil {
		t.Fatal("Create without actor succeeded")
	}
	if _, err := svc.Create(ctx, "admin", nil); err == nil {
		t.Fatal("Create with nil input succeeded")
	}
	if _, err := svc.Create(ctx, "admin", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID, Description: strings.Repeat("x", 501)}); err == nil {
		t.Fatal("Create with long description succeeded")
	}
	if _, err := svc.Create(ctx, "admin", &model.IncomingWebhook{Title: "CI", ChannelID: "missing"}); err == nil {
		t.Fatal("Create with missing channel succeeded")
	}
	if _, err := NewIncomingWebhookService(&fakeWebhookStore{createErr: assertWebhookErr("create failed")}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, nil, "").Create(ctx, "admin", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID}); err == nil {
		t.Fatal("Create with store error succeeded")
	}
	created, err := svc.Create(ctx, "admin", &model.IncomingWebhook{Title: "  Default Name  ", ChannelID: ch.ID})
	if err != nil {
		t.Fatalf("Create default username: %v", err)
	}
	if created.Title != "Default Name" || created.Username != "webhook" {
		t.Fatalf("created defaults = %#v", created)
	}

	items, err := svc.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("List = %#v", items)
	}
	if err := svc.Delete(ctx, created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := NewIncomingWebhookService(&fakeWebhookStore{deleteErr: assertWebhookErr("delete failed")}, nil, msgSvc, nil, "").Delete(ctx, "wh"); err == nil {
		t.Fatal("Delete with store error succeeded")
	}

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hello", Channel: "@alice"}); err == nil || !strings.Contains(err.Error(), "direct-message") {
		t.Fatalf("Execute DM override without resolver err = %v", err)
	}
	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hello", IconEmoji: ":robot_face:"}); err != nil {
		t.Fatalf("Execute icon emoji override: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	if msg.WebhookAvatarURL != "" {
		t.Fatalf("icon emoji override should clear avatar URL, got %q", msg.WebhookAvatarURL)
	}
}

func TestIncomingWebhookService_TranslatesMattermostMentionsToMessageLinks(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, nil, nil)
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, CreatedBy: "creator-1", CreatedAt: time.Now()},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch},
		bySlug: map[string]*model.Channel{ch.Slug: ch},
	}, msgSvc, nil, "")
	svc.SetUserResolver(fakeWebhookUsers{users: []*model.User{
		{ID: "bob-1", DisplayName: "Bob Smith", Email: "bob@example.com"},
	}})

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{
		Text: "notify @bob in ~general and <#ch-1|general> <!channel> @here",
		Attachments: []model.MessageAttachment{{
			Text: "cc @bob <#general|general>",
			Fields: []model.MessageAttachmentField{{
				Title: "Owner",
				Value: "@bob",
			}},
		}},
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	wantBody := "notify @[bob-1|Bob Smith] in ~[ch-1|general] and ~[ch-1|general] @all @here"
	if msg.Body != wantBody {
		t.Fatalf("body = %q, want %q", msg.Body, wantBody)
	}
	if got := msg.MessageAttachments[0].Text; got != "cc @[bob-1|Bob Smith] ~[ch-1|general]" {
		t.Fatalf("attachment text = %q", got)
	}
	if got := msg.MessageAttachments[0].Fields[0].Value; got != "@[bob-1|Bob Smith]" {
		t.Fatalf("attachment field value = %q", got)
	}
}

func TestIncomingWebhookService_MentionTranslationFallbacks(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	svc := NewIncomingWebhookService(nil, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch},
		bySlug: map[string]*model.Channel{ch.Slug: ch},
	}, nil, nil, "")

	if got := svc.translateMattermostMarkup(ctx, "<#missing|lost> @channel @unknown ~missing"); got != "~lost @all @unknown ~missing" {
		t.Fatalf("fallback translation = %q", got)
	}
	if got := svc.translateMattermostMarkup(ctx, "<plain-token>"); got != "plain-token" {
		t.Fatalf("plain angle token = %q", got)
	}
	if mention, ok := (&IncomingWebhookService{}).channelMention(ctx, "general"); ok || mention != "" {
		t.Fatalf("channelMention without resolver = %q %v", mention, ok)
	}
	if mention, ok := svc.channelMention(ctx, ""); ok || mention != "" {
		t.Fatalf("blank channelMention = %q %v", mention, ok)
	}

	svc.SetUserResolver(fakeWebhookUsers{users: []*model.User{
		{ID: "no-name", Email: "noname@example.com"},
		{ID: "id-only"},
	}})
	if got := svc.translateMattermostMarkup(ctx, "@noname <@id-only>"); got != "@[no-name|noname@example.com] @[id-only|id-only]" {
		t.Fatalf("fallback user names = %q", got)
	}
}

func TestIncomingWebhookService_DirectMessageResolutionErrors(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	msgSvc := NewMessageService(newMockMessageStore(), nil, nil, nil, nil)
	wh := &model.IncomingWebhook{ID: "wh", ChannelID: ch.ID, CreatedBy: "creator-1"}
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": wh}}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, nil, "")

	if err := svc.Execute(ctx, "missing", IncomingWebhookPayload{Text: "hello"}); err == nil {
		t.Fatal("Execute missing webhook succeeded")
	}
	if _, err := svc.targetParent(ctx, wh, "@"); err == nil {
		t.Fatal("blank DM target succeeded")
	}
	svc.SetDMResolver(&fakeWebhookDMResolver{})
	svc.SetBotProvisioner(&fakeWebhookBots{})
	svc.SetUserResolver(fakeWebhookUsers{err: assertWebhookErr("users down")})
	if _, err := svc.targetParent(ctx, wh, "@bob"); err == nil || !strings.Contains(err.Error(), "list users") {
		t.Fatalf("list users err = %v", err)
	}
	svc.SetUserResolver(fakeWebhookUsers{users: []*model.User{nil, &model.User{ID: "u-1", DisplayName: "Alice", Email: "alice@example.com"}}})
	if _, err := svc.targetParent(ctx, wh, "@bob"); err == nil {
		t.Fatal("unknown DM target succeeded")
	}
	if _, err := svc.targetChannel(ctx, wh, "@bob"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("targetChannel @bob err = %v", err)
	}
}

type assertWebhookErr string

func (e assertWebhookErr) Error() string { return string(e) }

func TestIncomingWebhookService_ChannelOverridesAndSanitization(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	override := &model.Channel{ID: "ch-2", Name: "Builds", Slug: "builds"}
	archived := &model.Channel{ID: "ch-archived", Name: "Archived", Slug: "archived", Archived: true}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, nil, nil)
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, Username: "stored", CreatedAt: time.Now()},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch, override.ID: override, archived.ID: archived},
		bySlug: map[string]*model.Channel{ch.Slug: ch, override.Slug: override, archived.Slug: archived},
	}, msgSvc, fakeWebhookImageProxy{}, "")

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{
		Text:     "<https://example.com>",
		Channel:  override.ID,
		IconURL:  "notaurl",
		Username: "  ",
		Attachments: []model.MessageAttachment{{
			Pretext:    "<!all>",
			Text:       "<https://example.com/doc|doc>",
			AuthorIcon: "ftp://bad.example/icon.png",
			AuthorLink: "javascript:alert(1)",
			Title:      "Title",
			TitleLink:  "https://example.com/ok",
			Fields:     []model.MessageAttachmentField{{Title: "Link", Value: "<https://example.com/field>"}},
			Footer:     strings.Repeat("x", 305),
		}},
	}); err != nil {
		t.Fatalf("Execute ID channel override: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	if msg.ParentID != override.ID || msg.Body != "https://example.com" || msg.WebhookUsername != "stored" {
		t.Fatalf("message = %#v", msg)
	}
	att := msg.MessageAttachments[0]
	if att.Pretext != "@all" || att.Text != "[doc](https://example.com/doc)" || att.Fields[0].Value != "https://example.com/field" {
		t.Fatalf("translated attachment = %#v", att)
	}
	if att.AuthorIcon != "" || len(att.Footer) != 303 {
		t.Fatalf("sanitized attachment = %#v", att)
	}
	// The javascript: author link is dropped; the http title link survives.
	if att.AuthorLink != "" || att.TitleLink != "https://example.com/ok" {
		t.Fatalf("sanitized links author=%q title=%q", att.AuthorLink, att.TitleLink)
	}

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hello", Channel: "#archived"}); err == nil {
		t.Fatal("Execute archived channel override succeeded")
	}
}

func TestMessageService_SendWebhookValidationAndHooks(t *testing.T) {
	ctx := context.Background()
	messages := newMockMessageStore()
	svc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	notifier := &stubMessageNotifier{}
	indexer := newStubMessageIndexer()
	svc.SetNotifier(notifier)
	svc.SetIndexer(indexer)

	if _, err := svc.SendWebhook(ctx, WebhookMessageInput{}); err == nil {
		t.Fatal("SendWebhook without channel succeeded")
	}
	if _, err := svc.SendWebhook(ctx, WebhookMessageInput{ChannelID: "ch-1"}); err == nil {
		t.Fatal("SendWebhook without body or attachments succeeded")
	}

	msg, err := svc.SendWebhook(ctx, WebhookMessageInput{
		ChannelID: "ch-1",
		Attachments: []model.MessageAttachment{{
			Title: "Only attachment",
		}},
	})
	if err != nil {
		t.Fatalf("SendWebhook attachment-only: %v", err)
	}
	if msg.WebhookUsername != "webhook" || msg.AuthorID != "webhook" {
		t.Fatalf("message identity = %#v", msg)
	}
	// NotifyForMessage is dispatched off the send path, so poll for the call.
	deadline := time.Now().Add(2 * time.Second)
	for {
		notifier.mu.Lock()
		n := len(notifier.calls)
		notifier.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("notifier calls=%d, want 1", n)
		}
		time.Sleep(time.Millisecond)
	}
	notifier.mu.Lock()
	notifierParent := notifier.parents[0]
	notifier.mu.Unlock()
	if notifierParent != ParentChannel {
		t.Fatalf("notifier parent=%q, want %q", notifierParent, ParentChannel)
	}
	indexer.waitForCalls(t, 1)
}

func onlyStoredMessage(t *testing.T, messages *mockMessageStore) *model.Message {
	t.Helper()
	if len(messages.messages) != 1 {
		t.Fatalf("stored messages = %d, want 1", len(messages.messages))
	}
	for _, msg := range messages.messages {
		return msg
	}
	t.Fatal("missing stored message")
	return nil
}

type fakeWebhookMemberships struct {
	members map[string]bool // "channelID|userID" -> member
}

func (f fakeWebhookMemberships) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if f.members[channelID+"|"+userID] {
		return &model.ChannelMembership{ChannelID: channelID, UserID: userID}, nil
	}
	return nil, store.ErrNotFound
}

// pagingWebhookUsers serves users one page at a time, encoding the next
// page index in the cursor so findWebhookTargetUser must walk every page.
type pagingWebhookUsers struct {
	pages [][]*model.User
}

func (p *pagingWebhookUsers) List(_ context.Context, _ int, cursor string) ([]*model.User, string, error) {
	idx := 0
	if cursor != "" {
		_, _ = fmt.Sscanf(cursor, "%d", &idx)
	}
	if idx >= len(p.pages) {
		return nil, "", nil
	}
	next := ""
	if idx+1 < len(p.pages) {
		next = fmt.Sprintf("%d", idx+1)
	}
	return p.pages[idx], next, nil
}

func TestIncomingWebhookService_PrivateChannelOverrideMembership(t *testing.T) {
	ctx := context.Background()
	pub := &model.Channel{ID: "ch-pub", Slug: "pub", Type: model.ChannelTypePublic}
	priv := &model.Channel{ID: "ch-priv", Slug: "priv", Type: model.ChannelTypePrivate}
	msgSvc := NewMessageService(newMockMessageStore(), nil, nil, nil, nil)
	channels := fakeWebhookChannels{
		byID:   map[string]*model.Channel{pub.ID: pub, priv.ID: priv},
		bySlug: map[string]*model.Channel{pub.Slug: pub, priv.Slug: priv},
	}
	wh := &model.IncomingWebhook{ID: "wh", ChannelID: pub.ID, CreatedBy: "creator-1", CreatedAt: time.Now()}
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": wh}}, channels, msgSvc, fakeWebhookImageProxy{}, "")

	// Public override is always allowed.
	if ch, err := svc.targetChannel(ctx, wh, "pub"); err != nil || ch.ID != pub.ID {
		t.Fatalf("public override = %#v %v", ch, err)
	}
	// Private override with no resolver wired → fail closed.
	if _, err := svc.targetChannel(ctx, wh, "priv"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("private override w/o resolver err = %v", err)
	}
	// Resolver present but creator is not a member → denied.
	svc.SetMembershipResolver(fakeWebhookMemberships{})
	if _, err := svc.targetChannel(ctx, wh, "priv"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("private override non-member err = %v", err)
	}
	// Creator is a member → allowed.
	svc.SetMembershipResolver(fakeWebhookMemberships{members: map[string]bool{"ch-priv|creator-1": true}})
	if ch, err := svc.targetChannel(ctx, wh, "priv"); err != nil || ch.ID != priv.ID {
		t.Fatalf("private override member = %#v %v", ch, err)
	}

	// A webhook LOCKED to a private channel must also re-check membership on
	// its default channel (no override), not just on overrides — otherwise a
	// creator removed from the channel keeps posting.
	locked := &model.IncomingWebhook{ID: "wh2", ChannelID: priv.ID, LockToChannel: true, CreatedBy: "creator-1", CreatedAt: time.Now()}
	lockedSvc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh2": locked}}, channels, msgSvc, fakeWebhookImageProxy{}, "")
	lockedSvc.SetMembershipResolver(fakeWebhookMemberships{})
	if _, err := lockedSvc.targetChannel(ctx, locked, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("locked private default non-member err = %v", err)
	}
	lockedSvc.SetMembershipResolver(fakeWebhookMemberships{members: map[string]bool{"ch-priv|creator-1": true}})
	if ch, err := lockedSvc.targetChannel(ctx, locked, ""); err != nil || ch.ID != priv.ID {
		t.Fatalf("locked private default member = %#v %v", ch, err)
	}
}

func TestIncomingWebhookService_IconEmojiStoresName(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Slug: "general"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, nil, nil)
	wh := &model.IncomingWebhook{ID: "wh", ChannelID: ch.ID, ProfileImageURL: "stored-avatar", CreatedAt: time.Now()}
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": wh}}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, fakeWebhookImageProxy{}, "")

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hi", IconEmoji: " :tada: "}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	if msg.WebhookIconEmoji != "tada" || msg.WebhookAvatarURL != "" {
		t.Fatalf("icon emoji message = %#v", msg)
	}
}

func TestIncomingWebhookService_PublishesChangedEvents(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Slug: "general"}
	msgSvc := NewMessageService(newMockMessageStore(), nil, nil, nil, nil)
	pub := newMockPublisher()
	svc := NewIncomingWebhookService(&fakeWebhookStore{}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, nil, "")
	svc.SetPublisher(pub)

	created, err := svc.Create(ctx, "admin", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := svc.Delete(ctx, created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.published) != 2 {
		t.Fatalf("published events = %d, want 2", len(pub.published))
	}
	for _, ev := range pub.published {
		if ev.channel != pubsub.GlobalChannelEvents() || ev.event.Type != events.EventWebhookChanged {
			t.Fatalf("unexpected event %#v on %q", ev.event.Type, ev.channel)
		}
	}
}

func TestIncomingWebhookService_ImageURLDimensionsAndBadURL(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Slug: "general"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, nil, nil)
	wh := &model.IncomingWebhook{ID: "wh", ChannelID: ch.ID, CreatedAt: time.Now()}
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": wh}}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, fakeWebhookImageProxy{}, "")

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Attachments: []model.MessageAttachment{
		{ImageURL: "https://example.com/a.png"},
		{ImageURL: "ftp://bad.example/b.png"},
	}}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	if msg.MessageAttachments[0].ImageWidth != 320 || msg.MessageAttachments[0].ImageHeight != 240 {
		t.Fatalf("valid image dims = %dx%d", msg.MessageAttachments[0].ImageWidth, msg.MessageAttachments[0].ImageHeight)
	}
	if msg.MessageAttachments[1].ImageURL != "" || msg.MessageAttachments[1].ImageWidth != 0 {
		t.Fatalf("bad image url not dropped: %#v", msg.MessageAttachments[1])
	}
}

func TestMessageService_SendWebhookAttachmentCap(t *testing.T) {
	ctx := context.Background()
	svc := NewMessageService(newMockMessageStore(), nil, nil, newMockPublisher(), nil)
	atts := make([]model.MessageAttachment, MaxAttachmentsPerMessage+1)
	for i := range atts {
		atts[i] = model.MessageAttachment{Text: "x"}
	}
	if _, err := svc.SendWebhook(ctx, WebhookMessageInput{ChannelID: "ch-1", Attachments: atts}); !errors.Is(err, ErrTooManyAttachments) {
		t.Fatalf("SendWebhook over-cap err = %v", err)
	}
}

func TestIncomingWebhookService_Update(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	other := &model.Channel{ID: "ch-2", Name: "Builds", Slug: "builds"}
	pub := newMockPublisher()
	msgSvc := NewMessageService(newMockMessageStore(), nil, nil, nil, nil)
	store0 := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", Title: "Old", ChannelID: ch.ID, CreatedBy: "creator-1", Username: "old", CreatedAt: time.Unix(1, 0)},
	}}
	svc := NewIncomingWebhookService(store0, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch, other.ID: other},
	}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example")
	svc.SetPublisher(pub)

	// Validation failures.
	if _, err := svc.Update(ctx, "", &model.IncomingWebhook{Title: "x", ChannelID: ch.ID}); err == nil {
		t.Fatal("Update empty id succeeded")
	}
	if _, err := svc.Update(ctx, "wh", &model.IncomingWebhook{Title: "  ", ChannelID: ch.ID}); err == nil {
		t.Fatal("Update blank title succeeded")
	}
	if _, err := svc.Update(ctx, "wh", &model.IncomingWebhook{Title: "x", ChannelID: ch.ID, Description: strings.Repeat("d", 501)}); err == nil {
		t.Fatal("Update long description succeeded")
	}
	if _, err := svc.Update(ctx, "missing", &model.IncomingWebhook{Title: "x", ChannelID: ch.ID}); err == nil {
		t.Fatal("Update missing webhook succeeded")
	}
	if _, err := svc.Update(ctx, "wh", &model.IncomingWebhook{Title: "x", ChannelID: "nope"}); err == nil {
		t.Fatal("Update missing channel succeeded")
	}

	// Successful update re-points the channel and preserves identity.
	updated, err := svc.Update(ctx, "wh", &model.IncomingWebhook{
		Title: "New Title", ChannelID: other.ID, LockToChannel: true, Username: "", ProfileImageURL: "https://example.com/i.png",
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Title != "New Title" || updated.ChannelID != other.ID || updated.ChannelSlug != "builds" {
		t.Fatalf("updated channel fields = %#v", updated)
	}
	if updated.CreatedBy != "creator-1" || !updated.CreatedAt.Equal(time.Unix(1, 0)) {
		t.Fatalf("Update must preserve creator/createdAt: %#v", updated)
	}
	if updated.Username != "webhook" || updated.ProfileImageURL == "" {
		t.Fatalf("Update username/avatar defaults = %#v", updated)
	}
	if updated.ID == "wh" && !updated.UpdatedAt.After(time.Unix(1, 0)) {
		t.Fatalf("UpdatedAt not advanced: %#v", updated)
	}

	pub.mu.Lock()
	events := len(pub.published)
	pub.mu.Unlock()
	if events != 1 {
		t.Fatalf("Update should publish 1 change event, got %d", events)
	}

	// Store error surfaces.
	store0.updateErr = assertWebhookErr("update failed")
	if _, err := svc.Update(ctx, "wh", &model.IncomingWebhook{Title: "x", ChannelID: ch.ID}); err == nil {
		t.Fatal("Update store error succeeded")
	}
}

// botDMFixture wires a webhook whose DM path is fully configured, plus the
// fakes the assertions read back from.
func botDMFixture(t *testing.T, wh *model.IncomingWebhook, users []*model.User) (*IncomingWebhookService, *mockMessageStore, *fakeWebhookBots) {
	t.Helper()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	if wh.ChannelID == "" {
		wh.ChannelID = ch.ID
	}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(
		&fakeWebhookStore{items: map[string]*model.IncomingWebhook{wh.ID: wh}},
		fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}},
		msgSvc, nil, "")
	svc.SetDMResolver(&fakeWebhookDMResolver{})
	svc.SetUserResolver(fakeWebhookUsers{users: users})
	bots := &fakeWebhookBots{}
	svc.SetBotProvisioner(bots)
	return svc, messages, bots
}

func dmWebhook() *model.IncomingWebhook {
	return &model.IncomingWebhook{ID: "wh", CreatedBy: "u-creator", Username: "Deploy Bot", CreatedAt: time.Now()}
}

// Every addressing form lands in the same bot↔recipient conversation, authored
// by the bot. The creator is never a participant: they configure the
// integration, they are not a party to its messages.
func TestIncomingWebhookService_DirectMessageTargetForms(t *testing.T) {
	users := []*model.User{
		{ID: "u-creator", DisplayName: "Cara", Email: "cara@example.com"},
		{ID: "bob-1", DisplayName: "Bob Smith", Email: "bob@example.com"},
	}
	botID := WebhookBotUserID("wh")
	wantConv := botID + "__bob-1"

	for _, target := range []string{"bob@example.com", "@bob@example.com", "@Bob Smith", "@bob-1"} {
		t.Run(target, func(t *testing.T) {
			svc, messages, bots := botDMFixture(t, dmWebhook(), users)
			if err := svc.Execute(context.Background(), "wh", IncomingWebhookPayload{
				Text: "build 412 failed", Channel: target,
			}); err != nil {
				t.Fatalf("Execute: %v", err)
			}
			msg := onlyStoredMessage(t, messages)
			if msg.ParentID != wantConv {
				t.Errorf("conversation = %q, want the bot↔recipient DM %q", msg.ParentID, wantConv)
			}
			if msg.AuthorID != botID {
				t.Errorf("authorID = %q, want the bot so the fan-out excludes it", msg.AuthorID)
			}
			if bots.names[botID] != "Deploy Bot" {
				t.Errorf("thread label = %q, want the webhook's username", bots.names[botID])
			}
		})
	}
}

// The creator is an ordinary recipient now. The old self-DM rejection existed
// only because the creator was one of the two participants.
func TestIncomingWebhookService_DirectMessagesItsOwnCreator(t *testing.T) {
	svc, messages, _ := botDMFixture(t, dmWebhook(), []*model.User{
		{ID: "u-creator", DisplayName: "Cara", Email: "cara@example.com"},
	})
	if err := svc.Execute(context.Background(), "wh", IncomingWebhookPayload{Text: "hi", Channel: "cara@example.com"}); err != nil {
		t.Fatalf("DM to creator: %v", err)
	}
	if got, want := onlyStoredMessage(t, messages).ParentID, WebhookBotUserID("wh")+"__u-creator"; got != want {
		t.Errorf("conversation = %q, want %q", got, want)
	}
}

// Two webhooks messaging the same person get separate threads, so the
// recipient can tell the integrations apart.
func TestIncomingWebhookService_EachWebhookOwnsItsThread(t *testing.T) {
	users := []*model.User{{ID: "bob-1", Email: "bob@example.com"}}
	ctx := context.Background()
	deploy, deployMsgs, _ := botDMFixture(t, &model.IncomingWebhook{ID: "wh-deploy", CreatedAt: time.Now()}, users)
	pager, pagerMsgs, _ := botDMFixture(t, &model.IncomingWebhook{ID: "wh-pager", CreatedAt: time.Now()}, users)

	if err := deploy.Execute(ctx, "wh-deploy", IncomingWebhookPayload{Text: "deployed", Channel: "bob@example.com"}); err != nil {
		t.Fatalf("deploy webhook: %v", err)
	}
	if err := pager.Execute(ctx, "wh-pager", IncomingWebhookPayload{Text: "paged", Channel: "bob@example.com"}); err != nil {
		t.Fatalf("pager webhook: %v", err)
	}
	if a, b := onlyStoredMessage(t, deployMsgs).ParentID, onlyStoredMessage(t, pagerMsgs).ParentID; a == b {
		t.Fatalf("both webhooks shared conversation %q; each should own its own thread", a)
	}
}

// A locked webhook must refuse a person-addressed payload, not redirect it to
// the bound channel and answer 200.
func TestIncomingWebhookService_LockedWebhookRejectsDMTarget(t *testing.T) {
	wh := dmWebhook()
	wh.LockToChannel = true
	svc, messages, bots := botDMFixture(t, wh, []*model.User{{ID: "bob-1", Email: "bob@example.com"}})

	err := svc.Execute(context.Background(), "wh", IncomingWebhookPayload{Text: "salary review", Channel: "bob@example.com"})
	if !errors.Is(err, ErrWebhookDMRejected) {
		t.Fatalf("locked webhook DM err = %v, want ErrWebhookDMRejected", err)
	}
	if len(messages.messages) != 0 {
		t.Errorf("published %d messages; the payload must not reach the channel", len(messages.messages))
	}
	if len(bots.names) != 0 {
		t.Errorf("locked webhook provisioned a bot account: %v", bots.names)
	}
}

// Every way a DM can fail, and the error class each maps to. The class matters
// at an unauthenticated ingress: only ErrWebhookUnavailable tells the caller to
// retry.
func TestIncomingWebhookService_DirectMessageFailureModes(t *testing.T) {
	bob := []*model.User{{ID: "bob-1", Email: "bob@example.com"}}
	for _, tc := range []struct {
		name    string
		users   []*model.User
		setup   func(*IncomingWebhookService)
		target  string
		wantErr error
	}{
		{
			name: "no provisioner wired", users: bob,
			setup:  func(s *IncomingWebhookService) { s.SetBotProvisioner(nil) },
			target: "bob@example.com", wantErr: ErrWebhookDMRejected,
		},
		{
			name:  "target is itself a bot",
			users: []*model.User{{ID: "bot-other", DisplayName: "Other Bot", IsBot: true}},
			// Bots stay addressable by ID even though they are hidden from search.
			target: "@bot-other", wantErr: ErrWebhookDMRejected,
		},
		{
			name: "provisioning the bot fails", users: bob,
			setup: func(s *IncomingWebhookService) {
				s.SetBotProvisioner(&fakeWebhookBots{err: errors.New("users table throttled")})
			},
			target: "bob@example.com", wantErr: ErrWebhookUnavailable,
		},
		{
			name: "opening the conversation fails", users: bob,
			setup: func(s *IncomingWebhookService) {
				s.SetDMResolver(&failingWebhookDMResolver{err: errors.New("conversations down")})
			},
			target: "bob@example.com", wantErr: ErrWebhookUnavailable,
		},
		{
			name: "no such recipient", users: bob,
			target: "nobody@example.com", wantErr: store.ErrNotFound,
		},
		{
			name: "target names nobody", users: bob,
			target: "@", wantErr: store.ErrNotFound,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, messages, _ := botDMFixture(t, dmWebhook(), tc.users)
			if tc.setup != nil {
				tc.setup(svc)
			}
			err := svc.Execute(context.Background(), "wh", IncomingWebhookPayload{Text: "hi", Channel: tc.target})
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if len(messages.messages) != 0 {
				t.Errorf("stored %d messages despite the failure", len(messages.messages))
			}
		})
	}
}

type failingWebhookDMResolver struct{ err error }

func (f *failingWebhookDMResolver) GetOrCreateDM(context.Context, string, string) (*model.Conversation, error) {
	return nil, f.err
}

func TestIsDMTarget(t *testing.T) {
	for _, raw := range []string{"@bob", "@bob@example.com", "bob@example.com", "  bob@example.com  ", "@Bob Smith"} {
		if !isDMTarget(raw) {
			t.Errorf("isDMTarget(%q) = false, want true", raw)
		}
	}
	for _, raw := range []string{"", "general", "builds", "team-updates", "#general", "no-at-sign.com"} {
		if isDMTarget(raw) {
			t.Errorf("isDMTarget(%q) = true, want false", raw)
		}
	}
}

// The directory walk is the last resort in findWebhookTargetUser, after the
// email and search-index lookups miss. It must follow the cursor rather than
// giving up on the first page.
func TestIncomingWebhookService_DirectMessageTargetOnALaterPage(t *testing.T) {
	svc, messages, _ := botDMFixture(t, dmWebhook(), nil)
	svc.SetUserResolver(&pagingWebhookUsers{pages: [][]*model.User{
		{{ID: "u-creator", DisplayName: "Cara", Email: "cara@example.com"}},
		{{ID: "x", DisplayName: "Decoy"}},
		{{ID: "bob-1", DisplayName: "Bob Smith", Email: "bob@example.com"}},
	}})

	if err := svc.Execute(context.Background(), "wh", IncomingWebhookPayload{Text: "hi", Channel: "@Bob Smith"}); err != nil {
		t.Fatalf("paged DM: %v", err)
	}
	if got, want := onlyStoredMessage(t, messages).ParentID, WebhookBotUserID("wh")+"__bob-1"; got != want {
		t.Errorf("conversation = %q, want %q", got, want)
	}
}

// End-to-end across the real UserService, ConversationService and
// MessageService. Mocks cannot show this: routing DMs through a per-webhook bot
// means every thread is newly created, and a new conversation is born
// un-activated — invisible to everyone but its creator. The two halves have to
// compose, or the feature delivers messages nobody can see.
func TestWebhookDM_EndToEnd_BotThreadIsVisibleToRecipient(t *testing.T) {
	ctx := context.Background()

	users := newMockUserStore()
	users.users["creator-1"] = &model.User{ID: "creator-1", DisplayName: "Alice", Email: "alice@example.com", Status: "active"}
	users.users["bob-1"] = &model.User{ID: "bob-1", DisplayName: "Bob Smith", Email: "bob@example.com", Status: "active"}

	conversations := newMockConversationStore()
	publisher := newMockPublisher()
	userSvc := NewUserService(users, newMockCache(), nil, publisher)
	convSvc := NewConversationService(conversations, users, newMockCache(), newMockBroker(), publisher)

	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, publisher, nil)
	msgSvc.SetActivator(convSvc)

	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	wh := &model.IncomingWebhook{ID: "wh", ChannelID: ch.ID, CreatedBy: "creator-1", Username: "Deploy Bot", CreatedAt: time.Now()}
	whSvc := NewIncomingWebhookService(
		&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": wh}},
		fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}},
		msgSvc, nil, "")
	whSvc.SetDMResolver(convSvc)
	whSvc.SetUserResolver(userSvc)
	whSvc.SetBotProvisioner(userSvc)

	if err := whSvc.Execute(ctx, "wh", IncomingWebhookPayload{
		Text:    "build 412 failed",
		Channel: "bob@example.com",
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	msg := onlyStoredMessage(t, messages)
	conv, err := conversations.GetConversation(ctx, msg.ParentID)
	if err != nil {
		t.Fatalf("conversation %q was never created: %v", msg.ParentID, err)
	}

	// Un-activated conversations are hidden from every participant but their
	// creator — here, the bot. Only the real ConversationService can show this.
	if !conv.Activated {
		t.Fatal("conversation left un-activated — the recipient would never see the message")
	}
	var row *model.UserConversation
	for _, uc := range conversations.userConvs["bob-1"] {
		if uc.ConversationID == conv.ID {
			row = uc
		}
	}
	if row == nil {
		t.Fatal("recipient has no sidebar row for the conversation")
	}
	if !row.Activated {
		t.Error("recipient's sidebar row left un-activated")
	}
	// The label is snapshotted from the bot account a real UserService wrote.
	if row.DisplayName != "Deploy Bot" {
		t.Errorf("recipient's thread label = %q, want the integration's name", row.DisplayName)
	}
}
