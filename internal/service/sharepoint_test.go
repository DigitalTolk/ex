package service

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
	"golang.org/x/oauth2"
)

// ---------------------------------------------------------------- fakes

type spRecords struct {
	mu         sync.Mutex
	links      map[string]store.SharePointLink
	items      map[string]store.SharePointItem
	unfinished map[string]store.SharePointUnfinished // by user|parent

	putUnfinishedErr, listUnfinishedErr, deleteUnfinishedErr error

	getLinkErr, listLinksErr, deleteLinkErr       error
	getItemErr, listItemsErr, deleteItemErr       error
	putLinkErr, putItemErr                        error
	putLinkFailFrom, putItemFailFrom              int // 1-based: fail from the N-th put on
	putLinks, putItems, deletedLinks, deletedItem int
}

func newSPRecords() *spRecords {
	return &spRecords{links: map[string]store.SharePointLink{}, items: map[string]store.SharePointItem{}, unfinished: map[string]store.SharePointUnfinished{}}
}

func cloneItem(it store.SharePointItem) store.SharePointItem {
	it.Grants = maps.Clone(it.Grants)
	it.NotShared = slices.Clone(it.NotShared)
	return it
}

func cloneLink(l store.SharePointLink) store.SharePointLink {
	l.MessageIDs = slices.Clone(l.MessageIDs)
	return l
}

func (r *spRecords) GetSharePointLink(_ context.Context, parentID, url string) (*store.SharePointLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.getLinkErr != nil {
		return nil, r.getLinkErr
	}
	l, ok := r.links[parentID+"|"+url]
	if !ok {
		return nil, store.ErrNotFound
	}
	l = cloneLink(l)
	return &l, nil
}

func (r *spRecords) ListSharePointLinks(_ context.Context, parentID string) ([]store.SharePointLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.listLinksErr != nil {
		return nil, r.listLinksErr
	}
	var out []store.SharePointLink
	for _, k := range slices.Sorted(maps.Keys(r.links)) {
		if strings.HasPrefix(k, parentID+"|") {
			out = append(out, cloneLink(r.links[k]))
		}
	}
	return out, nil
}

func (r *spRecords) PutSharePointLink(_ context.Context, l *store.SharePointLink) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.putLinks++
	if r.putLinkErr != nil && r.putLinks >= max(1, r.putLinkFailFrom) {
		return r.putLinkErr
	}
	r.links[l.ParentID+"|"+l.URL] = cloneLink(*l)
	return nil
}

func (r *spRecords) DeleteSharePointLink(_ context.Context, parentID, url string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deleteLinkErr != nil {
		return r.deleteLinkErr
	}
	r.deletedLinks++
	delete(r.links, parentID+"|"+url)
	return nil
}

func (r *spRecords) GetSharePointItem(_ context.Context, parentID, id string) (*store.SharePointItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.getItemErr != nil {
		return nil, r.getItemErr
	}
	it, ok := r.items[parentID+"|"+id]
	if !ok {
		return nil, store.ErrNotFound
	}
	it = cloneItem(it)
	return &it, nil
}

func (r *spRecords) ListSharePointItems(_ context.Context, parentID string) ([]store.SharePointItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.listItemsErr != nil {
		return nil, r.listItemsErr
	}
	var out []store.SharePointItem
	for _, k := range slices.Sorted(maps.Keys(r.items)) {
		if strings.HasPrefix(k, parentID+"|") {
			out = append(out, cloneItem(r.items[k]))
		}
	}
	return out, nil
}

func (r *spRecords) PutSharePointItem(_ context.Context, it *store.SharePointItem) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.putItems++
	if r.putItemErr != nil && r.putItems >= max(1, r.putItemFailFrom) {
		return r.putItemErr
	}
	r.items[it.ParentID+"|"+it.ID] = cloneItem(*it)
	return nil
}

func (r *spRecords) DeleteSharePointItem(_ context.Context, parentID, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deleteItemErr != nil {
		return r.deleteItemErr
	}
	r.deletedItem++
	delete(r.items, parentID+"|"+id)
	return nil
}

func (r *spRecords) PutSharePointUnfinished(_ context.Context, u *store.SharePointUnfinished) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.putUnfinishedErr != nil {
		return r.putUnfinishedErr
	}
	r.unfinished[u.UserID+"|"+u.ParentID] = *u
	return nil
}

func (r *spRecords) ListSharePointUnfinished(_ context.Context, userID string) ([]store.SharePointUnfinished, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.listUnfinishedErr != nil {
		return nil, r.listUnfinishedErr
	}
	var out []store.SharePointUnfinished
	for _, k := range slices.Sorted(maps.Keys(r.unfinished)) {
		if strings.HasPrefix(k, userID+"|") {
			out = append(out, r.unfinished[k])
		}
	}
	return out, nil
}

func (r *spRecords) DeleteSharePointUnfinished(_ context.Context, userID, parentID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deleteUnfinishedErr != nil {
		return r.deleteUnfinishedErr
	}
	delete(r.unfinished, userID+"|"+parentID)
	return nil
}

// unfinishedFor lists the parents marked unfinished for a user.
func (r *spRecords) unfinishedFor(userID string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, u := range r.unfinished {
		if u.UserID == userID {
			out = append(out, u.ParentID+":"+u.ParentType)
		}
	}
	slices.Sort(out)
	return out
}

func (r *spRecords) link(parentID, url string) *store.SharePointLink {
	r.mu.Lock()
	defer r.mu.Unlock()
	l, ok := r.links[parentID+"|"+url]
	if !ok {
		return nil
	}
	return &l
}

func (r *spRecords) item(parentID, id string) *store.SharePointItem {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.items[parentID+"|"+id]
	if !ok {
		return nil
	}
	return &it
}

type spGraph struct {
	mu         sync.Mutex
	items      map[string]*msgraph.DriveItem // by link
	resolveErr error
	resolvedAs []string // the token each resolve ran with
	grantees   []msgraph.Grantee
	granteeErr error
	inviteErr  map[string]error // by object id
	invited    []string         // object ids, with the token: "oid@token"
	deleteErr  error
	deleted    []string // permission ids, with the token
	preview    string
	previewErr error
}

func newSPGraph() *spGraph {
	return &spGraph{items: map[string]*msgraph.DriveItem{}, inviteErr: map[string]error{}}
}

func tokenOf(ts oauth2.TokenSource) string {
	tok, _ := ts.Token()
	return tok.AccessToken
}

func (g *spGraph) ResolveLink(_ context.Context, ts oauth2.TokenSource, link string) (*msgraph.DriveItem, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.resolvedAs = append(g.resolvedAs, tokenOf(ts))
	if g.resolveErr != nil {
		return nil, g.resolveErr
	}
	item, ok := g.items[link]
	if !ok {
		return nil, msgraph.ErrNotFound
	}
	return item, nil
}

func (g *spGraph) Grantees(context.Context, oauth2.TokenSource, string, string) ([]msgraph.Grantee, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.grantees, g.granteeErr
}

func (g *spGraph) Invite(_ context.Context, ts oauth2.TokenSource, _, _, objectID string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.invited = append(g.invited, objectID+"@"+tokenOf(ts))
	if err := g.inviteErr[objectID]; err != nil {
		return "", err
	}
	return "perm-" + objectID, nil
}

func (g *spGraph) DeletePermission(_ context.Context, ts oauth2.TokenSource, _, _, permissionID string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.deleted = append(g.deleted, permissionID+"@"+tokenOf(ts))
	return g.deleteErr
}

func (g *spGraph) Preview(_ context.Context, ts oauth2.TokenSource, driveID, itemID string) (*url.URL, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.previewErr != nil {
		return nil, g.previewErr
	}
	return url.Parse(g.preview + "?item=" + driveID + "/" + itemID + "&as=" + tokenOf(ts))
}

func (g *spGraph) invites() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Sorted(slices.Values(g.invited))
}

type spTokens struct {
	missing map[string]bool
	err     error
	saved   []string
	saveErr error
}

func (t *spTokens) SaveDelegatedToken(_ context.Context, userID string, _ *oauth2.Token) error {
	if t.saveErr != nil {
		return t.saveErr
	}
	t.saved = append(t.saved, userID)
	delete(t.missing, userID)
	return nil
}

func (t *spTokens) TokenSource(_ context.Context, userID string) (oauth2.TokenSource, error) {
	if t.err != nil {
		return nil, t.err
	}
	if t.missing[userID] {
		return nil, ErrNoDelegatedToken
	}
	return oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "tok-" + userID}), nil
}

type spQueue struct {
	mu    sync.Mutex
	tasks []SharePointTask
	err   error
}

func (q *spQueue) EnqueueSharePoint(_ context.Context, t SharePointTask) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.err != nil {
		return q.err
	}
	q.tasks = append(q.tasks, t)
	return nil
}

type spLocks struct {
	mu         sync.Mutex
	held       map[string]string
	acquireErr error
	releaseErr error
	acquires   int
}

func (l *spLocks) AcquireLock(_ context.Context, key, token string, _ time.Duration) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.acquires++
	if l.acquireErr != nil {
		return false, l.acquireErr
	}
	if _, taken := l.held[key]; taken {
		return false, nil
	}
	l.held[key] = token
	return true, nil
}

func (l *spLocks) ReleaseLock(_ context.Context, key, token string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.held[key] == token {
		delete(l.held, key)
	}
	return l.releaseErr
}

type spMembers struct {
	members map[string][]string
	err     error
}

func (m *spMembers) ListMembers(_ context.Context, channelID string) ([]*model.ChannelMembership, error) {
	if m.err != nil {
		return nil, m.err
	}
	var out []*model.ChannelMembership
	for _, id := range m.members[channelID] {
		out = append(out, &model.ChannelMembership{ChannelID: channelID, UserID: id})
	}
	return out, nil
}

type spConversations struct {
	convs map[string]*model.Conversation
	err   error
}

func (c *spConversations) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if c.err != nil {
		return nil, c.err
	}
	if conv, ok := c.convs[id]; ok {
		return conv, nil
	}
	return nil, store.ErrNotFound
}

type spUsers struct {
	users map[string]*model.User
	err   error
}

func (u *spUsers) GetUsersByIDs(_ context.Context, ids []string) ([]*model.User, error) {
	if u.err != nil {
		return nil, u.err
	}
	var out []*model.User
	for _, id := range ids {
		if user, ok := u.users[id]; ok {
			out = append(out, user)
		}
	}
	return out, nil
}

type spMessages struct {
	mu   sync.Mutex
	msgs map[string]*model.Message
	err  error
}

func (m *spMessages) GetMessage(_ context.Context, parentID, id string) (*model.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return nil, m.err
	}
	if msg, ok := m.msgs[parentID+"|"+id]; ok {
		return msg, nil
	}
	return nil, store.ErrNotFound
}

type spAccess struct{ err error }

func (a *spAccess) CheckAccess(context.Context, string, string, string) error { return a.err }

// ---------------------------------------------------------------- harness

const (
	spLink  = "https://contoso.sharepoint.com/:w:/s/team/Eabc"
	spLink2 = "https://contoso.sharepoint.com/sites/team/Plan.docx"
)

// spHarness is a channel "ch-sp" whose members are alice (who posts), bob,
// carol (who can already open the file), a guest, an account outside the
// directory, a bot and a deactivated account, plus a working Microsoft 365.
type spHarness struct {
	svc      *SharePointService
	records  *spRecords
	graph    *spGraph
	tokens   *spTokens
	queue    *spQueue
	locks    *spLocks
	members  *spMembers
	convs    *spConversations
	users    *spUsers
	messages *spMessages
	access   *spAccess
	pub      *mockPublisher
	base     time.Time
	t        *testing.T
}

func spUser(id, oid string, mod func(*model.User)) *model.User {
	u := &model.User{ID: id, Email: id + "@example.com", MSObjectID: oid, AuthProvider: model.AuthProviderOIDC, SystemRole: model.SystemRoleMember, Status: "active"}
	if mod != nil {
		mod(u)
	}
	return u
}

func newSPHarness(t *testing.T) *spHarness {
	t.Helper()
	h := &spHarness{
		records: newSPRecords(),
		graph:   newSPGraph(),
		tokens:  &spTokens{missing: map[string]bool{}},
		queue:   &spQueue{},
		locks:   &spLocks{held: map[string]string{}},
		members: &spMembers{members: map[string][]string{
			"ch-sp": {"alice", "bob", "carol", "guest", "nooid", "bot", "gone"},
		}},
		convs: &spConversations{convs: map[string]*model.Conversation{}},
		users: &spUsers{users: map[string]*model.User{
			"alice": spUser("alice", "oid-alice", nil),
			"bob":   spUser("bob", "oid-bob", nil),
			"carol": spUser("carol", "oid-carol", nil),
			"dave":  spUser("dave", "oid-dave", nil),
			"guest": spUser("guest", "oid-guest", func(u *model.User) { u.AuthProvider = model.AuthProviderGuest }),
			"nooid": spUser("nooid", "", nil),
			"bot":   spUser("bot", "oid-bot", func(u *model.User) { u.IsBot = true }),
			"gone":  spUser("gone", "oid-gone", func(u *model.User) { u.Status = "deactivated" }),
		}},
		messages: &spMessages{msgs: map[string]*model.Message{}},
		access:   &spAccess{},
		pub:      newMockPublisher(),
		base:     time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC),
		t:        t,
	}
	h.graph.items[spLink] = &msgraph.DriveItem{
		ID: "item-1", Name: "Plan.docx", Size: 42, WebURL: "https://contoso.sharepoint.com/sites/team/Plan.docx",
		File: &struct {
			MimeType string `json:"mimeType"`
		}{MimeType: "application/msword"},
		ParentReference: struct {
			DriveID string `json:"driveId"`
		}{DriveID: "drive-1"},
		SharePointIDs: &struct {
			ListItemUniqueID string `json:"listItemUniqueId"`
			SiteURL          string `json:"siteUrl"`
		}{ListItemUniqueID: "u-1", SiteURL: "https://contoso.sharepoint.com/sites/team"},
	}
	// Carol can already open it: a permission of her own, found by email.
	h.graph.grantees = []msgraph.Grantee{{ID: "someone-else", Email: "CAROL@example.com"}}
	h.svc = NewSharePointService(SharePointDeps{
		Records: h.records, Graph: h.graph, Tokens: h.tokens, Queue: h.queue, Locks: h.locks,
		Members: h.members, Conversations: h.convs, Users: h.users, Messages: h.messages,
		Access: h.access, Publisher: h.pub, Hosts: []string{"*.sharepoint.com"},
	})
	t.Cleanup(stageSharePointRuns(sharePointFinalAttempt, sharePointLockWait, sharePointLockPoll))
	return h
}

// stageSharePointRuns returns a restore for the run seams a test may change.
func stageSharePointRuns(final func(context.Context) bool, wait, poll time.Duration) func() {
	return func() {
		sharePointFinalAttempt, sharePointLockWait, sharePointLockPoll = final, wait, poll
	}
}

// withRetriesLeft makes every run one the job will get another go at.
func withRetriesLeft() { sharePointFinalAttempt = func(context.Context) bool { return false } }

func (h *spHarness) post(id, parentID, author, body string, minutes int) *model.Message {
	msg := &model.Message{ID: id, ParentID: parentID, AuthorID: author, Body: body, CreatedAt: h.base.Add(time.Duration(minutes) * time.Minute)}
	h.messages.mu.Lock()
	h.messages.msgs[parentID+"|"+id] = msg
	h.messages.mu.Unlock()
	return msg
}

func (h *spHarness) run(t *testing.T, task SharePointTask) error {
	t.Helper()
	payload, _ := json.Marshal(task)
	return h.svc.TaskHandler()(context.Background(), asynq.NewTask(TaskTypeSharePointSync, payload))
}

func (h *spHarness) mustRun(t *testing.T, task SharePointTask) {
	t.Helper()
	if err := h.run(t, task); err != nil {
		t.Fatalf("job %+v: %v", task, err)
	}
}

// mustRunQuiet runs a job inside a table case's setup.
func (h *spHarness) mustRunQuiet(task SharePointTask) {
	h.t.Helper()
	h.mustRun(h.t, task)
}

func messagesTask(parentID string, ids ...string) SharePointTask {
	return SharePointTask{Kind: sharePointMessages, ParentID: parentID, ParentType: ParentChannel, MessageIDs: ids}
}

func (h *spHarness) changedEvents(t *testing.T) []model.SharePointChangedEvent {
	t.Helper()
	h.pub.mu.Lock()
	defer h.pub.mu.Unlock()
	var out []model.SharePointChangedEvent
	for _, p := range h.pub.published {
		if p.event.Type != events.EventSharePointChanged {
			continue
		}
		var e model.SharePointChangedEvent
		if err := json.Unmarshal(p.event.Data, &e); err != nil {
			t.Fatalf("event data: %v", err)
		}
		out = append(out, e)
	}
	return out
}

var spItemID = store.SharePointItemID("drive-1", "item-1")

// ---------------------------------------------------------------- tests

func TestBodyURLs(t *testing.T) {
	for _, tc := range []struct {
		body string
		want []string
	}{
		{"", nil},
		{"see https://a.example/x, and (https://b.example/y).", []string{"https://a.example/x", "https://b.example/y"}},
		{"[plan](https://a.example/p) http://c.example", []string{"https://a.example/p", "http://c.example"}},
		{"`https://code.example` then https://a.example", []string{"https://a.example"}},
		{"```\nhttps://fenced.example\n``` after https://a.example", []string{"https://a.example"}},
		{"https://a.example ```unterminated https://b.example", []string{"https://a.example"}},
		{"https://a.example `unterminated https://b.example", []string{"https://a.example"}},
	} {
		if got := bodyURLs(tc.body); !slices.Equal(got, tc.want) {
			t.Errorf("bodyURLs(%q) = %v, want %v", tc.body, got, tc.want)
		}
	}
}

func TestLinksInMatchesHosts(t *testing.T) {
	svc := NewSharePointService(SharePointDeps{Hosts: []string{"*.sharepoint.com", "files.example.com"}})
	body := "a " + spLink + " b https://FILES.example.com/x c http://contoso.sharepoint.com/insecure d https://sharepoint.com/bare " +
		"e https://evil.example.com/?x=.sharepoint.com f " + spLink + " g https://%zz.sharepoint.com/"
	if got := svc.linksIn(body); !slices.Equal(got, []string{spLink, "https://FILES.example.com/x"}) {
		t.Fatalf("linksIn = %v", got)
	}
	if !slices.Equal(svc.Hosts(), []string{"*.sharepoint.com", "files.example.com"}) {
		t.Fatalf("Hosts = %v", svc.Hosts())
	}
}

func TestSharePointHooksQueueJobs(t *testing.T) {
	h := newSPHarness(t)
	ctx := context.Background()
	linked := &model.Message{ID: "m-1", ParentID: "ch-sp", AuthorID: "alice", Body: "plan: " + spLink}
	plain := &model.Message{ID: "m-2", ParentID: "ch-sp", AuthorID: "alice", Body: "no links"}

	h.svc.MessageSent(ctx, linked, ParentChannel)
	h.svc.MessageSent(ctx, plain, ParentChannel)
	for _, skipped := range []*model.Message{
		{ID: "g", ParentID: generalChannelID, AuthorID: "alice", Body: spLink},
		{ID: "w", ParentID: "ch-sp", AuthorID: "webhook", WebhookID: "wh", Body: spLink},
		{ID: "s", ParentID: "ch-sp", AuthorID: "system", System: true, Body: spLink},
		{ID: "a", ParentID: "ch-sp", AuthorID: "agent", AgentInvokerID: "alice", Body: spLink},
	} {
		h.svc.MessageSent(ctx, skipped, ParentChannel)
	}
	h.svc.MessageEdited(ctx, linked, plain, ParentConversation) // lost its link
	h.svc.MessageEdited(ctx, plain, plain, ParentChannel)       // never had one
	h.svc.MessageEdited(ctx, linked, &model.Message{ID: "g", ParentID: generalChannelID}, ParentChannel)
	h.svc.MessagesDeleted(ctx, "ch-sp", ParentChannel, []string{"m-1", "m-3"})
	h.svc.MessagesDeleted(ctx, "ch-sp", ParentChannel, nil)
	h.svc.MessagesDeleted(ctx, generalChannelID, ParentChannel, []string{"m"})
	h.svc.MemberJoined(ctx, "ch-sp", "dave")
	h.svc.MemberJoined(ctx, generalChannelID, "dave")
	h.svc.ParentLeft(ctx, []string{"bob"}, "ch-sp")
	h.svc.ParentLeft(ctx, nil, "ch-sp")
	h.svc.ParentLeft(ctx, []string{"bob"}, generalChannelID)

	want := []SharePointTask{
		{Kind: sharePointMessages, ParentID: "ch-sp", ParentType: ParentChannel, MessageIDs: []string{"m-1"}},
		{Kind: sharePointMessages, ParentID: "ch-sp", ParentType: ParentConversation, MessageIDs: []string{"m-2"}},
		{Kind: sharePointMessages, ParentID: "ch-sp", ParentType: ParentChannel, MessageIDs: []string{"m-1", "m-3"}},
		{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}},
		{Kind: sharePointLeft, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"bob"}},
	}
	got, _ := json.Marshal(h.queue.tasks)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Fatalf("queued %s\nwant   %s", got, exp)
	}

	// A queue outage is logged; the send it rides on is not failed.
	h.queue.err = errors.New("redis down")
	h.svc.MessageSent(ctx, linked, ParentChannel)
}

func TestShareSharesWithMembersWhoCanOpenIt(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", "plan: "+spLink+".", 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	// Bob is invited, as alice; carol had access, so she gets no permission
	// the app could take back; nobody else can be given access.
	if got := h.graph.invites(); !slices.Equal(got, []string{"oid-bob@tok-alice"}) {
		t.Fatalf("invites = %v", got)
	}
	it := h.records.item("ch-sp", spItemID)
	if it == nil {
		t.Fatal("file not recorded")
	}
	if !maps.Equal(it.Grants, map[string]string{"bob": "perm-oid-bob", "carol": ""}) || it.GrantorID != "alice" {
		t.Fatalf("grants = %v (grantor %s)", it.Grants, it.GrantorID)
	}
	// The people left out are named; a bot or a deactivated account is
	// passed over without a word.
	if got := slices.Sorted(slices.Values(it.NotShared)); !slices.Equal(got, []string{"guest", "nooid"}) {
		t.Fatalf("not shared = %v", got)
	}
	if it.Name != "Plan.docx" || it.Size != 42 || it.MimeType != "application/msword" || it.Folder ||
		it.EditURL != "https://contoso.sharepoint.com/sites/team/_layouts/15/Doc.aspx?action=edit&sourcedoc=%7Bu-1%7D" ||
		it.DownloadURL != "https://contoso.sharepoint.com/sites/team/_layouts/15/download.aspx?UniqueId=u-1" ||
		it.MessageID != "m-1" || it.AuthorID != "alice" || !it.SharedAt.Equal(h.base) {
		t.Fatalf("file = %+v", it)
	}
	l := h.records.link("ch-sp", spLink)
	if l == nil || l.Status != "shared" || l.PosterID != "alice" || l.ItemID != spItemID || !slices.Equal(l.MessageIDs, []string{"m-1"}) {
		t.Fatalf("link = %+v", l)
	}
	// Announced when sharing starts (the card says so meanwhile) and when
	// it ends.
	if evs := h.changedEvents(t); len(evs) != 2 || !slices.Equal(evs[0].URLs, []string{spLink}) || !slices.Equal(evs[1].URLs, []string{spLink}) || evs[1].ParentID != "ch-sp" {
		t.Fatalf("events = %+v", evs)
	}
	if ch := h.pub.published[0].channel; ch != pubsub.ChannelName("ch-sp") {
		t.Fatalf("published to %s", ch)
	}
	if len(h.locks.held) != 0 {
		t.Fatalf("lock still held: %v", h.locks.held)
	}

	// The poster's card says how it went; everyone else's shows the file.
	ctx := context.Background()
	mine, err := h.svc.Link(ctx, "alice", "ch-sp", ParentChannel, spLink)
	if err != nil || mine.Status != model.SharePointShared || mine.File == nil || mine.File.Name != "Plan.docx" ||
		mine.SharedWith != 2 || len(mine.NotShared) != 2 || mine.PosterID != "alice" {
		t.Fatalf("poster's view = %+v, %v", mine, err)
	}
	theirs, err := h.svc.Link(ctx, "bob", "ch-sp", ParentChannel, spLink)
	if err != nil || theirs.File == nil || theirs.SharedWith != 0 || theirs.NotShared != nil || theirs.Problem != "" {
		t.Fatalf("member's view = %+v, %v", theirs, err)
	}
	files, err := h.svc.Files(ctx, "ch-sp")
	if err != nil || len(files) != 1 || files[0].File.ID != spItemID || files[0].MessageID != "m-1" || files[0].AuthorID != "alice" {
		t.Fatalf("files = %+v, %v", files, err)
	}
}

func TestShareInConversations(t *testing.T) {
	h := newSPHarness(t)
	h.convs.convs["dm-1"] = &model.Conversation{ID: "dm-1", ParticipantIDs: []string{"alice", "bob"}}
	h.convs.convs["grp-1"] = &model.Conversation{ID: "grp-1", ConvertedToChannelID: "ch-sp"}
	h.post("m-1", "dm-1", "alice", spLink, 0)
	h.post("m-2", "grp-1", "alice", spLink, 0)

	h.mustRun(t, SharePointTask{Kind: sharePointMessages, ParentID: "dm-1", ParentType: ParentConversation, MessageIDs: []string{"m-1"}})
	if it := h.records.item("dm-1", spItemID); it == nil || !maps.Equal(it.Grants, map[string]string{"bob": "perm-oid-bob"}) {
		t.Fatalf("dm file = %+v", it)
	}
	if ch := h.pub.published[0].channel; ch != pubsub.ConversationName("dm-1") {
		t.Fatalf("published to %s", ch)
	}
	// A group that became a channel shares with the channel's members.
	h.mustRun(t, SharePointTask{Kind: sharePointMessages, ParentID: "grp-1", ParentType: ParentConversation, MessageIDs: []string{"m-2"}})
	if it := h.records.item("grp-1", spItemID); it == nil || len(it.Grants) != 2 {
		t.Fatalf("converted group file = %+v", it)
	}
}

func TestShareProblemsThePosterMustFix(t *testing.T) {
	for _, tc := range []struct {
		name  string
		stage func(h *spHarness)
		want  model.SharePointProblem
	}{
		{"no stored sign-in", func(h *spHarness) { h.tokens.missing["alice"] = true }, model.SharePointSignIn},
		{"sign-in refused", func(h *spHarness) { h.graph.resolveErr = msgraph.ErrSignInRequired }, model.SharePointSignIn},
		{"may not share", func(h *spHarness) { h.graph.inviteErr["oid-bob"] = msgraph.ErrForbidden }, model.SharePointDenied},
		{"file not found", func(h *spHarness) { delete(h.graph.items, spLink) }, model.SharePointNotFound},
		{"Microsoft 365 down on the last run", func(h *spHarness) { h.graph.resolveErr = errors.New("503") }, model.SharePointUnavailable},
		{"members unreadable on the last run", func(h *spHarness) { h.members.err = errors.New("dynamo") }, model.SharePointUnavailable},
		{"accounts unreadable on the last run", func(h *spHarness) { h.users.err = errors.New("dynamo") }, model.SharePointUnavailable},
		{"permissions unreadable on the last run", func(h *spHarness) { h.graph.granteeErr = errors.New("503") }, model.SharePointUnavailable},
		{"file record unreadable on the last run", func(h *spHarness) { h.records.getItemErr = errors.New("dynamo") }, model.SharePointUnavailable},
		{"token store unreadable on the last run", func(h *spHarness) { h.tokens.err = errors.New("dynamo") }, model.SharePointUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newSPHarness(t)
			h.post("m-1", "ch-sp", "alice", spLink, 0)
			tc.stage(h)
			h.mustRun(t, messagesTask("ch-sp", "m-1"))
			l := h.records.link("ch-sp", spLink)
			if l.Status != "failed" || l.Problem != string(tc.want) {
				t.Fatalf("link = %+v, want failed/%s", l, tc.want)
			}
			view, _ := h.svc.Link(context.Background(), "alice", "ch-sp", ParentChannel, spLink)
			if view.Problem != tc.want || view.Status != model.SharePointFailed {
				t.Fatalf("poster's view = %+v", view)
			}
		})
	}
}

func TestShareRetriesTransientFailures(t *testing.T) {
	h := newSPHarness(t)
	withRetriesLeft()
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.graph.resolveErr = errors.New("503")
	if err := h.run(t, messagesTask("ch-sp", "m-1")); err == nil {
		t.Fatal("want the job retried")
	}
	if l := h.records.link("ch-sp", spLink); l.Status != "pending" {
		t.Fatalf("link = %+v, want pending while it retries", l)
	}
	// The retry finds the link pending and finishes it.
	h.graph.resolveErr = nil
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if l := h.records.link("ch-sp", spLink); l.Status != "shared" {
		t.Fatalf("link = %+v", l)
	}
}

func TestShareKeepsWhatWasGrantedWhenSomeInvitesFail(t *testing.T) {
	h := newSPHarness(t)
	withRetriesLeft()
	h.members.members["ch-sp"] = []string{"alice", "bob", "dave"}
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.graph.inviteErr["oid-dave"] = errors.New("429")
	if err := h.run(t, messagesTask("ch-sp", "m-1")); err == nil {
		t.Fatal("want the job retried for dave")
	}
	if it := h.records.item("ch-sp", spItemID); !maps.Equal(it.Grants, map[string]string{"bob": "perm-oid-bob"}) {
		t.Fatalf("grants kept = %v", it.Grants)
	}
	// On the last run, dave is listed as not shared and the link is shared.
	sharePointFinalAttempt = func(context.Context) bool { return true }
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	it := h.records.item("ch-sp", spItemID)
	if !slices.Equal(it.NotShared, []string{"dave"}) || h.records.link("ch-sp", spLink).Status != "shared" {
		t.Fatalf("file = %+v", it)
	}
	if n := strings.Count(strings.Join(h.graph.invites(), ","), "oid-bob"); n != 1 {
		t.Fatalf("bob invited %d times", n)
	}
	// Once dave can be added (he joins again), he leaves the not-shared list.
	delete(h.graph.inviteErr, "oid-dave")
	h.mustRun(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}})
	if it := h.records.item("ch-sp", spItemID); len(it.NotShared) != 0 || it.Grants["dave"] != "perm-oid-dave" {
		t.Fatalf("after joining = %+v", it)
	}
}

func TestEditingKeepsOrDropsALink(t *testing.T) {
	h := newSPHarness(t)
	msg := h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	// An edit that keeps the link shares nothing again.
	msg.Body = "updated: " + spLink
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if len(h.graph.resolvedAs) != 1 {
		t.Fatalf("resolved %d times", len(h.graph.resolvedAs))
	}
	// An edit that drops it takes the access back, as the grantor, and
	// forgets the file — carol's own access is left alone.
	msg.Body = "never mind"
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if !slices.Equal(h.graph.deleted, []string{"perm-oid-bob@tok-alice"}) {
		t.Fatalf("revoked = %v", h.graph.deleted)
	}
	if h.records.link("ch-sp", spLink) != nil || h.records.item("ch-sp", spItemID) != nil {
		t.Fatal("link and file must be gone")
	}
	evs := h.changedEvents(t)
	if len(evs) != 3 || !slices.Equal(evs[2].URLs, []string{spLink}) {
		t.Fatalf("events = %+v", evs)
	}
}

func TestALinkStaysWhileAnyMessageCarriesIt(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	// Bob posts it again later: no new share, the Files panel moves to his post.
	h.post("m-2", "ch-sp", "bob", "again "+spLink, 5)
	h.mustRun(t, messagesTask("ch-sp", "m-2"))
	if len(h.graph.resolvedAs) != 1 {
		t.Fatalf("resolved %d times", len(h.graph.resolvedAs))
	}
	if it := h.records.item("ch-sp", spItemID); it.MessageID != "m-2" || it.AuthorID != "bob" {
		t.Fatalf("file listed at %s by %s", it.MessageID, it.AuthorID)
	}
	// An older message posting it doesn't move the listing back.
	h.post("m-0", "ch-sp", "carol", spLink, -5)
	h.mustRun(t, messagesTask("ch-sp", "m-0"))
	if it := h.records.item("ch-sp", spItemID); it.MessageID != "m-2" {
		t.Fatalf("file listed at %s", it.MessageID)
	}

	// Deleting one message keeps the link; deleting all takes the access back.
	delete(h.messages.msgs, "ch-sp|m-1")
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if l := h.records.link("ch-sp", spLink); l == nil || !slices.Equal(l.MessageIDs, []string{"m-2", "m-0"}) {
		t.Fatalf("link = %+v", l)
	}
	h.messages.msgs["ch-sp|m-2"].Deleted = true
	h.messages.msgs["ch-sp|m-0"].Body = ""
	h.mustRun(t, messagesTask("ch-sp", "m-2", "m-0"))
	if h.records.link("ch-sp", spLink) != nil || h.records.item("ch-sp", spItemID) != nil || len(h.graph.deleted) != 1 {
		t.Fatalf("link or file left behind; revoked %v", h.graph.deleted)
	}
}

func TestTwoLinksToOneFile(t *testing.T) {
	h := newSPHarness(t)
	h.graph.items[spLink2] = h.graph.items[spLink]
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.post("m-2", "ch-sp", "alice", spLink2, 1)
	h.mustRun(t, messagesTask("ch-sp", "m-1", "m-2"))
	if got := h.graph.invites(); len(got) != 1 {
		t.Fatalf("invites = %v; the second link leads to the same file", got)
	}
	// Dropping one link keeps the file the other still leads to.
	h.messages.msgs["ch-sp|m-1"].Body = "gone"
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if h.records.item("ch-sp", spItemID) == nil || len(h.graph.deleted) != 0 {
		t.Fatal("the file must stay while another link leads to it")
	}
}

func TestAFailedLinkIsTriedAgainByTheNextPoster(t *testing.T) {
	h := newSPHarness(t)
	h.tokens.missing["alice"] = true
	msg := h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	// An edit of the same message leaves it failed.
	msg.Body = "still " + spLink
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if l := h.records.link("ch-sp", spLink); l.Status != "failed" || len(h.graph.resolvedAs) != 0 {
		t.Fatalf("link = %+v", l)
	}
	// Bob posting it shares it, as bob.
	h.post("m-2", "ch-sp", "bob", spLink, 1)
	h.mustRun(t, messagesTask("ch-sp", "m-2"))
	l := h.records.link("ch-sp", spLink)
	if l.Status != "shared" || l.PosterID != "bob" || !slices.Equal(h.graph.resolvedAs, []string{"tok-bob"}) {
		t.Fatalf("link = %+v, resolved as %v", l, h.graph.resolvedAs)
	}
	if it := h.records.item("ch-sp", spItemID); it.GrantorID != "bob" || it.Grants["alice"] != "perm-oid-alice" {
		t.Fatalf("file = %+v", it)
	}
}

func TestAFileRecordGoneMissingIsSharedAfresh(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	delete(h.records.items, "ch-sp|"+spItemID)
	h.post("m-2", "ch-sp", "bob", spLink, 1)
	h.mustRun(t, messagesTask("ch-sp", "m-2"))
	if it := h.records.item("ch-sp", spItemID); it == nil || it.GrantorID != "bob" {
		t.Fatalf("file = %+v", it)
	}
}

func TestJoiningGivesAccessAsEachFilesGrantor(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.mustRun(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave", "alice"}})
	if it := h.records.item("ch-sp", spItemID); it.Grants["dave"] != "perm-oid-dave" {
		t.Fatalf("grants = %v", it.Grants)
	}
	if !slices.Contains(h.graph.invites(), "oid-dave@tok-alice") {
		t.Fatalf("invites = %v", h.graph.invites())
	}
	if evs := h.changedEvents(t); len(evs) != 3 || len(evs[2].URLs) != 0 || evs[2].URLs == nil {
		t.Fatalf("join event = %+v (want an empty list: every link)", evs)
	}
}

func TestJoiningWhenTheGrantorCantShare(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	// The grantor's sign-in is gone: the newcomer is listed as not shared.
	h.tokens.missing["alice"] = true
	h.mustRun(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}})
	if it := h.records.item("ch-sp", spItemID); !slices.Contains(it.NotShared, "dave") {
		t.Fatalf("not shared = %v", it.NotShared)
	}

	// Microsoft 365 down with retries left: the job runs again.
	h.tokens.missing["alice"] = false
	withRetriesLeft()
	h.graph.inviteErr["oid-dave"] = errors.New("503")
	if err := h.run(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}}); err == nil {
		t.Fatal("want the join retried")
	}
	h.records.putItemErr = errors.New("dynamo")
	if err := h.run(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}}); err == nil || !strings.Contains(err.Error(), "save file") {
		t.Fatalf("err = %v, want the save failure", err)
	}
}

func TestJoiningErrors(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	join := SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}}

	h.records.putItemErr = errors.New("dynamo")
	if err := h.run(t, join); err == nil || !strings.Contains(err.Error(), "save file") {
		t.Fatalf("err = %v", err)
	}
	h.records.putItemErr = nil
	h.records.listItemsErr = errors.New("dynamo")
	if err := h.run(t, join); err == nil || !strings.Contains(err.Error(), "list files") {
		t.Fatalf("err = %v", err)
	}
}

func TestLeavingTakesBackOnlyWhatTheAppGave(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.mustRun(t, SharePointTask{Kind: sharePointLeft, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"bob", "carol", "guest"}})
	if !slices.Equal(h.graph.deleted, []string{"perm-oid-bob@tok-alice"}) {
		t.Fatalf("revoked = %v", h.graph.deleted)
	}
	it := h.records.item("ch-sp", spItemID)
	if len(it.Grants) != 0 || slices.Contains(it.NotShared, "guest") {
		t.Fatalf("file = %+v", it)
	}
	// Someone who had nothing leaves: nothing is written or announced.
	puts, evs := h.records.putItems, len(h.changedEvents(t))
	h.mustRun(t, SharePointTask{Kind: sharePointLeft, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"dave"}})
	if h.records.putItems != puts || len(h.changedEvents(t)) != evs {
		t.Fatal("a no-op leave wrote or announced something")
	}
}

func TestLeavingWhenTheAccessCantBeTakenBack(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	left := SharePointTask{Kind: sharePointLeft, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"bob"}}

	// Transient, retries left: the job runs again and the grant is kept.
	withRetriesLeft()
	h.graph.deleteErr = errors.New("503")
	if err := h.run(t, left); err == nil {
		t.Fatal("want the leave retried")
	}
	// The grantor's sign-in is gone: logged, the grant kept.
	h.tokens.missing["alice"] = true
	h.mustRun(t, left)
	if it := h.records.item("ch-sp", spItemID); it.Grants["bob"] != "perm-oid-bob" {
		t.Fatalf("grants = %v", it.Grants)
	}
	h.tokens.missing["alice"] = false
	h.graph.deleteErr = nil
	h.records.putItemErr = errors.New("dynamo")
	if err := h.run(t, left); err == nil || !strings.Contains(err.Error(), "save file") {
		t.Fatalf("err = %v", err)
	}
	h.records.listItemsErr = errors.New("dynamo")
	if err := h.run(t, left); err == nil || !strings.Contains(err.Error(), "list files") {
		t.Fatalf("err = %v", err)
	}
}

func TestRetryLink(t *testing.T) {
	h := newSPHarness(t)
	ctx := context.Background()
	h.tokens.missing["alice"] = true
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	if err := h.svc.RetryLink(ctx, "bob", "ch-sp", ParentChannel, spLink); !errors.Is(err, ErrForbidden) {
		t.Fatalf("someone else's link: err = %v", err)
	}
	if err := h.svc.RetryLink(ctx, "alice", "ch-sp", ParentChannel, spLink2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown link: err = %v", err)
	}
	if err := h.svc.RetryLink(ctx, "alice", "ch-sp", ParentChannel, spLink); err != nil {
		t.Fatalf("retry: %v", err)
	}
	retry := h.queue.tasks[len(h.queue.tasks)-1]
	if retry.Kind != sharePointRetry || retry.URL != spLink || !slices.Equal(retry.UserIDs, []string{"alice"}) {
		t.Fatalf("queued %+v", retry)
	}

	// Signed in again, the retry shares it.
	h.tokens.missing["alice"] = false
	h.mustRun(t, retry)
	if l := h.records.link("ch-sp", spLink); l.Status != "shared" {
		t.Fatalf("link = %+v", l)
	}
	// Retrying a shared link does nothing.
	n := len(h.queue.tasks)
	if err := h.svc.RetryLink(ctx, "alice", "ch-sp", ParentChannel, spLink); err != nil || len(h.queue.tasks) != n {
		t.Fatalf("retry of a shared link: %v, queued %d", err, len(h.queue.tasks)-n)
	}
	h.mustRun(t, retry)
	if len(h.graph.resolvedAs) != 1 {
		t.Fatalf("a shared link was resolved again")
	}

	h.access.err = ErrForbidden
	if err := h.svc.RetryLink(ctx, "alice", "ch-sp", ParentChannel, spLink); !errors.Is(err, ErrForbidden) {
		t.Fatalf("no access: err = %v", err)
	}
	h.access.err = nil
	h.records.getLinkErr = errors.New("dynamo")
	if err := h.svc.RetryLink(ctx, "alice", "ch-sp", ParentChannel, spLink); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("store error: err = %v", err)
	}
}

func TestRetryJobEdges(t *testing.T) {
	h := newSPHarness(t)
	retry := SharePointTask{Kind: sharePointRetry, ParentID: "ch-sp", ParentType: ParentChannel, URL: spLink, UserIDs: []string{"alice"}}
	h.mustRun(t, retry) // no such link

	h.records.links["ch-sp|"+spLink] = store.SharePointLink{ParentID: "ch-sp", URL: spLink, Status: "failed", MessageIDs: []string{"m-gone"}}
	h.mustRun(t, retry) // its message is gone
	h.messages.err = errors.New("dynamo")
	if err := h.run(t, retry); err == nil || !strings.Contains(err.Error(), "read message") {
		t.Fatalf("err = %v", err)
	}
	h.messages.err = nil
	h.records.getLinkErr = errors.New("dynamo")
	if err := h.run(t, retry); err == nil || !strings.Contains(err.Error(), "read link") {
		t.Fatalf("err = %v", err)
	}
}

func TestLinkView(t *testing.T) {
	h := newSPHarness(t)
	ctx := context.Background()
	if v, err := h.svc.Link(ctx, "bob", "ch-sp", ParentChannel, spLink); v != nil || err != nil {
		t.Fatalf("never shared = %+v, %v", v, err)
	}
	// Pending: no file yet.
	h.records.links["ch-sp|"+spLink] = store.SharePointLink{ParentID: "ch-sp", URL: spLink, Status: "pending", PosterID: "alice"}
	if v, _ := h.svc.Link(ctx, "alice", "ch-sp", ParentChannel, spLink); v.File != nil || v.Status != model.SharePointPending {
		t.Fatalf("pending view = %+v", v)
	}
	// A file record that went missing shows no file.
	h.records.links["ch-sp|"+spLink] = store.SharePointLink{ParentID: "ch-sp", URL: spLink, Status: "shared", PosterID: "alice", ItemID: "missing"}
	if v, _ := h.svc.Link(ctx, "alice", "ch-sp", ParentChannel, spLink); v.File != nil || v.SharedWith != 0 {
		t.Fatalf("missing file view = %+v", v)
	}
	h.records.getItemErr = errors.New("dynamo")
	if _, err := h.svc.Link(ctx, "alice", "ch-sp", ParentChannel, spLink); err == nil {
		t.Fatal("want the file read error")
	}
	h.records.getLinkErr = errors.New("dynamo")
	if _, err := h.svc.Link(ctx, "alice", "ch-sp", ParentChannel, spLink); err == nil {
		t.Fatal("want the link read error")
	}
	h.access.err = ErrForbidden
	if _, err := h.svc.Link(ctx, "alice", "ch-sp", ParentChannel, spLink); !errors.Is(err, ErrForbidden) {
		t.Fatalf("no access: err = %v", err)
	}
}

func TestFilesListError(t *testing.T) {
	h := newSPHarness(t)
	h.records.listItemsErr = errors.New("dynamo")
	if _, err := h.svc.Files(context.Background(), "ch-sp"); err == nil {
		t.Fatal("want the list error")
	}
}

func TestTaskHandlerEdges(t *testing.T) {
	h := newSPHarness(t)
	bad := h.svc.TaskHandler()(context.Background(), asynq.NewTask(TaskTypeSharePointSync, []byte("{")))
	if !errors.Is(bad, asynq.SkipRetry) {
		t.Fatalf("bad payload: err = %v", bad)
	}
	if err := h.run(t, SharePointTask{Kind: sharePointMessages, ParentID: generalChannelID}); err != nil || h.locks.acquires != 0 {
		t.Fatalf("~general: err = %v, locks %d", err, h.locks.acquires)
	}
	if err := h.run(t, SharePointTask{Kind: "nope", ParentID: "ch-sp"}); !errors.Is(err, asynq.SkipRetry) {
		t.Fatalf("unknown kind: err = %v", err)
	}
	// A lock release that fails is logged; the job's result stands.
	h.locks.releaseErr = errors.New("redis")
	h.mustRun(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp"})
	h.locks.releaseErr = nil

	h.locks.acquireErr = errors.New("redis")
	if err := h.run(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp"}); err == nil {
		t.Fatal("want the lock error")
	}
	h.locks.acquireErr = nil

	// Another job holds the parent: wait, then give up for a retry.
	sharePointLockWait, sharePointLockPoll = 20*time.Millisecond, 5*time.Millisecond
	h.locks.held["sharepoint:lock:ch-sp"] = "other"
	if err := h.run(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp"}); !errors.Is(err, errSharePointBusy) {
		t.Fatalf("busy: err = %v", err)
	}
	if h.locks.acquires < 3 {
		t.Fatalf("looked %d times", h.locks.acquires)
	}
	// ...or let go when the run is cancelled.
	sharePointLockWait = time.Minute
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	payload, _ := json.Marshal(SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp"})
	if err := h.svc.TaskHandler()(ctx, asynq.NewTask(TaskTypeSharePointSync, payload)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: err = %v", err)
	}
	// The lock frees up while waiting.
	sharePointLockPoll = time.Millisecond
	go func() {
		time.Sleep(5 * time.Millisecond)
		h.locks.mu.Lock()
		delete(h.locks.held, "sharepoint:lock:ch-sp")
		h.locks.mu.Unlock()
	}()
	h.mustRun(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp"})
}

func TestSyncMessagesStoreErrors(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(h *spHarness) // after one shared post of m-1
		run   SharePointTask
		want  string
	}{
		{"list links", func(h *spHarness) { h.records.listLinksErr = errors.New("x") }, messagesTask("ch-sp", "m-1"), "list links"},
		{"read message", func(h *spHarness) { h.messages.err = errors.New("x") }, messagesTask("ch-sp", "m-1"), "read message"},
		{"save a link another message still carries", func(h *spHarness) {
			h.post("m-2", "ch-sp", "bob", spLink, 1)
			h.mustRunQuiet(messagesTask("ch-sp", "m-2"))
			h.messages.msgs["ch-sp|m-1"].Body = "x"
			h.records.putLinkErr = errors.New("x")
		}, messagesTask("ch-sp", "m-1"), "save link"},
		{"delete link", func(h *spHarness) {
			h.messages.msgs["ch-sp|m-1"].Body = "x"
			h.records.deleteLinkErr = errors.New("x")
		}, messagesTask("ch-sp", "m-1"), "delete link"},
		{"read file to retire", func(h *spHarness) {
			h.messages.msgs["ch-sp|m-1"].Body = "x"
			h.records.getItemErr = errors.New("x")
		}, messagesTask("ch-sp", "m-1"), "read file"},
		{"delete file", func(h *spHarness) {
			h.messages.msgs["ch-sp|m-1"].Body = "x"
			h.records.deleteItemErr = errors.New("x")
		}, messagesTask("ch-sp", "m-1"), "delete file"},
		{"revoke with retries left", func(h *spHarness) {
			withRetriesLeft()
			h.messages.msgs["ch-sp|m-1"].Body = "x"
			h.graph.deleteErr = errors.New("503")
		}, messagesTask("ch-sp", "m-1"), "503"},
		{"read file to reshare", func(h *spHarness) {
			h.post("m-2", "ch-sp", "bob", spLink, 1)
			h.records.getItemErr = errors.New("x")
		}, messagesTask("ch-sp", "m-2"), "read file"},
		{"save file on reshare", func(h *spHarness) {
			h.post("m-2", "ch-sp", "bob", spLink, 1)
			h.records.putItemErr = errors.New("x")
		}, messagesTask("ch-sp", "m-2"), "save file"},
		{"save link on reshare", func(h *spHarness) {
			h.post("m-2", "ch-sp", "bob", spLink, 1)
			h.records.putLinkErr = errors.New("x")
		}, messagesTask("ch-sp", "m-2"), "save link"},
		{"save pending link", func(h *spHarness) {
			h.post("m-2", "ch-sp", "bob", spLink2, 1)
			h.records.putLinkErr = errors.New("x")
		}, messagesTask("ch-sp", "m-2"), "save link"},
		{"save shared link", func(h *spHarness) {
			h.graph.items[spLink2] = h.graph.items[spLink]
			h.post("m-2", "ch-sp", "bob", spLink2, 1)
			h.records.putLinkErr, h.records.putLinkFailFrom = errors.New("x"), h.records.putLinks+2
		}, messagesTask("ch-sp", "m-2"), "save link"},
		{"save failed link", func(h *spHarness) {
			h.post("m-2", "ch-sp", "bob", spLink2, 1)
			h.records.putLinkErr, h.records.putLinkFailFrom = errors.New("x"), h.records.putLinks+2
		}, messagesTask("ch-sp", "m-2"), "save link"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newSPHarness(t)
			h.post("m-1", "ch-sp", "alice", spLink, 0)
			h.mustRun(t, messagesTask("ch-sp", "m-1"))
			tc.setup(h)
			if err := h.run(t, tc.run); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestShareSavesGrantsBeforeFailing(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.records.putItemErr = errors.New("dynamo")
	// On the last run, an unsavable file marks the link unavailable.
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if l := h.records.link("ch-sp", spLink); l.Status != "failed" || l.Problem != string(model.SharePointUnavailable) {
		t.Fatalf("link = %+v", l)
	}
}

func TestShareableAndAbsent(t *testing.T) {
	for _, tc := range []struct {
		u                 *model.User
		shareable, absent bool
	}{
		{spUser("a", "oid", nil), true, false},
		{spUser("a", "", nil), false, false},
		{spUser("a", "oid", func(u *model.User) { u.SystemRole = model.SystemRoleGuest }), false, false},
		{spUser("a", "oid", func(u *model.User) { u.AuthProvider = model.AuthProviderGuest }), false, false},
		{spUser("a", "oid", func(u *model.User) { u.Kind = model.UserKindAgent }), true, true},
		{spUser("a", "oid", func(u *model.User) { u.IsBot = true }), true, true},
		{spUser("a", "oid", func(u *model.User) { u.Status = "deactivated" }), true, true},
	} {
		if shareable(tc.u) != tc.shareable || absent(tc.u) != tc.absent {
			t.Errorf("%+v: shareable %v absent %v", tc.u, shareable(tc.u), absent(tc.u))
		}
	}
}

// A permission listed without an email matches nobody by email.
func TestGranteesWithoutEmailMatchNobodyByIt(t *testing.T) {
	h := newSPHarness(t)
	h.members.members["ch-sp"] = []string{"alice", "bob", "noemail"}
	h.users.users["noemail"] = spUser("noemail", "oid-noemail", func(u *model.User) { u.Email = "" })
	h.graph.grantees = []msgraph.Grantee{{ID: "someone-else"}}
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if got := h.graph.invites(); !slices.Equal(got, []string{"oid-bob@tok-alice", "oid-noemail@tok-alice"}) {
		t.Fatalf("invites = %v", got)
	}
}

func TestSharePointFinalAttemptDefault(t *testing.T) {
	// Outside a worker there is no retry to wait for.
	if !sharePointFinalAttempt(context.Background()) {
		t.Fatal("a run with no retry count is the last")
	}
}

func TestEnqueueSharePointFailure(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	dead := redis.NewClient(&redis.Options{Addr: addr, MaxRetries: -1})
	t.Cleanup(func() { _ = dead.Close() })
	sched := NewAsynqPushScheduler(dead)
	t.Cleanup(func() { _ = sched.Close() })
	if err := sched.EnqueueSharePoint(context.Background(), SharePointTask{Kind: sharePointJoined, ParentID: "ch"}); err == nil {
		t.Fatal("want an enqueue error against an unreachable Redis")
	}
}

func TestJobEdgeCases(t *testing.T) {
	h := newSPHarness(t)
	// A link whose file record is already gone drops cleanly.
	h.records.links["ch-sp|"+spLink] = store.SharePointLink{ParentID: "ch-sp", URL: spLink, Status: "shared", PosterID: "alice", ItemID: "missing", MessageIDs: []string{"m-1"}}
	h.post("m-1", "ch-sp", "alice", "no link any more", 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if h.records.link("ch-sp", spLink) != nil {
		t.Fatal("link left behind")
	}

	// A member who already has the file joins again: nobody is invited.
	h.messages.msgs["ch-sp|m-1"].Body = spLink
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	before := len(h.graph.invites())
	h.mustRun(t, SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"bob"}})
	if len(h.graph.invites()) != before {
		t.Fatalf("invites = %v", h.graph.invites())
	}

	// An unreadable conversation, on the last run, marks the link unavailable.
	h.convs.err = errors.New("dynamo")
	h.post("m-2", "dm-x", "alice", spLink, 0)
	h.mustRun(t, SharePointTask{Kind: sharePointMessages, ParentID: "dm-x", ParentType: ParentConversation, MessageIDs: []string{"m-2"}})
	if l := h.records.link("dm-x", spLink); l.Status != "failed" || l.Problem != string(model.SharePointUnavailable) {
		t.Fatalf("link = %+v", l)
	}
}
