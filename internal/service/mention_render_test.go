package service

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

type fakeMentionResolver struct {
	names       MentionNames
	err         error
	calls       int
	gotUsers    []string
	gotChannels []string
}

func (f *fakeMentionResolver) ResolveMentions(_ context.Context, userIDs, channelIDs []string) (MentionNames, error) {
	f.calls++
	f.gotUsers = append(f.gotUsers, userIDs...)
	f.gotChannels = append(f.gotChannels, channelIDs...)
	return f.names, f.err
}

func mentionService(r MentionResolver) *MessageService {
	svc, _, _, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	if r != nil {
		svc.SetMentionResolver(r)
	}
	return svc
}

var bobAndGeneral = MentionNames{
	Users:    map[string]string{"u-bob": "Bob"},
	Channels: map[string]string{"ch-1": "general"},
}

// The pill shows who is actually notified: the typed half of the syntax is
// whatever the poster wrote, so "@[bobID|Alice]" must read "@Bob".
func TestRenderedMentionsShowTheCurrentNameForTheID(t *testing.T) {
	r := &fakeMentionResolver{names: bobAndGeneral}
	svc := mentionService(r)
	msg := &model.Message{ID: "m-1", Body: "hi @[u-bob|Alice] see ~[ch-1|wrong-slug]"}
	svc.attachRendered(context.Background(), msg)

	user := findFirstByTag(msg.Rendered, "ex-mention-user")
	if user == nil || user.Properties["data-name"] != "Bob" || user.Properties["data-value"] != "@[u-bob|Bob]" {
		t.Fatalf("user pill = %+v", user)
	}
	ch := findFirstByTag(msg.Rendered, "ex-mention-channel")
	if ch == nil || ch.Properties["data-slug"] != "general" || ch.Properties["data-value"] != "~[ch-1|general]" {
		t.Fatalf("channel pill = %+v", ch)
	}
}

func TestRenderedMentionsOfUnknownIDsBecomePlainText(t *testing.T) {
	svc := mentionService(&fakeMentionResolver{names: bobAndGeneral})
	msg := &model.Message{ID: "m-1", Body: "hi @[u-ghost|Alice] and ~[ch-ghost|secret] ok"}
	svc.attachRendered(context.Background(), msg)

	if el := findFirstByTag(msg.Rendered, "ex-mention-user"); el != nil {
		t.Errorf("unknown user still a pill: %+v", el)
	}
	if el := findFirstByTag(msg.Rendered, "ex-mention-channel"); el != nil {
		t.Errorf("unknown channel still a pill: %+v", el)
	}
	p := findFirstByTag(msg.Rendered, "p")
	// The fallback text merges with its neighbours into one text run.
	want := []*HastNode{{Type: "text", Value: "hi @Alice and ~secret ok"}}
	if !reflect.DeepEqual(p.Children, want) {
		t.Errorf("paragraph children = %+v", p.Children)
	}
}

// One lookup per batch, however many messages and repeats it holds; IDs
// that are blank never reach the store.
func TestRenderedMentionsResolveInOneBatchedLookup(t *testing.T) {
	r := &fakeMentionResolver{names: bobAndGeneral}
	svc := mentionService(r)
	a := &model.Message{ID: "a", Body: "@[u-bob|x] @[u-bob|y] ~[ch-1|general]"}
	b := &model.Message{ID: "b", Body: "**@[u-carol|Carol]** ~[ch-1|general] @[ |blank]"}
	svc.attachRendered(context.Background(), a, nil, b)

	if r.calls != 1 {
		t.Fatalf("resolver calls = %d, want 1", r.calls)
	}
	if !reflect.DeepEqual(r.gotUsers, []string{"u-bob", "u-carol"}) || !reflect.DeepEqual(r.gotChannels, []string{"ch-1"}) {
		t.Errorf("looked up users=%v channels=%v", r.gotUsers, r.gotChannels)
	}
	// u-carol is unknown → plain text, even nested inside <strong>; the
	// blank-ID mention too. The known channel stays a pill.
	if got := allText(findFirstByTag(b.Rendered, "strong")); got != "@Carol" {
		t.Errorf("strong text = %q", got)
	}
	if el := findFirstByTag(b.Rendered, "ex-mention-user"); el != nil {
		t.Errorf("unknown user still a pill: %+v", el)
	}
	if el := findFirstByTag(b.Rendered, "ex-mention-channel"); el == nil || el.Properties["data-slug"] != "general" {
		t.Errorf("channel pill = %+v", el)
	}
	if got := allText(b.Rendered); got != "@Carol  @blank" { // the pill itself has no text node
		t.Errorf("b text = %q", got)
	}
}

func TestRenderedMentionsSkipTheLookupWithoutMentions(t *testing.T) {
	r := &fakeMentionResolver{names: bobAndGeneral}
	svc := mentionService(r)
	svc.attachRendered(context.Background(), &model.Message{ID: "m", Body: "no pills here, @all and #tag"})
	if r.calls != 0 {
		t.Errorf("resolver called %d times for a batch with no mentions", r.calls)
	}
}

// An unverified typed name never renders as a pill: when the lookup fails,
// every mention in the batch degrades to plain text.
func TestRenderedMentionsOnLookupErrorBecomePlainText(t *testing.T) {
	r := &fakeMentionResolver{names: bobAndGeneral, err: errors.New("dynamo down")}
	svc := mentionService(r)
	msg := &model.Message{ID: "m", Body: "hi @[u-bob|Alice] ~[ch-1|general]"}
	svc.attachRendered(context.Background(), msg)
	if findFirstByTag(msg.Rendered, "ex-mention-user") != nil || findFirstByTag(msg.Rendered, "ex-mention-channel") != nil {
		t.Fatalf("pills survived a failed lookup: %+v", msg.Rendered)
	}
	if got := allText(msg.Rendered); got != "hi @Alice ~general" {
		t.Errorf("text = %q", got)
	}
}

func TestRenderedMentionsWithoutResolverKeepTheTree(t *testing.T) {
	svc := mentionService(nil)
	msg := &model.Message{ID: "m", Body: "hi @[u-bob|Alice]"}
	svc.attachRendered(context.Background(), msg)
	if user := findFirstByTag(msg.Rendered, "ex-mention-user"); user == nil || user.Properties["data-name"] != "Alice" {
		t.Errorf("user pill = %+v", user)
	}
}

// End to end through a read path: the listed message carries resolved pills.
func TestMessageListResolvesMentionPills(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	r := &fakeMentionResolver{names: bobAndGeneral}
	svc.SetMentionResolver(r)
	ctx := context.Background()
	memberships.memberships["ch-r#u-alice"] = &model.ChannelMembership{ChannelID: "ch-r", UserID: "u-alice", Role: model.ChannelRoleMember}
	messages.messages["ch-r#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-r", AuthorID: "u-alice", Body: "ping @[u-bob|Alice]"}

	listed, _, err := svc.List(ctx, "u-alice", "ch-r", ParentChannel, "", 50)
	if err != nil || len(listed) != 1 {
		t.Fatalf("List = %v, %v", listed, err)
	}
	if user := findFirstByTag(listed[0].Rendered, "ex-mention-user"); user == nil || user.Properties["data-name"] != "Bob" {
		t.Errorf("listed pill = %+v", user)
	}
	if r.calls != 1 {
		t.Errorf("resolver calls = %d, want 1", r.calls)
	}
}

// A channel mention's slug half is limited to the slug charset, so a typed
// path can never reach the pill's href.
func TestChannelMentionSlugCharset(t *testing.T) {
	r := NewMarkdownRenderer()
	for _, body := range []string{
		"~[x|../../auth/desktop/complete?code=X]",
		"~[x|General]",
		"~[x|a b]",
		"~[x|-lead]",
	} {
		if el := findFirstByTag(r.RenderToHast(body), "ex-mention-channel"); el != nil {
			t.Errorf("%q tokenized as a channel mention: %+v", body, el)
		}
	}
	el := findFirstByTag(r.RenderToHast("~[ch-1|dev-ops2]"), "ex-mention-channel")
	if el == nil || el.Properties["data-slug"] != "dev-ops2" {
		t.Errorf("valid slug: %+v", el)
	}
}

type fakeMentionUsers struct {
	users []*model.User
	err   error
	got   []string
}

func (f *fakeMentionUsers) GetBatch(_ context.Context, ids []string) ([]*model.User, error) {
	f.got = ids
	return f.users, f.err
}

type fakeMentionChannels struct {
	channels []*model.Channel
	err      error
	got      []string
}

func (f *fakeMentionChannels) GetChannelsByIDs(_ context.Context, ids []string) ([]*model.Channel, error) {
	f.got = ids
	return f.channels, f.err
}

func TestMentionDirectoryResolvesUsersAndChannels(t *testing.T) {
	users := &fakeMentionUsers{users: []*model.User{
		{ID: "u-bob", DisplayName: "Bob"},
		{ID: "u-noname"}, // no display name: treated as unknown
	}}
	chans := &fakeMentionChannels{channels: []*model.Channel{
		{ID: "ch-1", Slug: "general"},
		{ID: "ch-noslug"},
	}}
	d := NewMentionDirectory(users, chans)
	names, err := d.ResolveMentions(context.Background(), []string{"u-bob", "u-noname"}, []string{"ch-1", "ch-noslug"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(names.Users, map[string]string{"u-bob": "Bob"}) {
		t.Errorf("users = %v", names.Users)
	}
	if !reflect.DeepEqual(names.Channels, map[string]string{"ch-1": "general"}) {
		t.Errorf("channels = %v", names.Channels)
	}
}

func TestMentionDirectorySkipsEmptyHalves(t *testing.T) {
	users := &fakeMentionUsers{err: errors.New("must not be called")}
	chans := &fakeMentionChannels{err: errors.New("must not be called")}
	d := NewMentionDirectory(users, chans)
	names, err := d.ResolveMentions(context.Background(), nil, nil)
	if err != nil || users.got != nil || chans.got != nil {
		t.Fatalf("names=%v err=%v users.got=%v chans.got=%v", names, err, users.got, chans.got)
	}
}

func TestMentionDirectoryPropagatesLookupErrors(t *testing.T) {
	boom := errors.New("boom")
	d := NewMentionDirectory(&fakeMentionUsers{err: boom}, &fakeMentionChannels{})
	if _, err := d.ResolveMentions(context.Background(), []string{"u"}, nil); !errors.Is(err, boom) {
		t.Errorf("user error = %v", err)
	}
	d = NewMentionDirectory(&fakeMentionUsers{}, &fakeMentionChannels{err: boom})
	if _, err := d.ResolveMentions(context.Background(), nil, []string{"c"}); !errors.Is(err, boom) {
		t.Errorf("channel error = %v", err)
	}
}
