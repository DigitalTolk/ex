package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeWebhookStore struct {
	items     map[string]*model.IncomingWebhook
	createErr error
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

func TestIncomingWebhookService_DirectMessageOverride(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, CreatedBy: "creator-1", Username: "stored", CreatedAt: time.Now()},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, nil, "")
	svc.SetDMResolver(&fakeWebhookDMResolver{})
	svc.SetUserResolver(fakeWebhookUsers{users: []*model.User{
		{ID: "creator-1", DisplayName: "Alice", Email: "alice@example.com"},
		{ID: "bob-1", DisplayName: "Bob Smith", Email: "bob@example.com"},
	}})

	if err := svc.Execute(ctx, "wh", IncomingWebhookPayload{Text: "hello", Channel: "@bob"}); err != nil {
		t.Fatalf("Execute DM override: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	if msg.ParentID != "creator-1__bob-1" || msg.AuthorID != "creator-1" {
		t.Fatalf("DM webhook message = %#v", msg)
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
	if _, _, err := svc.targetParent(ctx, wh, "@"); err == nil {
		t.Fatal("blank DM target succeeded")
	}
	svc.SetDMResolver(&fakeWebhookDMResolver{})
	svc.SetUserResolver(fakeWebhookUsers{err: assertWebhookErr("users down")})
	if _, _, err := svc.targetParent(ctx, wh, "@bob"); err == nil || !strings.Contains(err.Error(), "list users") {
		t.Fatalf("list users err = %v", err)
	}
	svc.SetUserResolver(fakeWebhookUsers{users: []*model.User{nil, &model.User{ID: "u-1", DisplayName: "Alice", Email: "alice@example.com"}}})
	if _, _, err := svc.targetParent(ctx, wh, "@bob"); err == nil {
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
	notifier.mu.Lock()
	notifierCalls := len(notifier.calls)
	notifierParent := ""
	if len(notifier.parents) > 0 {
		notifierParent = notifier.parents[0]
	}
	notifier.mu.Unlock()
	if notifierCalls != 1 || notifierParent != ParentChannel {
		t.Fatalf("notifier calls=%d parent=%q", notifierCalls, notifierParent)
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
