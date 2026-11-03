package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// Classic webhooks must keep behaving exactly as they did before rich
// webhooks existed. This test runs a corpus of classic posts — ordinary,
// odd and broken — through POST /hooks/{id} and compares, byte for byte,
// the status, the answer and every message stored with a golden file
// recorded from origin/main (before rich webhooks). It deliberately uses
// only APIs main also has, so the same file records the golden there:
//
//	CLASSIC_COMPAT_WRITE=1 go test ./internal/handler -run TestClassicWebhooksBehaveAsBefore
//
// Never regenerate the golden from this branch to make the test pass: a
// difference here is a classic sender seeing something new.
const classicCompatGolden = "testdata/classic_webhook_compat.golden.json"

type compatUsers struct{ users []*model.User }

func (c compatUsers) GetByID(_ context.Context, id string) (*model.User, error) {
	for _, u := range c.users {
		if u.ID == id {
			return u, nil
		}
	}
	return nil, errCompatNotFound
}

func (c compatUsers) GetByEmail(_ context.Context, email string) (*model.User, error) {
	for _, u := range c.users {
		if strings.EqualFold(u.Email, email) {
			return u, nil
		}
	}
	return nil, errCompatNotFound
}

func (c compatUsers) Search(_ context.Context, query string, limit int) ([]*model.User, error) {
	var out []*model.User
	for _, u := range c.users {
		if strings.Contains(strings.ToLower(u.DisplayName+" "+u.Email), strings.ToLower(query)) && len(out) < limit {
			out = append(out, u)
		}
	}
	return out, nil
}

type compatError string

func (e compatError) Error() string { return string(e) }

const errCompatNotFound = compatError("not found")

type compatCase struct {
	Name        string `json:"name"`
	Hook        string `json:"hook"`
	ContentType string `json:"contentType"`
	Accept      string `json:"accept,omitempty"`
	Auth        string `json:"auth,omitempty"`
	Body        string `json:"body"`
}

type compatResult struct {
	Name     string   `json:"name"`
	Status   int      `json:"status"`
	Type     string   `json:"type"`
	Answer   string   `json:"answer"`
	Messages []string `json:"messages"`
}

func compatCorpus() []compatCase {
	j := func(name, body string) compatCase {
		return compatCase{Name: name, Hook: "open", ContentType: "application/json", Body: body}
	}
	form := func(name string, values url.Values) compatCase {
		return compatCase{Name: name, Hook: "open", ContentType: "application/x-www-form-urlencoded", Body: values.Encode()}
	}
	cases := []compatCase{
		j("plain text", `{"text":"Build #1432 passed on main"}`),
		j("markdown and links", `{"text":"**Deploy** done: <https://ci.test/builds/1|build 1> and [notes](https://ci.test/notes)"}`),
		j("mentions", `{"text":"cc @alice, <@u-bob>, <@alice@example.com>, @nobody and <!channel> <!here> <!all>"}`),
		j("mention by email", `{"text":"cc @alice@example.com and @ghost@example.com"}`),
		j("channels", `{"text":"see ~builds and <#builds|builds> and <#nowhere|elsewhere>"}`),
		j("identity", `{"text":"hi","username":"CI bot","icon_url":"https://cdn.test/bot.png"}`),
		j("icon emoji with colons", `{"text":"hi","icon_emoji":":tada:"}`),
		j("icon emoji bare", `{"text":"hi","icon_emoji":"rocket"}`),
		j("icon emoji and url", `{"text":"hi","icon_emoji":"rocket","icon_url":"https://cdn.test/bot.png"}`),
		j("attachment", `{"text":"report","attachments":[{"color":"#36a64f","pretext":"for @alice","title":"Build","title_link":"https://ci.test/1","text":"All good","fields":[{"title":"Branch","value":"main","short":true}],"image_url":"https://cdn.test/chart.png","thumb_url":"https://cdn.test/t.png","footer":"CI","author_name":"ci","author_link":"javascript:alert(1)"}]}`),
		j("attachment only", `{"attachments":[{"title":"No text, just a card","text":"body"}]}`),
		j("attachment long footer", `{"text":"x","attachments":[{"footer":"`+strings.Repeat("f", 400)+`"}]}`),
		j("attachment with blocks", `{"text":"card","attachments":[{"title":"t","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"inside"}}]}]}`),
		j("attachment with odd blocks", `{"text":"card","attachments":[{"title":"t","blocks":"not a list"}]}`),
		j("slack blocks", `{"text":"fallback","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*hi*"}},{"type":"actions","elements":[{"type":"button","action_id":"a","text":{"type":"plain_text","text":"Go"}}]}]}`),
		j("slack rich_text blocks", `{"text":"fallback","blocks":[{"type":"rich_text","elements":[{"type":"rich_text_section","elements":[{"type":"text","text":"hi","style":{"bold":true}}]}]}]}`),
		j("blocks of the wrong type", `{"text":"fallback","blocks":"nope"}`),
		j("blocks as an object", `{"text":"fallback","blocks":{"a":1}}`),
		j("blocks only", `{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"only blocks"}}]}`),
		j("stray template and data", `{"text":"hello","template":5,"data":"x"}`),
		j("stray template object", `{"text":"hello","template":{"name":"t"},"data":[1,2]}`),
		j("mattermost extras", `{"text":"hello","type":"custom_x","props":{"card":"x"},"priority":{"priority":"important"}}`),
		j("empty payload", `{}`),
		j("empty text", `{"text":""}`),
		j("whitespace text", `{"text":"   "}`),
		j("text too long", `{"text":"`+strings.Repeat("a", 16385)+`"}`),
		j("too many attachments", `{"text":"x","attachments":[{},{},{},{},{},{},{},{},{},{},{}]}`),
		j("invalid json", `{"text":`),
		j("not an object", `["text"]`),
		j("text of the wrong type", `{"text":5}`),
		j("unknown root", `{"text":"reply","root_id":"01NOTAREALMESSAGE000000000"}`),
		j("channel override", `{"text":"elsewhere","channel":"#builds"}`),
		j("channel override by slug", `{"text":"elsewhere","channel":"builds"}`),
		j("unknown channel", `{"text":"elsewhere","channel":"#nowhere"}`),
		j("direct message", `{"text":"psst","channel":"@alice"}`),
		form("form payload", url.Values{"payload": {`{"text":"from a form","username":"form bot"}`}}),
		form("form payload with blocks", url.Values{"payload": {`{"text":"form","blocks":"nope","template":7}`}}),
		form("form fields", url.Values{"text": {"plain form"}, "channel": {"#builds"}, "username": {"bot"}, "icon_url": {"https://cdn.test/i.png"}}),
		{Name: "raw payload= body", Hook: "open", ContentType: "text/plain", Body: `payload={"text":"raw"}`},
		j("attachment title of the wrong type", `{"text":"x","attachments":[{"title":5}]}`),
		j("attachment fields of the wrong type", `{"text":"x","attachments":[{"fields":"x"}]}`),
		j("attachment field short of the wrong type", `{"text":"x","attachments":[{"fields":[{"title":"a","short":"yes"}]}]}`),
		j("attachments of the wrong type", `{"text":"x","attachments":{"title":"t"}}`),
		j("icon emoji of the wrong type", `{"text":"x","icon_emoji":5}`),
		j("channel of the wrong type", `{"text":"x","channel":["builds"]}`),
		j("root id of the wrong type", `{"text":"x","root_id":1}`),
		j("trailing garbage", `{"text":"x"} junk`),
		j("body over a megabyte", `{"text":"`+strings.Repeat("a", 1<<20)+`"}`),
		j("unicode and emoji text", `{"text":"Résumé ✅ — naïve 🎉 <!channel>"}`),
		j("html in text", `{"text":"<script>alert(1)</script> & <b>bold</b>"}`),
	}
	locked := j("locked webhook overrides channel", `{"text":"stay","channel":"#builds"}`)
	locked.Hook = "locked"
	lockedDM := j("locked webhook direct message", `{"text":"psst","channel":"@alice"}`)
	lockedDM.Hook = "locked"
	bearer := j("foreign bearer token", `{"text":"with someone else's token","blocks":[{"type":"actions","elements":[{"type":"button","action_id":"a","text":{"type":"plain_text","text":"Go"}}]}]}`)
	bearer.Auth = "Bearer xoxb-someone-elses"
	asJSON := j("json answer", `{"text":"answer as json"}`)
	asJSON.Accept = "application/json"
	asJSONErr := j("json answer to an error", `{}`)
	asJSONErr.Accept = "application/json"
	missing := j("unknown webhook", `{"text":"hi"}`)
	missing.Hook = "missing"
	return append(cases, locked, lockedDM, bearer, asJSON, asJSONErr, missing)
}

var (
	compatULID = regexp.MustCompile(`\b[0-9A-HJKMNP-TV-Z]{26}\b`)
	compatTime = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)`)
)

func compatNormalize(s string) string {
	return compatTime.ReplaceAllString(compatULID.ReplaceAllString(s, "<ID>"), "<TIME>")
}

func runCompatCase(t *testing.T, c compatCase) compatResult {
	t.Helper()
	general := &model.Channel{ID: "ch-general", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	builds := &model.Channel{ID: "ch-builds", Name: "Builds", Slug: "builds", Type: model.ChannelTypePublic}
	channels := handlerWebhookChannels{
		byID:   map[string]*model.Channel{general.ID: general, builds.ID: builds},
		bySlug: map[string]*model.Channel{general.Slug: general, builds.Slug: builds},
	}
	webhooks := &handlerWebhookStore{items: map[string]*model.IncomingWebhook{
		"open":   {ID: "open", Title: "CI", ChannelID: general.ID, ChannelName: general.Name, ChannelSlug: general.Slug, Username: "ci", CreatedBy: "u-owner"},
		"locked": {ID: "locked", Title: "Alerts", ChannelID: general.ID, ChannelName: general.Name, ChannelSlug: general.Slug, Username: "alerts", LockToChannel: true, CreatedBy: "u-owner"},
	}}
	messages := &handlerWebhookMessageStore{messages: map[string]*model.Message{}}
	msgSvc := service.NewMessageService(messages, nil, nil, nil, nil)
	svc := service.NewIncomingWebhookService(webhooks, channels, msgSvc, handlerWebhookImageProxy{}, "https://ex.test")
	svc.SetUserResolver(compatUsers{users: []*model.User{
		{ID: "u-alice", DisplayName: "Alice", Email: "alice@example.com"},
		{ID: "u-bob", DisplayName: "Bob", Email: "bob@example.com"},
	}})
	h := NewWebhookHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/hooks/"+c.Hook, strings.NewReader(c.Body))
	req.Header.Set("Content-Type", c.ContentType)
	if c.Accept != "" {
		req.Header.Set("Accept", c.Accept)
	}
	if c.Auth != "" {
		req.Header.Set("Authorization", c.Auth)
	}
	req.SetPathValue("id", c.Hook)
	res := httptest.NewRecorder()
	h.Execute(res, req)

	stored := make([]string, 0, len(messages.messages))
	for _, m := range messages.messages {
		raw, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("%s: marshal stored message: %v", c.Name, err)
		}
		stored = append(stored, compatNormalize(string(raw)))
	}
	sort.Strings(stored)
	return compatResult{
		Name:     c.Name,
		Status:   res.Code,
		Type:     res.Header().Get("Content-Type"),
		Answer:   compatNormalize(res.Body.String()),
		Messages: stored,
	}
}

func TestClassicWebhooksBehaveAsBefore(t *testing.T) {
	results := []compatResult{}
	for _, c := range compatCorpus() {
		results = append(results, runCompatCase(t, c))
	}
	if os.Getenv("CLASSIC_COMPAT_WRITE") == "1" {
		raw, _ := json.MarshalIndent(results, "", "  ")
		if err := os.WriteFile(classicCompatGolden, append(raw, '\n'), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		return
	}
	raw, err := os.ReadFile(classicCompatGolden)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var want []compatResult
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(want) != len(results) {
		t.Fatalf("golden has %d cases, corpus %d: regenerate it on origin/main", len(want), len(results))
	}
	for i, got := range results {
		w := want[i]
		if got.Name != w.Name || got.Status != w.Status || got.Type != w.Type || got.Answer != w.Answer || strings.Join(got.Messages, "\n") != strings.Join(w.Messages, "\n") {
			gotJSON, _ := json.MarshalIndent(got, "", "  ")
			wantJSON, _ := json.MarshalIndent(w, "", "  ")
			t.Errorf("classic webhook %q now behaves differently from main:\n got %s\nwant %s", w.Name, gotJSON, wantJSON)
		}
	}
}
