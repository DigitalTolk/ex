package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// groupWebhookFixture is a rich webhook ("wh") and a classic one ("classic")
// posting through a message service whose user groups hold an enabled
// @oncall.
type groupWebhookFixture struct {
	svc      *IncomingWebhookService
	messages *mockMessageStore
	groups   *userGroupFixture
	token    string
}

func newGroupWebhookFixture(t *testing.T) *groupWebhookFixture {
	t.Helper()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	groups := newUserGroupFixture()
	oncall := groups.create(t, "oncall", "u-1")
	msgSvc.SetUserGroups(groups.svc)
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, Username: "Radar", Kind: model.WebhookKindRich, Templates: []model.MessageTemplate{{
			Key:     "squad",
			Payload: json.RawMessage(`{"text":"{{who}} is failing","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"{{who}} is failing"}}]}`),
		}}},
		"classic": {ID: "classic", ChannelID: ch.ID, Username: "Radar"},
	}}, fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}, bySlug: map[string]*model.Channel{ch.Slug: ch}},
		msgSvc, fakeWebhookImageProxy{}, "")
	return &groupWebhookFixture{svc: svc, messages: messages, groups: groups, token: "@[" + oncall.ID + "|oncall]"}
}

func section(text string) model.Block { return model.Block{Type: model.BlockSection, Text: md(text)} }

// Regression: a rich post tags the group in its text and in its section. The
// text alerted the group, but the section — what the channel shows — kept
// "@oncall" as plain words.
func TestIncomingWebhook_GroupTagInASectionIsStoredAsAMention(t *testing.T) {
	f := newGroupWebhookFixture(t)
	ack := btn("ack", "Acknowledge")
	ack.ExAction = model.ExActionAck
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Text: "@oncall 3 merge requests are waiting",
		Blocks: model.Blocks{
			section("@oncall 3 merge requests are waiting"),
			{Type: model.BlockActions, Elements: []model.BlockElement{ack}},
		},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	stored := onlyStoredMessage(t, f.messages)
	want := f.token + " 3 merge requests are waiting"
	if stored.Body != want {
		t.Fatalf("Body = %q, want %q", stored.Body, want)
	}
	if got := stored.Blocks[0].Text.Text; got != want {
		t.Fatalf("section text = %q, want %q", got, want)
	}
}

// Every block markdown text and every card text the webhook's @user rewrite
// reaches converts a group tag too; plain text never does.
func TestIncomingWebhook_GroupTagsConvertInEveryMarkdownText(t *testing.T) {
	f := newGroupWebhookFixture(t)
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Text: "summary",
		Blocks: model.Blocks{
			{Type: model.BlockHeader, Text: plain("@oncall header")},
			{Type: model.BlockSection, Text: plain("@oncall plain"), Fields: []model.TextObject{*md("@oncall field"), *plain("@oncall plain field")}},
			{Type: model.BlockContext, Elements: []model.BlockElement{
				{Type: model.TextMrkdwn, Content: "@oncall context"},
				{Type: model.TextPlain, Content: "@oncall plain context"},
			}},
			{Type: model.BlockToggle, Summary: []model.RichSpan{{Text: "@oncall summary"}}, Blocks: model.Blocks{section("@oncall in a toggle")}},
			{Type: model.BlockColumns, Blocks: model.Blocks{
				{Type: model.BlockColumn, Blocks: model.Blocks{section("@oncall in a column")}},
				{Type: model.BlockColumn, Blocks: model.Blocks{section("right")}},
			}},
		},
		Attachments: []model.MessageAttachment{{
			Pretext: "@oncall pretext",
			Title:   "@oncall title",
			Text:    "@oncall card",
			Fields:  []model.MessageAttachmentField{{Title: "Owner", Value: "@oncall value"}},
			Blocks:  model.Blocks{section("@oncall card block")},
		}},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	card := m.MessageAttachments[0]
	converted := map[string]string{
		"field":        m.Blocks[1].Fields[0].Text,
		"context":      m.Blocks[2].Elements[0].Content,
		"toggle":       m.Blocks[3].Blocks[0].Text.Text,
		"column":       m.Blocks[4].Blocks[0].Blocks[0].Text.Text,
		"card pretext": card.Pretext,
		"card text":    card.Text,
		"card value":   card.Fields[0].Value,
		"card block":   card.Blocks[0].Text.Text,
	}
	for where, got := range converted {
		if !strings.HasPrefix(got, f.token+" ") {
			t.Errorf("%s = %q, want the group mention", where, got)
		}
	}
	typed := map[string]string{
		"header":         m.Blocks[0].Text.Text,
		"plain section":  m.Blocks[1].Text.Text,
		"plain field":    m.Blocks[1].Fields[1].Text,
		"plain context":  m.Blocks[2].Elements[1].Content,
		"toggle summary": model.RichSpansPlain(m.Blocks[3].Summary),
		"card title":     card.Title,
	}
	for where, got := range typed {
		if !strings.HasPrefix(got, "@oncall ") {
			t.Errorf("%s = %q, want it as typed", where, got)
		}
	}
}

func TestIncomingWebhook_ClassicCardTextConvertsGroupTags(t *testing.T) {
	f := newGroupWebhookFixture(t)
	if _, err := f.svc.ExecuteClassic(context.Background(), "classic", IncomingWebhookPayload{
		Text:        "@oncall alert",
		Attachments: []model.MessageAttachment{{Pretext: "@oncall pre", Text: "@oncall card", Fields: []model.MessageAttachmentField{{Value: "@oncall value"}}}},
	}); err != nil {
		t.Fatalf("ExecuteClassic: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	card := m.MessageAttachments[0]
	for where, got := range map[string]string{"body": m.Body, "pretext": card.Pretext, "text": card.Text, "value": card.Fields[0].Value} {
		if !strings.HasPrefix(got, f.token+" ") {
			t.Errorf("%s = %q, want the group mention", where, got)
		}
	}
}

// A Slack group reference in a block becomes "@oncall" in the @user rewrite,
// and then the group's mention.
func TestIncomingWebhook_SlackGroupReferenceInABlock(t *testing.T) {
	f := newGroupWebhookFixture(t)
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Text:   "t",
		Blocks: model.Blocks{section("<!subteam^S1|@oncall> please look")},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	if got := onlyStoredMessage(t, f.messages).Blocks[0].Text.Text; got != f.token+" please look" {
		t.Fatalf("section text = %q", got)
	}
}

func TestIncomingWebhook_GroupTagsThatStayAsTypedInBlocks(t *testing.T) {
	f := newGroupWebhookFixture(t)
	off := f.groups.create(t, "off", "u-2")
	if _, err := f.groups.svc.SetEnabled(context.Background(), ugAdmin, off.ID, false); err != nil {
		t.Fatal(err)
	}
	keep := []string{"`@oncall` in code", "[@oncall](https://x.test/@oncall) link", "https://x.test/@oncall", "@nobody unknown", "@off disabled"}
	blocks := make(model.Blocks, len(keep))
	for i, text := range keep {
		blocks[i] = section(text)
	}
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{Text: "t", Blocks: blocks}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	for i, b := range m.Blocks {
		if strings.Contains(b.Text.Text, "group-") {
			t.Errorf("%q became %q, want it as typed", keep[i], b.Text.Text)
		}
	}
}

// Notifications read the text alone: a tag only in the blocks is drawn as a
// mention but alerts nobody, as for @alice.
func TestIncomingWebhook_GroupTagOnlyInBlocksStaysOutOfTheBody(t *testing.T) {
	f := newGroupWebhookFixture(t)
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Text:   "3 merge requests are waiting",
		Blocks: model.Blocks{section("@oncall 3 merge requests are waiting")},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	if !strings.HasPrefix(m.Blocks[0].Text.Text, f.token) {
		t.Fatalf("section = %q, want the group mention", m.Blocks[0].Text.Text)
	}
	if len(ParseMentions(m.Body).UserGroups) != 0 {
		t.Fatalf("body %q mentions a group: a tag only in blocks must alert nobody", m.Body)
	}
}

// Without text, the body ex builds from the blocks carries the mention, so
// the group is alerted.
func TestIncomingWebhook_FallbackBodyCarriesTheGroupMention(t *testing.T) {
	f := newGroupWebhookFixture(t)
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Blocks: model.Blocks{section("@oncall is failing")},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	if got := ParseMentions(m.Body).UserGroups; len(got) != 1 || got[0].Handle != "oncall" {
		t.Fatalf("fallback body %q mentions %v, want @oncall", m.Body, got)
	}
}

func TestIncomingWebhook_TemplatePostConvertsGroupTags(t *testing.T) {
	f := newGroupWebhookFixture(t)
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Template: "squad", Data: map[string]any{"who": "@oncall"},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	want := f.token + " is failing"
	if m.Body != want || m.Blocks[0].Text.Text != want {
		t.Fatalf("body %q, section %q, want %q", m.Body, m.Blocks[0].Text.Text, want)
	}
}

// A group lookup that fails never costs the post: everything stays as typed.
func TestIncomingWebhook_GroupLookupFailureLeavesEverythingAsTyped(t *testing.T) {
	f := newGroupWebhookFixture(t)
	f.groups.store.ownerErr = errors.New("boom")
	if _, err := f.svc.ExecuteRich(context.Background(), "wh", IncomingWebhookPayload{
		Text:   "@oncall alert",
		Blocks: model.Blocks{section("@oncall alert")},
	}); err != nil {
		t.Fatalf("ExecuteRich: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	if m.Body != "@oncall alert" || m.Blocks[0].Text.Text != "@oncall alert" {
		t.Fatalf("body %q, section %q, want both as typed", m.Body, m.Blocks[0].Text.Text)
	}
}

func TestIncomingWebhook_PreviewConvertsGroupTags(t *testing.T) {
	f := newGroupWebhookFixture(t)
	msg, err := f.svc.PreviewMessage(context.Background(), WebhookActor{ID: "u-1", Role: model.SystemRoleMember}, IncomingWebhookPayload{
		Text:   "@oncall alert",
		Blocks: model.Blocks{section("@oncall alert")},
	})
	if err != nil {
		t.Fatalf("PreviewMessage: %v", err)
	}
	want := f.token + " alert"
	if msg.Body != want || msg.Blocks[0].Text.Text != want {
		t.Fatalf("preview body %q, section %q, want %q", msg.Body, msg.Blocks[0].Text.Text, want)
	}
}

// replace_original, messages.update and an answer posted as a new message
// store group tags as mentions too; a replace still notifies nobody.
func TestApply_AppAnswersConvertGroupTags(t *testing.T) {
	f := newIxFixture(t)
	groups := newUserGroupFixture()
	oncall := groups.create(t, "oncall", "u-2")
	f.msgs.SetUserGroups(groups.svc)
	rec := &recordingNotifier{calls: make(chan notifierCall, 8)}
	f.msgs.SetNotifier(rec)
	token := "@[" + oncall.ID + "|oncall]"
	ctx := context.Background()
	answer := func(text string) AppResponse {
		return AppResponse{Text: text, Blocks: model.Blocks{section(text)}, Attachments: []model.MessageAttachment{{Text: text}}}
	}
	check := func(what string, m *model.Message, want string) {
		t.Helper()
		if m.Body != want || m.Blocks[0].Text.Text != want || m.MessageAttachments[0].Text != want {
			t.Fatalf("%s: body %q, section %q, card %q, want %q", what, m.Body, m.Blocks[0].Text.Text, m.MessageAttachments[0].Text, want)
		}
	}

	replace := answer("@oncall resolved")
	replace.ReplaceOriginal = true
	replaced, err := f.svc.apply(ctx, f.wh, f.rec(), replace)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	check("replace_original", replaced, token+" resolved")
	check("stored", f.messages.messages["ch1#m1"], token+" resolved")

	updated, err := f.svc.UpdateMessage(ctx, f.wh, MessageUpdate{ChannelID: "ch1", MessageID: "m1", Text: "@oncall reopened",
		Blocks: model.Blocks{section("@oncall reopened")}, Attachments: []model.MessageAttachment{{Text: "@oncall reopened"}}})
	if err != nil {
		t.Fatalf("messages.update: %v", err)
	}
	check("messages.update", updated, token+" reopened")

	select {
	case call := <-rec.calls:
		t.Fatalf("a replaced message notified (%q)", call.msgID)
	default:
	}

	posted, err := f.svc.apply(ctx, f.wh, f.rec(), answer("@oncall follow-up"))
	if err != nil {
		t.Fatalf("post new: %v", err)
	}
	check("new message", posted, token+" follow-up")
}
