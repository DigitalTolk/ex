package service

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// What an interactive message or form costs ex on someone's behalf: user
// lookups and image fetches. Each is bounded, and none is spent on a
// request that is refused anyway.

// countingUsers is a directory that counts every lookup made of it.
type countingUsers struct {
	fakeWebhookUsers
	mu      sync.Mutex
	byID    int
	byEmail int
	search  int
}

func (c *countingUsers) GetByID(ctx context.Context, id string) (*model.User, error) {
	c.mu.Lock()
	c.byID++
	c.mu.Unlock()
	return c.fakeWebhookUsers.GetByID(ctx, id)
}

func (c *countingUsers) GetByEmail(ctx context.Context, email string) (*model.User, error) {
	c.mu.Lock()
	c.byEmail++
	c.mu.Unlock()
	return c.fakeWebhookUsers.GetByEmail(ctx, email)
}

func (c *countingUsers) Search(ctx context.Context, q string, limit int) ([]*model.User, error) {
	c.mu.Lock()
	c.search++
	c.mu.Unlock()
	return c.fakeWebhookUsers.Search(ctx, q, limit)
}

func (c *countingUsers) lookups() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byID + c.byEmail + c.search
}

func (c *countingUsers) idLookups() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byID
}

func newCountingUsers(users ...*model.User) *countingUsers {
	return &countingUsers{fakeWebhookUsers: fakeWebhookUsers{users: users}}
}

// countingImages is an image proxy that counts each address it fetches.
type countingImages struct {
	mu      sync.Mutex
	fetched map[string]int
}

func (c *countingImages) ProxyImageURL(_ context.Context, raw string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fetched == nil {
		c.fetched = map[string]int{}
	}
	c.fetched[raw]++
	return "/api/v1/media/proxied/" + raw
}

func (c *countingImages) ProxyImageWithSize(ctx context.Context, raw string) (string, int, int) {
	return c.ProxyImageURL(ctx, raw), 64, 48
}

func (c *countingImages) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, k := range c.fetched {
		n += k
	}
	return n
}

func virpal() *model.User {
	return &model.User{ID: "u-1", DisplayName: "Virpal", Email: "virpal@ex.test"}
}

// ---- posting

func TestIncomingWebhook_AnUnauthorizedPostWithAppElementsCostsNoLookupsOrFetches(t *testing.T) {
	ctx := context.Background()
	users := newCountingUsers(virpal())
	svc, messages := blocksWebhookFixture(users)
	pics := &countingImages{}
	svc.images = pics
	who := model.BlockElement{Type: model.ElementUsersSelect, ActionID: "who", InitialUser: "virpal@ex.test"}
	vote := btn("vote", "Vote")
	vote.ExAction = model.ExActionVote
	vote.AllowedUsers = []string{"virpal@ex.test", "u-1"}
	picker := IncomingWebhookPayload{Text: "Owner? @virpal@ex.test <@virpal@ex.test>", Blocks: model.Blocks{
		{Type: model.BlockSection, Text: md("Who owns A3, @virpal@ex.test?"), Accessory: &who},
		{Type: model.BlockImage, ImageURL: "https://img.ex.test/chart.png", AltText: "chart"},
		{Type: model.BlockActions, Elements: []model.BlockElement{vote}},
	}}
	// An app button in a card counts too.
	cardButton := IncomingWebhookPayload{Text: "@virpal@ex.test", Attachments: []model.MessageAttachment{{Blocks: model.Blocks{
		{Type: model.BlockImage, ImageURL: "https://img.ex.test/card.png", AltText: "card"},
		{Type: model.BlockActions, Elements: []model.BlockElement{btn("go", "Go")}},
	}}}}
	for name, p := range map[string]IncomingWebhookPayload{"a picker": picker, "an app button in a card": cardButton} {
		if _, err := svc.ExecuteMessage(ctx, "wh", p); !errors.Is(err, ErrBotTokenRequired) {
			t.Fatalf("%s without the bot token: %v", name, err)
		}
	}
	if n := users.lookups(); n != 0 {
		t.Fatalf("a refused post looked up %d people", n)
	}
	if n := pics.total(); n != 0 {
		t.Fatalf("a refused post fetched %d images", n)
	}
	if len(messages.messages) != 0 {
		t.Fatalf("a refused post posted %d messages", len(messages.messages))
	}

	// With the app's token the same post goes through — and does look
	// people up and fetch its image, so the counts above are real.
	token, hash := newBotToken()
	svc.store.(*fakeWebhookStore).items["wh"].BotTokenHash = hash
	picker.BotToken = token
	if _, err := svc.ExecuteMessage(ctx, "wh", picker); err != nil {
		t.Fatalf("with the bot token: %v", err)
	}
	if users.lookups() == 0 || pics.total() != 1 {
		t.Fatalf("authorized post: %d lookups, %d fetches", users.lookups(), pics.total())
	}
	m := onlyStoredMessage(t, messages)
	if m.Blocks[0].Accessory.InitialUser != "u-1" || m.Body != "Owner? @[u-1|Virpal] @[u-1|Virpal]" {
		t.Fatalf("stored = %q %+v", m.Body, m.Blocks[0].Accessory)
	}
}

func TestIncomingWebhook_EmailMentionsResolveAndUnknownOnesStayAsText(t *testing.T) {
	svc, messages := blocksWebhookFixture(fakeWebhookUsers{users: []*model.User{
		virpal(), {ID: "u-2", Email: "manisha@ex.test"},
	}})
	_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		// @virpal@other.example is a stranger who shares a name with Virpal:
		// it must not become a mention of Virpal.
		Text: "@virpal@ex.test and (@MANISHA@ex.test), not @stranger@else.test, @virpal@other.example or mail@virpal@ex.test",
		Blocks: model.Blocks{
			{Type: model.BlockSection, Text: md("Owner: @virpal@ex.test.")},
			{Type: model.BlockSection, Text: plain("Plain @virpal@ex.test")},
		},
	})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	m := onlyStoredMessage(t, messages)
	// Someone with no display name is mentioned by their address.
	if m.Body != "@[u-1|Virpal] and (@[u-2|manisha@ex.test]), not @stranger@else.test, @virpal@other.example or mail@virpal@ex.test" {
		t.Fatalf("body = %q", m.Body)
	}
	// A markdown block mentions; a plain one is shown as typed.
	if got := m.Blocks[0].Text.Text; got != "Owner: @[u-1|Virpal]." {
		t.Fatalf("markdown block = %q", got)
	}
	if got := m.Blocks[1].Text.Text; got != "Plain @virpal@ex.test" {
		t.Fatalf("plain block = %q", got)
	}
}

func TestIncomingWebhook_AMessageHoldsAtMost20Images(t *testing.T) {
	ctx := context.Background()
	images := func(n int) model.Blocks {
		out := make(model.Blocks, n)
		for i := range out {
			out[i] = model.Block{Type: model.BlockImage, ImageURL: "https://img.ex.test/" + strconv.Itoa(i) + ".png", AltText: "pic"}
		}
		return out
	}
	svc, messages := blocksWebhookFixture(nil)
	pics := &countingImages{}
	svc.images = pics
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Blocks: images(maxImages)}); err != nil {
		t.Fatalf("20 images: %v", err)
	}
	if m := onlyStoredMessage(t, messages); len(m.Blocks) != maxImages || pics.total() != maxImages {
		t.Fatalf("20 images: %d blocks, %d fetches", len(m.Blocks), pics.total())
	}

	// The 21st — in the message, or in a card, or as an accessory or a
	// context picture — is refused, and nothing is fetched.
	pic := model.BlockElement{Type: model.ElementImage, ImageURL: "https://img.ex.test/x.png", AltText: "x"}
	for name, p := range map[string]IncomingWebhookPayload{
		"21 image blocks":    {Blocks: images(maxImages + 1)},
		"one more in a card": {Blocks: images(maxImages - 1), Attachments: []model.MessageAttachment{{Blocks: images(2)}}},
		"an accessory":       {Blocks: append(images(maxImages), model.Block{Type: model.BlockSection, Text: plain("s"), Accessory: &pic})},
		"a context picture":  {Blocks: append(images(maxImages), model.Block{Type: model.BlockContext, Elements: []model.BlockElement{pic}})},
	} {
		svc, messages := blocksWebhookFixture(nil)
		pics := &countingImages{}
		svc.images = pics
		_, err := svc.ExecuteMessage(ctx, "wh", p)
		wantInvalid(t, err, "a message or form can hold at most 20 images")
		if pics.total() != 0 || len(messages.messages) != 0 {
			t.Fatalf("%s: %d fetches, %d messages", name, pics.total(), len(messages.messages))
		}
	}

	// A form is held to the same.
	form := model.View{Type: model.ViewModal, Title: *plain("Pictures"), Blocks: images(maxImages + 1)}
	if _, err := normalizeView(t, form); !errors.Is(err, ErrInvalidView) || !strings.Contains(err.Error(), "at most 20 images") {
		t.Fatalf("a form of 21 images: %v", err)
	}
}

func TestIncomingWebhook_EachImageAddressIsFetchedOnce(t *testing.T) {
	svc, messages := blocksWebhookFixture(nil)
	pics := &countingImages{}
	svc.images = pics
	logo := "https://img.ex.test/logo.png"
	pic := model.BlockElement{Type: model.ElementImage, ImageURL: logo, AltText: "logo"}
	_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Blocks: model.Blocks{
			{Type: model.BlockImage, ImageURL: logo, AltText: "logo"},
			{Type: model.BlockSection, Text: plain("s"), Accessory: &pic},
			{Type: model.BlockContext, Elements: []model.BlockElement{pic, pic}},
		},
		Attachments: []model.MessageAttachment{{Blocks: model.Blocks{{Type: model.BlockImage, ImageURL: logo, AltText: "logo"}}}},
	})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if pics.fetched[logo] != 1 || pics.total() != 1 {
		t.Fatalf("fetches = %v", pics.fetched)
	}
	m := onlyStoredMessage(t, messages)
	want := "/api/v1/media/proxied/" + logo
	if m.Blocks[0].ImageURL != want || m.Blocks[0].ImageWidth != 64 || m.Blocks[1].Accessory.ImageURL != want ||
		m.Blocks[2].Elements[1].ImageURL != want || m.MessageAttachments[0].Blocks[0].ImageURL != want {
		t.Fatalf("every use shows the one proxied copy: %+v / %+v", m.Blocks, m.MessageAttachments)
	}
}

func TestIncomingWebhook_WithoutAnImageStoreEveryImageIsDropped(t *testing.T) {
	svc, messages := blocksWebhookFixture(nil)
	svc.images = nil
	pic := model.BlockElement{Type: model.ElementImage, ImageURL: "https://img.ex.test/a.png", AltText: "a"}
	_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Text: "Report",
		Blocks: model.Blocks{
			{Type: model.BlockImage, ImageURL: "https://img.ex.test/chart.png", AltText: "chart"},
			{Type: model.BlockSection, BlockID: "s", Text: plain("Summary"), Accessory: &pic},
			{Type: model.BlockContext, BlockID: "c", Elements: []model.BlockElement{pic, {Type: model.TextPlain, Content: "by Virpal"}}},
		},
		Attachments: []model.MessageAttachment{{Text: "card", Blocks: model.Blocks{{Type: model.BlockImage, ImageURL: "https://img.ex.test/card.png", AltText: "card"}}}},
	})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	// The app's address never reaches a client: it would see who reads.
	m := onlyStoredMessage(t, messages)
	if len(m.Blocks) != 2 || m.Blocks[0].BlockID != "s" || m.Blocks[0].Accessory != nil || len(m.Blocks[1].Elements) != 1 || m.Blocks[1].Elements[0].Content != "by Virpal" {
		t.Fatalf("blocks = %+v", m.Blocks)
	}
	if m.MessageAttachments[0].Blocks != nil {
		t.Fatalf("card blocks = %+v", m.MessageAttachments[0].Blocks)
	}
	raw, _ := json.Marshal(m)
	if strings.Contains(string(raw), "img.ex.test") {
		t.Fatalf("an app image address was kept: %s", raw)
	}
}

// ---- values a browser sends

func TestRawValue_AListOfMoreThan100IsRefusedUnread(t *testing.T) {
	items := make([]string, maxRawValues+1)
	for i := range items {
		items[i] = "u-" + strconv.Itoa(i)
	}
	body, _ := json.Marshal(items)
	var got RawValue
	if err := json.Unmarshal(body, &got); err == nil || err.Error() != "a value can list at most 100 items" || got != nil {
		t.Fatalf("101 items: %v %v", got, err)
	}
	body, _ = json.Marshal(items[:maxRawValues])
	if err := json.Unmarshal(body, &got); err != nil || len(got) != maxRawValues {
		t.Fatalf("100 items: %d %v", len(got), err)
	}
}

func TestReadMulti_ALongListIsRefusedBeforeAnyLookupAndRepeatsCountOnce(t *testing.T) {
	people := model.BlockElement{Type: model.ElementMultiUsersSelect, ActionID: "team"}
	checks := 0
	users := func(id string) bool { checks++; return id != "u-gone" }

	long := make(RawValue, maxRawValues+1)
	for i := range long {
		long[i] = "u-" + strconv.Itoa(i)
	}
	if _, _, problem := readValue(people, long, users); problem != "Choose at most 100." || checks != 0 {
		t.Fatalf("101 people: %q after %d checks", problem, checks)
	}

	// A list of the same few, repeated, is read as those few: each is
	// checked once.
	repeated := make(RawValue, maxRawValues)
	for i := range repeated {
		repeated[i] = []string{"u-1", "u-2", " "}[i%3]
	}
	v, empty, problem := readValue(people, repeated, users)
	if problem != "" || empty || strings.Join(v.SelectedUsers, ",") != "u-1,u-2" || checks != 2 {
		t.Fatalf("repeats: %+v %v %q after %d checks", v, empty, problem, checks)
	}
	// One person who can't be picked refuses the list.
	if _, _, problem := readValue(people, RawValue{"u-1", "u-gone"}, users); problem != "Pick people from the list." {
		t.Fatalf("someone gone: %q", problem)
	}
}

func TestPickableUser_LooksEachPersonUpOnceAndAtMost150(t *testing.T) {
	f := newIxFixture(t)
	all := make([]*model.User, maxUserChecks+5)
	for i := range all {
		all[i] = &model.User{ID: "u-" + strconv.Itoa(i)}
	}
	all[3].Status = "deactivated"
	users := newCountingUsers(all...)
	f.svc.webhooks.SetUserResolver(users)
	pick := f.svc.pickableUser(context.Background())

	for range 3 {
		if !pick("u-0") || pick("u-3") {
			t.Fatal("an active person refused, or a deactivated one accepted")
		}
	}
	if users.idLookups() != 2 {
		t.Fatalf("repeats looked up again: %d lookups", users.idLookups())
	}
	for i := range maxUserChecks {
		pick("u-" + strconv.Itoa(i))
	}
	if users.idLookups() != maxUserChecks {
		t.Fatalf("%d lookups for %d people", users.idLookups(), maxUserChecks)
	}
	// Past 150 no one more counts, and no one more is looked up — even
	// someone who exists.
	if pick("u-" + strconv.Itoa(maxUserChecks)) {
		t.Fatal("the 151st person was pickable")
	}
	if users.idLookups() != maxUserChecks {
		t.Fatalf("looked up past the cap: %d", users.idLookups())
	}
	// Those already seen still answer.
	if !pick("u-1") {
		t.Fatal("someone already checked was forgotten")
	}
	// Each request starts afresh.
	if !f.svc.pickableUser(context.Background())("u-" + strconv.Itoa(maxUserChecks)) {
		t.Fatal("a new request is held to the old one's budget")
	}
}

// ---- clicks

func pickerCard(f *ixFixture) {
	team := model.BlockElement{Type: model.ElementMultiUsersSelect, ActionID: "team"}
	m := appMessage()
	m.Blocks = append(m.Blocks, model.Block{Type: model.BlockSection, BlockID: "pick", Text: plain("Team"), Accessory: &team})
	f.messages.messages["ch1#m1"] = m
}

func TestClick_OverBudgetOrPausedAPickCostsNoLookup(t *testing.T) {
	f := newIxFixture(t)
	pickerCard(f)
	users := newCountingUsers(virpal())
	f.svc.webhooks.SetUserResolver(users)
	ctx := context.Background()
	pick := func() error {
		_, err := f.msgs.ActWithValue(ctx, "u-1", "ch1", ParentChannel, "m1", "pick", "team", RawValue{"u-1"})
		return err
	}

	f.limiter.deny = true
	if err := pick(); !errors.Is(err, ErrClickRateLimited) {
		t.Fatalf("over budget: %v", err)
	}
	f.limiter.deny = false
	f.wh.AdminPaused = true
	if err := pick(); !errors.Is(err, ErrAppUnavailable) {
		t.Fatalf("paused: %v", err)
	}
	f.wh.AdminPaused = false
	if n := users.lookups(); n != 0 || len(f.app.bodies) != 0 {
		t.Fatalf("a refused pick cost %d lookups and %d requests", n, len(f.app.bodies))
	}

	// Within budget the pick is checked — the person looked up — and sent.
	if err := pick(); err != nil {
		t.Fatalf("pick: %v", err)
	}
	if users.idLookups() == 0 || len(f.app.bodies) != 1 || strings.Join(f.app.got[0].Actions[0].SelectedUsers, ",") != "u-1" {
		t.Fatalf("pick: %d lookups, %d requests", users.idLookups(), len(f.app.bodies))
	}
}

func TestClick_A101PersonPickIsRefusedBeforeAnyLookup(t *testing.T) {
	f := newIxFixture(t)
	pickerCard(f)
	users := newCountingUsers(virpal())
	f.svc.webhooks.SetUserResolver(users)
	long := make(RawValue, maxRawValues+1)
	for i := range long {
		long[i] = "u-1"
	}
	_, err := f.msgs.ActWithValue(context.Background(), "u-1", "ch1", ParentChannel, "m1", "pick", "team", long)
	if msg, _ := apperr.Message(err, apperr.ErrValidation); msg != "Choose at most 100." {
		t.Fatalf("101 people: %v", err)
	}
	if users.lookups() != 0 || len(f.app.bodies) != 0 {
		t.Fatalf("refused pick: %d lookups, %d requests", users.lookups(), len(f.app.bodies))
	}
}
