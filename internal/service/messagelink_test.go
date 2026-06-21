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

type fakeMLChannels struct {
	bySlug map[string]*model.Channel
	byID   map[string]*model.Channel
	err    error
}

func (f fakeMLChannels) GetChannelBySlug(_ context.Context, slug string) (*model.Channel, error) {
	if f.err != nil {
		return nil, f.err
	}
	if ch, ok := f.bySlug[slug]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

func (f fakeMLChannels) GetChannel(_ context.Context, id string) (*model.Channel, error) {
	if f.err != nil {
		return nil, f.err
	}
	if ch, ok := f.byID[id]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

type fakeMLMemberships struct{ members map[string]bool }

func (f fakeMLMemberships) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if f.members[channelID+"#"+userID] {
		return &model.ChannelMembership{ChannelID: channelID, UserID: userID}, nil
	}
	return nil, store.ErrNotFound
}

type fakeMLConversations struct {
	byID map[string]*model.Conversation
	err  error
}

func (f fakeMLConversations) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if f.err != nil {
		return nil, f.err
	}
	if c, ok := f.byID[id]; ok {
		return c, nil
	}
	return nil, store.ErrNotFound
}

type fakeMLMessages struct{ byKey map[string]*model.Message }

func (f fakeMLMessages) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	if m, ok := f.byKey[parentID+"#"+msgID]; ok {
		return m, nil
	}
	return nil, store.ErrNotFound
}

type fakeMLUsers struct{ byID map[string]*model.User }

func (f fakeMLUsers) GetByID(_ context.Context, id string) (*model.User, error) {
	if u, ok := f.byID[id]; ok {
		return u, nil
	}
	return nil, store.ErrNotFound
}

type fakeMLAttachments struct{ byID map[string]*model.Attachment }

func (f fakeMLAttachments) Get(_ context.Context, id string) (*model.Attachment, error) {
	if a, ok := f.byID[id]; ok {
		return a, nil
	}
	return nil, errors.New("attachment not found")
}

func newTestMessageLinkService() *MessageLinkService {
	return NewMessageLinkService(
		"https://ex.test",
		fakeMLChannels{
			bySlug: map[string]*model.Channel{
				"general":  {ID: "ch-1", Slug: "general", Type: model.ChannelTypePrivate},
				"archived": {ID: "ch-arch", Slug: "archived", Archived: true},
				"public":   {ID: "ch-pub", Slug: "public", Type: model.ChannelTypePublic},
			},
			byID: map[string]*model.Channel{
				"ch-1":   {ID: "ch-1", Slug: "general", Type: model.ChannelTypePrivate},
				"ch-pub": {ID: "ch-pub", Slug: "public", Type: model.ChannelTypePublic},
			},
		},
		fakeMLMemberships{members: map[string]bool{"ch-1#viewer": true}},
		fakeMLConversations{byID: map[string]*model.Conversation{
			"conv-1": {ID: "conv-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"viewer", "other"}},
			"grp-1":  {ID: "grp-1", Type: model.ConversationTypeGroup, Name: "Project X", ParticipantIDs: []string{"viewer", "a", "b"}},
		}},
		fakeMLMessages{byKey: map[string]*model.Message{
			"ch-1#m1": {ID: "m1", ParentID: "ch-1", AuthorID: "u-author", Body: "hello @[u-x|Jane] in ~[ch-2|other]", CreatedAt: time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC), AttachmentIDs: []string{"att-1"}},
			// Attachment-only messages (empty text) — exercise the unfurl
			// body fallback paths.
			"ch-1#fileonly":  {ID: "fileonly", ParentID: "ch-1", AuthorID: "u-author", Body: "", AttachmentIDs: []string{"att-file"}},
			"ch-1#multifile": {ID: "multifile", ParentID: "ch-1", AuthorID: "u-author", Body: "   ", AttachmentIDs: []string{"att-file", "att-img2"}},
			"ch-1#richonly":   {ID: "richonly", ParentID: "ch-1", AuthorID: "u-author", Body: "", MessageAttachments: []model.MessageAttachment{{Fallback: "Deploy succeeded"}}},
			"ch-1#richtitle":  {ID: "richtitle", ParentID: "ch-1", WebhookUsername: "CI Bot", Body: "", MessageAttachments: []model.MessageAttachment{{Title: "Build #42 passed", Text: "all green", Fallback: "build ok"}}},
			"ch-1#richtext":   {ID: "richtext", ParentID: "ch-1", WebhookUsername: "CI Bot", Body: "", MessageAttachments: []model.MessageAttachment{{Text: "Coverage at 99%", Fallback: "coverage"}}},
			"ch-1#ghostatt":  {ID: "ghostatt", ParentID: "ch-1", AuthorID: "u-author", Body: "", AttachmentIDs: []string{"missing-att"}},
			"conv-1#m2": {ID: "m2", ParentID: "conv-1", AuthorID: "u-author", Body: "dm body"},
			"grp-1#m3":  {ID: "m3", ParentID: "grp-1", WebhookUsername: "CI Bot", WebhookAvatarURL: "https://img/bot.png", Body: "build done"},
			"ch-1#del":   {ID: "del", ParentID: "ch-1", Deleted: true},
			"ch-1#sys":   {ID: "sys", ParentID: "ch-1", System: true, Body: "joined"},
			"ch-pub#pm1": {ID: "pm1", ParentID: "ch-pub", AuthorID: "u-author", Body: "public note"},
		}},
		fakeMLUsers{byID: map[string]*model.User{
			"u-author": {ID: "u-author", DisplayName: "Günter", AvatarURL: "https://img/g.png"},
		}},
		fakeMLAttachments{byID: map[string]*model.Attachment{
			"att-1":    {ID: "att-1", ContentType: "image/png", URL: "https://img/chart.png"},
			"att-file": {ID: "att-file", ContentType: "application/pdf", Filename: "report.pdf"},
			"att-img2": {ID: "att-img2", ContentType: "image/png", Filename: "photo.png", URL: "https://img/photo.png"},
		}},
	)
}

func TestMessageLink_Preview_Channel(t *testing.T) {
	svc := newTestMessageLinkService()
	p, internal := svc.Preview(context.Background(), "viewer", "https://ex.test/channel/general#msg-m1")
	if !internal || p == nil {
		t.Fatalf("expected internal preview, got internal=%v p=%v", internal, p)
	}
	if p.Kind != "message" || p.ChannelLabel != "~general" || p.AuthorName != "Günter" || p.AuthorAvatarURL != "https://img/g.png" {
		t.Fatalf("preview = %#v", p)
	}
	if p.Image != "https://img/chart.png" {
		t.Errorf("image not resolved from file attachment: %q", p.Image)
	}
	// Body is kept raw (mention/emoji markdown intact) so the client renders
	// the excerpt with the same treatment as the chat.
	if p.Body != "hello @[u-x|Jane] in ~[ch-2|other]" {
		t.Errorf("body should be raw markdown: %q", p.Body)
	}
	if !strings.HasPrefix(p.CreatedAt, "2026-06-15T10:00:00") {
		t.Errorf("createdAt = %q", p.CreatedAt)
	}
}

func TestMessageLink_Preview_AttachmentOnlyBodyFallback(t *testing.T) {
	svc := newTestMessageLinkService()
	cases := []struct {
		name     string
		url      string
		wantBody string
	}{
		// Single uploaded file → paperclip + filename.
		{"single file", "https://ex.test/channel/general#msg-fileonly", "📎 report.pdf"},
		// Multiple files → first filename + remaining count.
		{"multiple files", "https://ex.test/channel/general#msg-multifile", "📎 report.pdf +1"},
		// Incoming-webhook rich attachment → prefer title, then text, then fallback.
		{"rich attachment title preferred", "https://ex.test/channel/general#msg-richtitle", "Build #42 passed"},
		{"rich attachment text when no title", "https://ex.test/channel/general#msg-richtext", "Coverage at 99%"},
		{"rich attachment fallback when no title/text", "https://ex.test/channel/general#msg-richonly", "Deploy succeeded"},
		// Attachment ID that no longer resolves → empty (no crash, no junk).
		{"unresolvable attachment", "https://ex.test/channel/general#msg-ghostatt", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, internal := svc.Preview(context.Background(), "viewer", tc.url)
			if !internal || p == nil {
				t.Fatalf("expected internal preview, got internal=%v p=%v", internal, p)
			}
			if p.Body != tc.wantBody {
				t.Fatalf("body = %q, want %q", p.Body, tc.wantBody)
			}
		})
	}
}

func TestMessageLink_Preview_ThreadLinkByChannelID(t *testing.T) {
	svc := newTestMessageLinkService()
	// Thread permalinks carry the channel ID in the path plus a `?thread=`
	// query — both must still resolve to the reply message's preview.
	p, internal := svc.Preview(
		context.Background(), "viewer",
		"https://ex.test/channel/ch-1?thread=root-1#msg-m1",
	)
	if !internal || p == nil {
		t.Fatalf("thread link by channel id should resolve: internal=%v p=%v", internal, p)
	}
	if p.ChannelLabel != "~general" || p.Body != "hello @[u-x|Jane] in ~[ch-2|other]" {
		t.Fatalf("thread preview = %#v", p)
	}
}

func TestMessageLink_Preview_DMAndGroupAndWebhook(t *testing.T) {
	svc := newTestMessageLinkService()

	dm, _ := svc.Preview(context.Background(), "viewer", "https://ex.test/conversation/conv-1#msg-m2")
	if dm == nil || dm.ChannelLabel != "Direct message" || dm.Body != "dm body" {
		t.Fatalf("dm preview = %#v", dm)
	}

	grp, _ := svc.Preview(context.Background(), "viewer", "https://ex.test/conversation/grp-1#msg-m3")
	if grp == nil || grp.ChannelLabel != "Project X" {
		t.Fatalf("group preview = %#v", grp)
	}
	// Webhook author identity wins over the user lookup.
	if grp.AuthorName != "CI Bot" || grp.AuthorAvatarURL != "https://img/bot.png" {
		t.Fatalf("webhook author = %#v", grp)
	}
}

func TestMessageLink_Preview_PublicChannelVisibleToNonMember(t *testing.T) {
	svc := newTestMessageLinkService()
	// "stranger" is not a member of the public channel, but public channels
	// are visible workspace-wide.
	p, internal := svc.Preview(context.Background(), "stranger", "https://ex.test/channel/public#msg-pm1")
	if !internal || p == nil {
		t.Fatalf("public channel preview should resolve for a non-member: internal=%v p=%v", internal, p)
	}
	if p.ChannelLabel != "~public" || p.Body != "public note" {
		t.Fatalf("public preview = %#v", p)
	}
}

func TestMessageLink_Preview_AccessAndMissing(t *testing.T) {
	svc := newTestMessageLinkService()
	cases := []struct {
		name string
		url  string
	}{
		{"non-member channel", "https://ex.test/channel/general#msg-m1"}, // viewer2 not a member
		{"archived channel", "https://ex.test/channel/archived#msg-m1"},
		{"unknown channel", "https://ex.test/channel/nope#msg-m1"},
		{"non-participant conversation", "https://ex.test/conversation/conv-1#msg-m2"}, // stranger
		{"unknown conversation", "https://ex.test/conversation/zzz#msg-x"},
		{"deleted message", "https://ex.test/channel/general#msg-del"},
		{"system message", "https://ex.test/channel/general#msg-sys"},
		{"missing message", "https://ex.test/channel/general#msg-ghost"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, internal := svc.Preview(context.Background(), "stranger", c.url)
			if !internal {
				t.Fatalf("%s: expected internal=true (our link, no leak), got false", c.name)
			}
			if p != nil {
				t.Fatalf("%s: expected nil preview (no access/missing), got %#v", c.name, p)
			}
		})
	}
}

func TestMessageLink_Preview_NotInternal(t *testing.T) {
	svc := newTestMessageLinkService()
	cases := []string{
		"https://other.example/channel/general#msg-m1", // wrong host
		"https://ex.test/channel/general",              // no message fragment
		"https://ex.test/channel/general#frag",         // wrong fragment form
		"https://ex.test/channel/general#msg-",         // empty message id
		"https://ex.test/admin#msg-m1",                 // not a channel/conversation path
		"https://ex.test/channel/general/extra#msg-m1", // too many path segments
		"https://ex.test/channel/#msg-m1",              // empty slug
		"://bad",                                       // unparseable
	}
	for _, u := range cases {
		if p, internal := svc.Preview(context.Background(), "viewer", u); internal || p != nil {
			t.Errorf("%q: expected (nil,false), got internal=%v p=%v", u, internal, p)
		}
	}
}

func TestMessageLink_Preview_EmptyHostDisablesResolver(t *testing.T) {
	svc := NewMessageLinkService("", nil, nil, nil, nil, nil, nil)
	if p, internal := svc.Preview(context.Background(), "viewer", "https://ex.test/channel/general#msg-m1"); internal || p != nil {
		t.Fatalf("empty host should disable resolution: internal=%v p=%v", internal, p)
	}
}

func TestMessageLink_Preview_ChannelLookupError(t *testing.T) {
	svc := NewMessageLinkService("https://ex.test",
		fakeMLChannels{err: errors.New("boom")},
		fakeMLMemberships{}, fakeMLConversations{}, fakeMLMessages{}, fakeMLUsers{}, nil)
	if p, internal := svc.Preview(context.Background(), "viewer", "https://ex.test/channel/general#msg-m1"); !internal || p != nil {
		t.Fatalf("channel error should yield (nil,true): internal=%v p=%v", internal, p)
	}
}

func TestMessageLink_ImageFallbacks(t *testing.T) {
	// Rich (webhook) attachment image wins; a non-image file attachment is skipped.
	svc := NewMessageLinkService("https://ex.test",
		fakeMLChannels{bySlug: map[string]*model.Channel{"general": {ID: "ch-1", Slug: "general"}}},
		fakeMLMemberships{members: map[string]bool{"ch-1#viewer": true}},
		fakeMLConversations{},
		fakeMLMessages{byKey: map[string]*model.Message{
			"ch-1#rich": {ID: "rich", ParentID: "ch-1", AuthorID: "u", MessageAttachments: []model.MessageAttachment{{ImageURL: "https://img/rich.png"}}},
			"ch-1#pdf":  {ID: "pdf", ParentID: "ch-1", AuthorID: "u", AttachmentIDs: []string{"doc"}},
		}},
		fakeMLUsers{byID: map[string]*model.User{"u": {ID: "u", DisplayName: "U"}}},
		fakeMLAttachments{byID: map[string]*model.Attachment{"doc": {ID: "doc", ContentType: "application/pdf", URL: "https://img/doc.pdf"}}},
	)
	rich, _ := svc.Preview(context.Background(), "viewer", "https://ex.test/channel/general#msg-rich")
	if rich == nil || rich.Image != "https://img/rich.png" {
		t.Fatalf("rich attachment image = %#v", rich)
	}
	pdf, _ := svc.Preview(context.Background(), "viewer", "https://ex.test/channel/general#msg-pdf")
	if pdf == nil || pdf.Image != "" {
		t.Fatalf("non-image attachment should not set image: %#v", pdf)
	}
}

func TestMessagePreviewBody_Truncates(t *testing.T) {
	long := strings.Repeat("a", messagePreviewBodyMax+50)
	out := messagePreviewBody(long)
	if !strings.HasSuffix(out, "…") || len([]rune(out)) != messagePreviewBodyMax+1 {
		t.Fatalf("truncation = %d runes", len([]rune(out)))
	}
}
