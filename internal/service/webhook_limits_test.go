package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// The webhook ingress is unauthenticated beyond its secret URL and takes up
// to 1 MiB of payload. Every expensive step — image fetches into S3, user and
// channel lookups — must be bounded by the payload limits, which therefore
// run first.

// countingWebhookUsers resolves nobody but counts what it was asked. It also
// carries a List method so a directory walk would be visible.
type countingWebhookUsers struct {
	mu                         sync.Mutex
	byID, byEmail, search, lst int
	users                      []*model.User
}

func (c *countingWebhookUsers) find(match func(*model.User) bool) *model.User {
	for _, u := range c.users {
		if match(u) {
			return u
		}
	}
	return nil
}

func (c *countingWebhookUsers) GetByID(_ context.Context, id string) (*model.User, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byID++
	if u := c.find(func(u *model.User) bool { return u.ID == id }); u != nil {
		return u, nil
	}
	return nil, store.ErrNotFound
}

func (c *countingWebhookUsers) GetByEmail(_ context.Context, email string) (*model.User, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byEmail++
	if u := c.find(func(u *model.User) bool { return strings.EqualFold(u.Email, email) }); u != nil {
		return u, nil
	}
	return nil, store.ErrNotFound
}

func (c *countingWebhookUsers) Search(_ context.Context, query string, _ int) ([]*model.User, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.search++
	var out []*model.User
	for _, u := range c.users {
		if strings.Contains(strings.ToLower(u.DisplayName), query) || strings.Contains(strings.ToLower(u.Email), query) {
			out = append(out, u)
		}
	}
	return out, nil
}

func (c *countingWebhookUsers) List(context.Context, int, string) ([]*model.User, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lst++
	return nil, "", nil
}

func (c *countingWebhookUsers) lookups() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byID + c.byEmail + c.search + c.lst
}

// countingWebhookImages proxies every image and counts the calls.
type countingWebhookImages struct{ calls atomic.Int32 }

func (c *countingWebhookImages) ProxyImageURL(_ context.Context, raw string) string {
	c.calls.Add(1)
	return "proxied:" + raw
}

func (c *countingWebhookImages) ProxyImageWithSize(_ context.Context, raw string) (string, int, int) {
	c.calls.Add(1)
	return "proxied:" + raw, 10, 10
}

// countingWebhookChannels resolves only its known channels and counts every
// lookup.
type countingWebhookChannels struct {
	fakeWebhookChannels
	calls atomic.Int32
}

func (c *countingWebhookChannels) GetByID(ctx context.Context, id string) (*model.Channel, error) {
	c.calls.Add(1)
	return c.fakeWebhookChannels.GetByID(ctx, id)
}

func (c *countingWebhookChannels) GetBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	c.calls.Add(1)
	return c.fakeWebhookChannels.GetBySlug(ctx, slug)
}

func limitsFixture(t *testing.T, images WebhookImageProxy) (*IncomingWebhookService, *mockMessageStore, *countingWebhookUsers, *countingWebhookChannels) {
	t.Helper()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	channels := &countingWebhookChannels{fakeWebhookChannels: fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch},
		bySlug: map[string]*model.Channel{ch.Slug: ch},
	}}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	wh := &model.IncomingWebhook{ID: "wh", ChannelID: ch.ID, CreatedBy: "creator-1", Username: "Bot", CreatedAt: time.Now()}
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": wh}}, channels, msgSvc, images, "")
	users := &countingWebhookUsers{}
	svc.SetUserResolver(users)
	svc.SetDMResolver(&fakeWebhookDMResolver{})
	svc.SetBotProvisioner(&fakeWebhookBots{})
	return svc, messages, users, channels
}

func TestIncomingWebhookService_ValidatesPayloadBeforeAnyLookupOrFetch(t *testing.T) {
	ctx := context.Background()

	t.Run("too many attachments", func(t *testing.T) {
		images := &countingWebhookImages{}
		svc, messages, users, _ := limitsFixture(t, images)
		atts := make([]model.MessageAttachment, MaxAttachmentsPerMessage+1)
		for i := range atts {
			atts[i] = model.MessageAttachment{
				Text:       "cc @someone",
				AuthorIcon: "https://cdn.example/a.png",
				ImageURL:   fmt.Sprintf("https://cdn.example/%d.png", i),
				ThumbURL:   "https://cdn.example/t.png",
				FooterIcon: "https://cdn.example/f.png",
			}
		}
		_, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "hi @bob", IconURL: "https://cdn.example/i.png", Attachments: atts})
		if !errors.Is(err, ErrTooManyAttachments) {
			t.Fatalf("err = %v, want ErrTooManyAttachments", err)
		}
		if n := images.calls.Load(); n != 0 {
			t.Errorf("fetched %d images for a payload that was going to be refused", n)
		}
		if n := users.lookups(); n != 0 {
			t.Errorf("made %d user lookups for a payload that was going to be refused", n)
		}
		if len(messages.messages) != 0 {
			t.Error("a refused payload was stored")
		}
	})

	t.Run("body too long", func(t *testing.T) {
		images := &countingWebhookImages{}
		svc, _, users, channels := limitsFixture(t, images)
		body := strings.Repeat("@someone ~somewhere ", MaxMessageBodyChars/20+1)
		_, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: body, IconURL: "https://cdn.example/i.png"})
		if err == nil {
			t.Fatal("an over-long body was accepted")
		}
		if users.lookups() != 0 || channels.calls.Load() != 0 || images.calls.Load() != 0 {
			t.Errorf("lookups before validation: users=%d channels=%d images=%d", users.lookups(), channels.calls.Load(), images.calls.Load())
		}
	})

	t.Run("nothing to post", func(t *testing.T) {
		images := &countingWebhookImages{}
		svc, _, users, _ := limitsFixture(t, images)
		_, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Channel: "@bob", IconURL: "https://cdn.example/i.png"})
		if err == nil {
			t.Fatal("an empty payload was accepted")
		}
		if users.lookups() != 0 || images.calls.Load() != 0 {
			t.Errorf("an empty payload resolved its DM target (users=%d) or fetched images (%d)", users.lookups(), images.calls.Load())
		}
	})
}

func TestIncomingWebhookService_CapsMentionLookupsPerRequest(t *testing.T) {
	ctx := context.Background()
	svc, messages, users, channels := limitsFixture(t, &countingWebhookImages{})
	users.users = []*model.User{{ID: "bob-1", DisplayName: "Bob", Email: "bob@example.com"}}

	var text strings.Builder
	text.WriteString("@bob ")
	for i := range 1000 {
		fmt.Fprintf(&text, "@u%04d ~c%04d ", i, i)
	}
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: text.String()}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	// Each distinct user ref costs at most an ID read and a search (no '@'
	// in these, so no email read); each channel ref a slug and an ID read.
	if users.byID > maxWebhookRefLookups || users.search > maxWebhookRefLookups || users.lst != 0 {
		t.Errorf("user lookups byID=%d search=%d list=%d, want at most %d each and no walk",
			users.byID, users.search, users.lst, maxWebhookRefLookups)
	}
	// Plus the one read of the webhook's own channel (the post's target).
	if n := int(channels.calls.Load()); n > 2*maxWebhookRefLookups+1 {
		t.Errorf("channel lookups = %d, want at most %d", n, 2*maxWebhookRefLookups+1)
	}
	body := onlyStoredMessage(t, messages).Body
	if !strings.HasPrefix(body, "@[bob-1|Bob] ") {
		t.Errorf("the first mention was not resolved: %.40q", body)
	}
	// Refs past the budget stay as the sender wrote them.
	if !strings.Contains(body, " @u0999 ~c0999 ") {
		t.Errorf("unresolved refs were not kept verbatim: %.80q", body[len(body)-80:])
	}
}

func TestIncomingWebhookService_LooksUpARepeatedRefOnce(t *testing.T) {
	ctx := context.Background()
	svc, messages, users, channels := limitsFixture(t, &countingWebhookImages{})
	users.users = []*model.User{{ID: "bob-1", DisplayName: "Bob", Email: "bob@example.com"}}
	text := strings.Repeat("@bob ~general @nobody ", 50)
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{
		Text:        text,
		Attachments: []model.MessageAttachment{{Text: "@bob @nobody", Fields: []model.MessageAttachmentField{{Value: "~general"}}}},
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	// "@bob": ID miss + search hit; "@nobody": ID miss + search miss.
	if users.byID != 2 || users.search != 2 {
		t.Errorf("byID=%d search=%d, want each distinct ref looked up once", users.byID, users.search)
	}
	// The post's target channel, then "~general" once.
	if n := channels.calls.Load(); n != 2 {
		t.Errorf("channel lookups = %d, want 2", n)
	}
	msg := onlyStoredMessage(t, messages)
	if !strings.HasPrefix(msg.Body, "@[bob-1|Bob] ~[ch-1|general] @nobody ") {
		t.Errorf("body = %.60q", msg.Body)
	}
	if got := msg.MessageAttachments[0].Text; got != "@[bob-1|Bob] @nobody" {
		t.Errorf("attachment text = %q", got)
	}
}

// An unknown DM target is a miss after the email, ID and search lookups — it
// must never page through the whole user directory.
func TestIncomingWebhookService_UnknownDMTargetNeverWalksTheDirectory(t *testing.T) {
	svc, messages, users, _ := limitsFixture(t, nil)
	for _, target := range []string{"@Nobody Here", "nobody@example.com"} {
		_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{Text: "hi", Channel: target})
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("%s: err = %v, want ErrNotFound", target, err)
		}
	}
	if users.lst != 0 {
		t.Fatalf("the directory was walked %d times", users.lst)
	}
	if users.byEmail != 1 || users.byID != 2 || users.search != 2 {
		t.Fatalf("lookups email=%d id=%d search=%d", users.byEmail, users.byID, users.search)
	}
	if len(messages.messages) != 0 {
		t.Fatal("a message was stored for an unknown target")
	}
}

// rendezvousImages answers only once `need` lookups are in flight at the same
// time — a sequential resolver never gets there and runs into the deadline.
type rendezvousImages struct {
	ctx     context.Context
	need    int32
	arrived atomic.Int32
	all     chan struct{}
}

func (r *rendezvousImages) wait(raw string) string {
	if r.arrived.Add(1) == r.need {
		close(r.all)
	}
	select {
	case <-r.all:
		return "proxied:" + raw
	case <-r.ctx.Done():
		return ""
	}
}

func (r *rendezvousImages) ProxyImageURL(_ context.Context, raw string) string { return r.wait(raw) }

func (r *rendezvousImages) ProxyImageWithSize(_ context.Context, raw string) (string, int, int) {
	return r.wait(raw), 7, 5
}

func TestIncomingWebhookService_ResolvesImagesInParallel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	images := &rendezvousImages{ctx: ctx, need: 5, all: make(chan struct{})}
	svc, messages, _, _ := limitsFixture(t, images)

	if _, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Text:    "deploy",
		IconURL: "https://cdn.example/icon.png",
		Attachments: []model.MessageAttachment{{
			AuthorIcon: "https://cdn.example/author.png",
			ImageURL:   "https://cdn.example/image.png",
			ThumbURL:   "https://cdn.example/thumb.png",
			FooterIcon: "https://cdn.example/footer.png",
		}},
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	msg := onlyStoredMessage(t, messages)
	att := msg.MessageAttachments[0]
	// Each field keeps its own image, whatever order the lookups finished in.
	for _, tc := range [][2]string{
		{msg.WebhookAvatarURL, "proxied:https://cdn.example/icon.png"},
		{att.AuthorIcon, "proxied:https://cdn.example/author.png"},
		{att.ImageURL, "proxied:https://cdn.example/image.png"},
		{att.ThumbURL, "proxied:https://cdn.example/thumb.png"},
		{att.FooterIcon, "proxied:https://cdn.example/footer.png"},
	} {
		if tc[0] != tc[1] {
			t.Errorf("field = %q, want %q (lookups were not concurrent)", tc[0], tc[1])
		}
	}
	if att.ImageWidth != 7 || att.ImageHeight != 5 {
		t.Errorf("image dims = %dx%d", att.ImageWidth, att.ImageHeight)
	}
}

// A second post of the same images is served from the cache record: no S3
// HEAD per image field.
func TestIncomingWebhookService_RepeatedImagesSkipS3Head(t *testing.T) {
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(realPNG1x1)
	}))
	defer imgSrv.Close()
	objects := newFakeImageStore()
	unfurl := newLoopbackUnfurlService(newFakeUnfurlCache())
	unfurl.SetImageStore(objects)
	svc, messages, _, _ := limitsFixture(t, unfurl)

	payload := IncomingWebhookPayload{
		Text:    "deploy",
		IconURL: imgSrv.URL + "/icon.png",
		Attachments: []model.MessageAttachment{
			{AuthorIcon: imgSrv.URL + "/author.png", ImageURL: imgSrv.URL + "/a.png", FooterIcon: imgSrv.URL + "/footer.png"},
			{AuthorIcon: imgSrv.URL + "/author.png", ImageURL: imgSrv.URL + "/b.png", ThumbURL: imgSrv.URL + "/thumb.png"},
		},
	}
	for range 2 {
		if _, err := svc.ExecuteMessage(context.Background(), "wh", payload); err != nil {
			t.Fatalf("Execute: %v", err)
		}
	}
	if len(messages.messages) != 2 {
		t.Fatalf("stored %d messages", len(messages.messages))
	}
	// 6 distinct images; "author.png" may be looked up by both attachments
	// of the first post at once, so 6 or 7 HEADs — and none on the second.
	if objects.headCalls < 6 || objects.headCalls > 7 {
		t.Fatalf("headCalls = %d, want one per distinct image of the first post only", objects.headCalls)
	}
	for _, m := range messages.messages {
		if m.MessageAttachments[1].ImageWidth != 1 || m.MessageAttachments[0].ImageURL == "" {
			t.Fatalf("attachments = %#v", m.MessageAttachments)
		}
	}
}
