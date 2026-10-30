// SharePoint links. A SharePoint or OneDrive link posted in a channel (except
// ~general) or a conversation is shared with every member who can open it:
// edit access, granted without an email, as the person who posted it — with
// their own Microsoft token, never the app's, so nobody can share a file they
// couldn't share themselves, and SharePoint records them as the sharer.
// Members who join later are given access too; members who leave lose the
// access the app gave them, and only that: a permission someone held already
// is never touched. When the last message carrying a link goes, the access it
// gave goes with it. What the poster's token can't do (their sign-in has
// lapsed, say) is remembered and finished at their next sign-in. Everything
// runs as durable background jobs, one parent at a time; sending a message
// never waits for any of it.

package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/hibiken/asynq"
	"golang.org/x/oauth2"
	"golang.org/x/sync/errgroup"
)

// TaskTypeSharePointSync is the asynq task type of every SharePoint job.
const TaskTypeSharePointSync = "sharepoint:sync"

// SharePoint jobs have a queue and workers of their own: sharing with a large
// channel holds a worker for a while, and must never hold one the mobile
// pushes and notification checks need.
const (
	SharePointTaskQueue         = "sharepoint"
	SharePointWorkerConcurrency = 2
)

const (
	// sharePointMaxRetry bounds re-runs of a job Microsoft 365 failed
	// transiently; on the last one the link is marked unavailable instead.
	sharePointMaxRetry = 8
	// sharePointTaskTimeout caps one job: sharing with a large channel is a
	// few hundred invites.
	sharePointTaskTimeout = 10 * time.Minute
	// sharePointInviters bounds the invites in flight for one file.
	sharePointInviters = 4
)

// How long a job waits for another job on the same parent to finish, and how
// often it looks. Vars so tests can shrink them.
var (
	sharePointLockWait = time.Minute
	sharePointLockPoll = 500 * time.Millisecond
)

// sharePointFinalAttempt reports whether this run is the job's last: a
// transient failure then marks the link unavailable rather than waiting for a
// retry that won't come. A var so tests can stage a run with retries left.
var sharePointFinalAttempt = func(ctx context.Context) bool {
	n, ok := asynq.GetRetryCount(ctx)
	limit, _ := asynq.GetMaxRetry(ctx)
	return !ok || n >= limit
}

// Kinds of SharePoint job.
const (
	// sharePointMessages re-reads messages and brings their links in line:
	// share the links they carry, drop the ones they no longer carry.
	sharePointMessages = "messages"
	// sharePointRetry shares a link that failed, as the person retrying it.
	sharePointRetry = "retry"
	// sharePointJoined gives members who joined access to the parent's files.
	sharePointJoined = "joined"
	// sharePointLeft takes back the access the app gave members who left.
	sharePointLeft = "left"
	// sharePointResume finishes, as grantors who signed in again, what their
	// tokens left undone in the parent.
	sharePointResume = "resume"
)

// SharePointTask is the job payload. Jobs carry coordinates, not state: the
// handler reads messages and links as they are when it runs, so jobs for the
// same parent can run in any order.
type SharePointTask struct {
	Kind       string   `json:"kind"`
	ParentID   string   `json:"parentID"`
	ParentType string   `json:"parentType"`
	MessageIDs []string `json:"messageIDs,omitempty"`
	URL        string   `json:"url,omitempty"`
	UserIDs    []string `json:"userIDs,omitempty"`
}

// SharePointQueue durably enqueues SharePoint jobs.
type SharePointQueue interface {
	EnqueueSharePoint(ctx context.Context, t SharePointTask) error
}

// SharePointRecords persists links and shared files.
type SharePointRecords interface {
	GetSharePointLink(ctx context.Context, parentID, url string) (*store.SharePointLink, error)
	ListSharePointLinks(ctx context.Context, parentID string) ([]store.SharePointLink, error)
	PutSharePointLink(ctx context.Context, l *store.SharePointLink) error
	DeleteSharePointLink(ctx context.Context, parentID, url string) error
	GetSharePointItem(ctx context.Context, parentID, id string) (*store.SharePointItem, error)
	ListSharePointItems(ctx context.Context, parentID string) ([]store.SharePointItem, error)
	PutSharePointItem(ctx context.Context, it *store.SharePointItem) error
	DeleteSharePointItem(ctx context.Context, parentID, id string) error
	PutSharePointUnfinished(ctx context.Context, u *store.SharePointUnfinished) error
	ListSharePointUnfinished(ctx context.Context, userID string) ([]store.SharePointUnfinished, error)
	DeleteSharePointUnfinished(ctx context.Context, userID, parentID string) error
}

// SharePointGraph is the delegated Microsoft Graph surface the jobs use.
type SharePointGraph interface {
	ResolveLink(ctx context.Context, ts oauth2.TokenSource, link string) (*msgraph.DriveItem, error)
	Grantees(ctx context.Context, ts oauth2.TokenSource, driveID, itemID string) ([]msgraph.Grantee, error)
	Invite(ctx context.Context, ts oauth2.TokenSource, driveID, itemID, objectID string) (string, error)
	DeletePermission(ctx context.Context, ts oauth2.TokenSource, driveID, itemID, permissionID string) error
	Preview(ctx context.Context, ts oauth2.TokenSource, driveID, itemID string) (*url.URL, error)
}

// SharePointTokens keeps and hands out each user's Microsoft token
// (DelegatedTokens).
type SharePointTokens interface {
	DelegatedTokenSaver
	TokenSource(ctx context.Context, userID string) (oauth2.TokenSource, error)
}

// SharePointLocker serializes the jobs of one parent across instances.
type SharePointLocker interface {
	AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
	ReleaseLock(ctx context.Context, key, token string) error
}

// SharePointMembers lists a channel's members.
type SharePointMembers interface {
	ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error)
}

// SharePointConversations reads a conversation's participants.
type SharePointConversations interface {
	GetConversation(ctx context.Context, id string) (*model.Conversation, error)
}

// SharePointUsers reads the members' accounts.
type SharePointUsers interface {
	GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error)
}

// SharePointMessages reads the messages that carry links.
type SharePointMessages interface {
	GetMessage(ctx context.Context, parentID, id string) (*model.Message, error)
}

// SharePointAccess checks a viewer may read a parent (MessageService).
type SharePointAccess interface {
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// SharePointDeps are the service's collaborators.
type SharePointDeps struct {
	Records       SharePointRecords
	Graph         SharePointGraph
	Tokens        SharePointTokens
	Queue         SharePointQueue
	Locks         SharePointLocker
	Members       SharePointMembers
	Conversations SharePointConversations
	Users         SharePointUsers
	Messages      SharePointMessages
	Access        SharePointAccess
	Publisher     Publisher
	// Hosts are the SharePoint host names whose links are shared; an entry
	// "*.example.com" matches every subdomain of example.com.
	Hosts []string
}

// SharePointService shares posted SharePoint links with their parent's
// members and keeps that access in step with the membership.
type SharePointService struct {
	d SharePointDeps
}

func NewSharePointService(d SharePointDeps) *SharePointService { return &SharePointService{d: d} }

// Hosts are the SharePoint host names whose links are shared.
func (s *SharePointService) Hosts() []string { return s.d.Hosts }

// bodyURLRE and trailingPunctRE find links the way the client does
// (extractURLs in src/lib/format.ts), so the link a card asks about is the
// link the job shared.
var (
	bodyURLRE       = regexp.MustCompile("https?://[^\\s<>\"`]+")
	trailingPunctRE = regexp.MustCompile(`[.,!?;:)\]]+$`)
)

// bodyURLs lists the http(s) links in a message body, outside code.
func bodyURLs(body string) []string {
	var urls []string
	for i := 0; i < len(body); {
		if strings.HasPrefix(body[i:], "```") {
			end := strings.Index(body[i+3:], "```")
			if end < 0 {
				break
			}
			i += 3 + end + 3
			continue
		}
		if body[i] == '`' {
			end := strings.IndexByte(body[i+1:], '`')
			if end < 0 {
				break
			}
			i += 1 + end + 1
			continue
		}
		next := len(body)
		if tick := strings.IndexByte(body[i:], '`'); tick >= 0 {
			next = i + tick
		}
		for _, m := range bodyURLRE.FindAllString(body[i:next], -1) {
			urls = append(urls, trailingPunctRE.ReplaceAllString(m, ""))
		}
		i = next
	}
	return urls
}

// linksIn lists the distinct SharePoint links in a message body.
func (s *SharePointService) linksIn(body string) []string {
	var out []string
	for _, raw := range bodyURLs(body) {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || !matchesHost(s.d.Hosts, u.Hostname()) || slices.Contains(out, raw) {
			continue
		}
		out = append(out, raw)
	}
	return out
}

func matchesHost(hosts []string, host string) bool {
	host = strings.ToLower(host)
	for _, h := range hosts {
		if suffix, ok := strings.CutPrefix(h, "*."); ok {
			if strings.HasSuffix(host, "."+suffix) {
				return true
			}
		} else if host == h {
			return true
		}
	}
	return false
}

// shares reports whether a message's links are shared: posted by a person
// (not a webhook, an agent or the system) anywhere but ~general.
func shares(msg *model.Message) bool {
	return msg.ParentID != generalChannelID && !msg.System && !msg.Deleted && msg.WebhookID == "" && msg.AgentInvokerID == ""
}

// MessageSent queues the sharing of a new message's SharePoint links.
func (s *SharePointService) MessageSent(ctx context.Context, msg *model.Message, parentType string) {
	if shares(msg) && len(s.linksIn(msg.Body)) > 0 {
		s.enqueue(ctx, SharePointTask{Kind: sharePointMessages, ParentID: msg.ParentID, ParentType: parentType, MessageIDs: []string{msg.ID}})
	}
}

// MessageEdited queues bringing an edited message's links in line: links it
// gained are shared, links it lost are dropped.
func (s *SharePointService) MessageEdited(ctx context.Context, before, after *model.Message, parentType string) {
	if after.ParentID != generalChannelID && len(s.linksIn(before.Body))+len(s.linksIn(after.Body)) > 0 {
		s.enqueue(ctx, SharePointTask{Kind: sharePointMessages, ParentID: after.ParentID, ParentType: parentType, MessageIDs: []string{after.ID}})
	}
}

// MessagesDeleted queues dropping the links the deleted messages carried.
func (s *SharePointService) MessagesDeleted(ctx context.Context, parentID, parentType string, ids []string) {
	if parentID != generalChannelID && len(ids) > 0 {
		s.enqueue(ctx, SharePointTask{Kind: sharePointMessages, ParentID: parentID, ParentType: parentType, MessageIDs: ids})
	}
}

// MemberJoined queues giving a new channel member access to its files.
func (s *SharePointService) MemberJoined(ctx context.Context, channelID, userID string) {
	if channelID != generalChannelID {
		s.enqueue(ctx, SharePointTask{Kind: sharePointJoined, ParentID: channelID, ParentType: ParentChannel, UserIDs: []string{userID}})
	}
}

// ParentLeft queues taking back the access the app gave members who left a
// channel or were removed from it.
func (s *SharePointService) ParentLeft(ctx context.Context, userIDs []string, parentID string) {
	if parentID != generalChannelID && len(userIDs) > 0 {
		s.enqueue(ctx, SharePointTask{Kind: sharePointLeft, ParentID: parentID, ParentType: ParentChannel, UserIDs: userIDs})
	}
}

func (s *SharePointService) enqueue(ctx context.Context, t SharePointTask) {
	if err := s.d.Queue.EnqueueSharePoint(ctx, t); err != nil {
		slog.ErrorContext(ctx, "sharepoint job not queued", "kind", t.Kind, "parentID", t.ParentID, "error", err)
	}
}

// SaveDelegatedToken keeps an SSO login's Microsoft token, then queues
// finishing what the user's token couldn't do before: access it couldn't
// take back, members it couldn't share with.
func (s *SharePointService) SaveDelegatedToken(ctx context.Context, userID string, tok *oauth2.Token) error {
	if err := s.d.Tokens.SaveDelegatedToken(ctx, userID, tok); err != nil {
		return err
	}
	unfinished, err := s.d.Records.ListSharePointUnfinished(ctx, userID)
	if err != nil {
		slog.WarnContext(ctx, "sharepoint unfinished work not resumed", "userID", userID, "error", err)
		return nil
	}
	for _, u := range unfinished {
		s.enqueue(ctx, SharePointTask{Kind: sharePointResume, ParentID: u.ParentID, ParentType: u.ParentType, UserIDs: []string{userID}})
	}
	return nil
}

// Link returns a posted link as viewerID may see it, or nil when the link
// was never shared (it predates sharing, or was posted in ~general).
func (s *SharePointService) Link(ctx context.Context, viewerID, parentID, parentType, rawURL string) (*model.SharePointLink, error) {
	if err := s.d.Access.CheckAccess(ctx, viewerID, parentID, parentType); err != nil {
		return nil, err
	}
	l, err := s.d.Records.GetSharePointLink(ctx, parentID, rawURL)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("sharepoint: read link: %w", err)
	}
	view := &model.SharePointLink{URL: l.URL, Status: model.SharePointStatus(l.Status), PosterID: l.PosterID}
	var it *store.SharePointItem
	if l.ItemID != "" {
		it, err = s.d.Records.GetSharePointItem(ctx, parentID, l.ItemID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			it = nil
		case err != nil:
			return nil, fmt.Errorf("sharepoint: read file: %w", err)
		default:
			view.File = fileOf(it)
		}
	}
	if viewerID == l.PosterID {
		view.Problem = model.SharePointProblem(l.Problem)
		if it != nil {
			view.SharedWith = len(it.Grants)
			view.NotShared = it.NotShared
		}
	}
	return view, nil
}

// RetryLink queues sharing a link that failed again, as the person who
// posted it (after they signed in again, say).
func (s *SharePointService) RetryLink(ctx context.Context, userID, parentID, parentType, rawURL string) error {
	if err := s.d.Access.CheckAccess(ctx, userID, parentID, parentType); err != nil {
		return err
	}
	l, err := s.d.Records.GetSharePointLink(ctx, parentID, rawURL)
	if errors.Is(err, store.ErrNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("sharepoint: read link: %w", err)
	}
	if l.PosterID != userID {
		return ErrForbidden
	}
	if l.Status != string(model.SharePointFailed) {
		return nil
	}
	return s.d.Queue.EnqueueSharePoint(ctx, SharePointTask{Kind: sharePointRetry, ParentID: parentID, ParentType: parentType, URL: rawURL, UserIDs: []string{userID}})
}

// Preview returns a short-lived address that shows a shared file as it is
// (Office for the web's viewer), for the viewer's lightbox. It is fetched
// with the viewer's own Microsoft token and carries their access, so it
// shows only what they may open themselves. ErrForbidden when ex holds no
// working sign-in of theirs; ErrNotFound when the file isn't theirs to see
// or has no preview.
func (s *SharePointService) Preview(ctx context.Context, viewerID, parentID, parentType, fileID string) (string, error) {
	if err := s.d.Access.CheckAccess(ctx, viewerID, parentID, parentType); err != nil {
		return "", err
	}
	it, err := s.d.Records.GetSharePointItem(ctx, parentID, fileID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return "", ErrNotFound
	case err != nil:
		return "", fmt.Errorf("sharepoint: read file: %w", err)
	case it.Retired || it.Folder:
		return "", ErrNotFound
	}
	ts, err := s.d.Tokens.TokenSource(ctx, viewerID)
	if err == nil {
		var u *url.URL
		if u, err = s.d.Graph.Preview(ctx, ts, it.DriveID, it.ItemID); err == nil {
			// The lightbox frames it: only a host the app may frame.
			if !matchesHost(s.d.Hosts, u.Hostname()) {
				return "", fmt.Errorf("sharepoint: preview on %q, not a SharePoint host", u.Hostname())
			}
			return u.String(), nil
		}
	}
	switch sharePointProblem(err) {
	case model.SharePointSignIn:
		return "", ErrForbidden
	case model.SharePointDenied, model.SharePointNotFound:
		return "", ErrNotFound
	}
	return "", fmt.Errorf("sharepoint: preview: %w", err)
}

// SharePointFileEntry is a file shared in a parent, for the Files panel.
type SharePointFileEntry struct {
	File      *model.SharePointFile
	MessageID string
	AuthorID  string
	SharedAt  time.Time
}

// Files lists the SharePoint files shared in a parent.
func (s *SharePointService) Files(ctx context.Context, parentID string) ([]SharePointFileEntry, error) {
	items, err := s.d.Records.ListSharePointItems(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("sharepoint: list files: %w", err)
	}
	out := make([]SharePointFileEntry, 0, len(items))
	for i := range items {
		it := &items[i]
		if it.Retired {
			continue
		}
		out = append(out, SharePointFileEntry{File: fileOf(it), MessageID: it.MessageID, AuthorID: it.AuthorID, SharedAt: it.SharedAt})
	}
	return out, nil
}

func fileOf(it *store.SharePointItem) *model.SharePointFile {
	return &model.SharePointFile{
		ID: it.ID, Name: it.Name, Size: it.Size, Folder: it.Folder, MimeType: it.MimeType,
		WebURL: it.WebURL, EditURL: it.EditURL, DownloadURL: it.DownloadURL,
	}
}

// TaskHandler runs SharePoint jobs, one parent at a time.
func (s *SharePointService) TaskHandler() func(context.Context, *asynq.Task) error {
	return func(ctx context.Context, t *asynq.Task) error {
		var task SharePointTask
		if err := json.Unmarshal(t.Payload(), &task); err != nil {
			return fmt.Errorf("sharepoint task payload: %v: %w", err, asynq.SkipRetry)
		}
		if task.ParentID == generalChannelID {
			return nil
		}
		unlock, err := s.lock(ctx, task.ParentID)
		if err != nil {
			return err
		}
		defer unlock()
		j := &sharePointJob{s: s, task: task}
		switch task.Kind {
		case sharePointMessages:
			err = j.syncMessages(ctx)
		case sharePointRetry:
			err = j.retry(ctx)
		case sharePointJoined:
			err = j.joined(ctx)
		case sharePointLeft:
			err = j.left(ctx)
		case sharePointResume:
			err = j.resume(ctx)
		default:
			return fmt.Errorf("sharepoint: unknown job kind %q: %w", task.Kind, asynq.SkipRetry)
		}
		j.publish(ctx)
		if settleErr := j.settle(ctx, err); err == nil {
			err = settleErr
		}
		return err
	}
}

var errSharePointBusy = errors.New("sharepoint: another job holds the parent")

func (s *SharePointService) lock(ctx context.Context, parentID string) (func(), error) {
	key, token := "sharepoint:lock:"+parentID, store.NewID()
	deadline := time.Now().Add(sharePointLockWait)
	for {
		ok, err := s.d.Locks.AcquireLock(ctx, key, token, sharePointTaskTimeout)
		if err != nil {
			return nil, err
		}
		if ok {
			return func() {
				if err := s.d.Locks.ReleaseLock(context.WithoutCancel(ctx), key, token); err != nil {
					slog.WarnContext(ctx, "sharepoint lock not released", "parentID", parentID, "error", err)
				}
			}, nil
		}
		if time.Now().After(deadline) {
			return nil, errSharePointBusy
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(sharePointLockPoll):
		}
	}
}

// sharePointJob is one run of a job: the task, the links it changed, which
// it announces when it ends, and the grantors whose tokens left work undone.
type sharePointJob struct {
	s       *SharePointService
	task    SharePointTask
	changed []string // the link URLs that changed
	all     bool     // every link may have changed (a member joined or left)
	owed    []string // grantors whose next sign-in finishes this parent
}

// owe leaves what the file's grantor couldn't do here to their next sign-in.
func (j *sharePointJob) owe(it *store.SharePointItem) {
	if !slices.Contains(j.owed, it.GrantorID) {
		j.owed = append(j.owed, it.GrantorID)
	}
}

// settle marks the parent unfinished for each grantor the job owes; a resume
// that finished (err is the job's own) clears its grantors' marks.
func (j *sharePointJob) settle(ctx context.Context, err error) error {
	d := j.s.d
	for _, uid := range j.owed {
		u := &store.SharePointUnfinished{UserID: uid, ParentID: j.task.ParentID, ParentType: j.task.ParentType}
		if err := d.Records.PutSharePointUnfinished(ctx, u); err != nil {
			return fmt.Errorf("sharepoint: save unfinished: %w", err)
		}
	}
	if j.task.Kind != sharePointResume || err != nil {
		return nil
	}
	for _, uid := range j.task.UserIDs {
		if slices.Contains(j.owed, uid) {
			continue
		}
		if err := d.Records.DeleteSharePointUnfinished(ctx, uid, j.task.ParentID); err != nil {
			return fmt.Errorf("sharepoint: clear unfinished: %w", err)
		}
	}
	return nil
}

func (j *sharePointJob) touched(urls ...string) {
	for _, u := range urls {
		if !slices.Contains(j.changed, u) {
			j.changed = append(j.changed, u)
		}
	}
}

// publish tells the parent's members which links changed.
func (j *sharePointJob) publish(ctx context.Context) {
	switch {
	case j.all:
		j.announce(ctx, []string{}) // an empty list means every link
	case len(j.changed) > 0:
		j.announce(ctx, j.changed)
	}
}

func (j *sharePointJob) announce(ctx context.Context, urls []string) {
	topic := pubsub.ChannelName(j.task.ParentID)
	if j.task.ParentType == ParentConversation {
		topic = pubsub.ConversationName(j.task.ParentID)
	}
	events.Publish(ctx, j.s.d.Publisher, topic, events.EventSharePointChanged, model.SharePointChangedEvent{
		ParentID: j.task.ParentID, ParentType: j.task.ParentType, URLs: urls,
	})
}

func (j *sharePointJob) syncMessages(ctx context.Context) error {
	d := j.s.d
	links, err := d.Records.ListSharePointLinks(ctx, j.task.ParentID)
	if err != nil {
		return fmt.Errorf("sharepoint: list links: %w", err)
	}
	byURL := make(map[string]*store.SharePointLink, len(links))
	for i := range links {
		byURL[links[i].URL] = &links[i]
	}
	for _, id := range j.task.MessageIDs {
		msg, err := d.Messages.GetMessage(ctx, j.task.ParentID, id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("sharepoint: read message: %w", err)
		}
		var urls []string
		if msg != nil && shares(msg) {
			urls = j.s.linksIn(msg.Body)
		}
		// Links the message no longer carries.
		for _, u := range slices.Sorted(maps.Keys(byURL)) {
			if l := byURL[u]; slices.Contains(l.MessageIDs, id) && !slices.Contains(urls, u) {
				if err := j.dropRef(ctx, byURL, l, id); err != nil {
					return err
				}
			}
		}
		for _, u := range urls {
			if err := j.addRef(ctx, byURL, u, msg); err != nil {
				return err
			}
		}
	}
	return nil
}

// addRef records that msg carries the link, sharing the link unless it is
// shared already. A link that failed stays failed when the same message is
// merely edited; a new message posting it tries again, as its author.
func (j *sharePointJob) addRef(ctx context.Context, byURL map[string]*store.SharePointLink, rawURL string, msg *model.Message) error {
	l := byURL[rawURL]
	if l == nil {
		l = &store.SharePointLink{ParentID: j.task.ParentID, URL: rawURL, CreatedAt: time.Now()}
		byURL[rawURL] = l
	} else if slices.Contains(l.MessageIDs, msg.ID) && l.Status != string(model.SharePointPending) {
		return nil
	}
	if !slices.Contains(l.MessageIDs, msg.ID) {
		l.MessageIDs = append(l.MessageIDs, msg.ID)
	}
	if l.Status == string(model.SharePointShared) {
		return j.reshared(ctx, l, msg)
	}
	l.PosterID = msg.AuthorID
	return j.share(ctx, l, msg)
}

// reshared records another message carrying a shared link: the Files panel
// lists the file at its latest share.
func (j *sharePointJob) reshared(ctx context.Context, l *store.SharePointLink, msg *model.Message) error {
	d := j.s.d
	it, err := d.Records.GetSharePointItem(ctx, j.task.ParentID, l.ItemID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("sharepoint: read file: %w", err)
	}
	if it == nil {
		// The file record went missing: share the link afresh.
		l.PosterID = msg.AuthorID
		return j.share(ctx, l, msg)
	}
	touchItem(it, msg)
	if err := d.Records.PutSharePointItem(ctx, it); err != nil {
		return fmt.Errorf("sharepoint: save file: %w", err)
	}
	if err := d.Records.PutSharePointLink(ctx, l); err != nil {
		return fmt.Errorf("sharepoint: save link: %w", err)
	}
	j.touched(l.URL)
	return nil
}

func touchItem(it *store.SharePointItem, msg *model.Message) {
	if it.MessageID == "" || msg.CreatedAt.After(it.SharedAt) {
		it.MessageID, it.AuthorID, it.SharedAt = msg.ID, msg.AuthorID, msg.CreatedAt
	}
}

// dropRef records that message id no longer carries the link. The last
// message gone, the link goes, and so does the access it gave — unless
// another link in the parent leads to the same file.
func (j *sharePointJob) dropRef(ctx context.Context, byURL map[string]*store.SharePointLink, l *store.SharePointLink, id string) error {
	d := j.s.d
	l.MessageIDs = slices.DeleteFunc(l.MessageIDs, func(m string) bool { return m == id })
	j.touched(l.URL)
	if len(l.MessageIDs) > 0 {
		if err := d.Records.PutSharePointLink(ctx, l); err != nil {
			return fmt.Errorf("sharepoint: save link: %w", err)
		}
		return nil
	}
	delete(byURL, l.URL)
	if l.ItemID != "" && !slices.ContainsFunc(slices.Collect(maps.Values(byURL)), func(o *store.SharePointLink) bool { return o.ItemID == l.ItemID }) {
		// Take the access back first: should that fail, the job runs again
		// and finds the link still here.
		if err := j.retire(ctx, l.ItemID); err != nil {
			return err
		}
	}
	if err := d.Records.DeleteSharePointLink(ctx, j.task.ParentID, l.URL); err != nil {
		return fmt.Errorf("sharepoint: delete link: %w", err)
	}
	return nil
}

// retire takes back the access a file was given and forgets it.
func (j *sharePointJob) retire(ctx context.Context, itemID string) error {
	d := j.s.d
	it, err := d.Records.GetSharePointItem(ctx, j.task.ParentID, itemID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("sharepoint: read file: %w", err)
	}
	if err := j.revoke(ctx, it, slices.Collect(maps.Keys(it.Grants))); err != nil {
		return err
	}
	return j.forget(ctx, it)
}

// forget deletes a file whose links have all gone, or retires it while some
// of the access it gave is still out there.
func (j *sharePointJob) forget(ctx context.Context, it *store.SharePointItem) error {
	d := j.s.d
	if len(it.Grants) > 0 {
		it.Retired = true
		if err := d.Records.PutSharePointItem(ctx, it); err != nil {
			return fmt.Errorf("sharepoint: save file: %w", err)
		}
		return nil
	}
	if err := d.Records.DeleteSharePointItem(ctx, j.task.ParentID, it.ID); err != nil {
		return fmt.Errorf("sharepoint: delete file: %w", err)
	}
	return nil
}

// share resolves a link as its poster and shares the file with the parent's
// members. Problems only the poster can fix (sign in again, a file they may
// not share) mark the link failed; a transient failure retries the job.
func (j *sharePointJob) share(ctx context.Context, l *store.SharePointLink, msg *model.Message) error {
	d := j.s.d
	l.Status, l.Problem, l.UpdatedAt = string(model.SharePointPending), "", time.Now()
	if err := d.Records.PutSharePointLink(ctx, l); err != nil {
		return fmt.Errorf("sharepoint: save link: %w", err)
	}
	// Sharing with a large channel takes a while: the card says so meanwhile.
	j.announce(ctx, []string{l.URL})
	j.touched(l.URL)
	ts, err := d.Tokens.TokenSource(ctx, l.PosterID)
	if err != nil {
		return j.failed(ctx, l, err)
	}
	item, err := d.Graph.ResolveLink(ctx, ts, l.URL)
	if err != nil {
		return j.failed(ctx, l, err)
	}
	id := store.SharePointItemID(item.ParentReference.DriveID, item.ID)
	it, err := d.Records.GetSharePointItem(ctx, j.task.ParentID, id)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return j.failed(ctx, l, err)
	}
	if it == nil {
		it = &store.SharePointItem{
			ParentID: j.task.ParentID, ID: id, DriveID: item.ParentReference.DriveID, ItemID: item.ID,
			GrantorID: l.PosterID, Grants: map[string]string{},
		}
	}
	it.Name, it.Size, it.Folder, it.WebURL, it.EditURL = item.Name, item.Size, item.Folder != nil, item.WebURL, item.EditURL()
	it.DownloadURL = item.DownloadURL()
	// A retired file shared again keeps the access still out there.
	it.Retired = false
	if item.File != nil {
		it.MimeType = item.File.MimeType
	}
	touchItem(it, msg)
	it.UpdatedAt = time.Now()
	l.ItemID = id
	members, err := j.members(ctx)
	if err != nil {
		return j.failed(ctx, l, err)
	}
	grantErr := j.grant(ctx, it, ts, without(members, l.PosterID))
	// Keep what was granted, whatever happened after.
	if err := d.Records.PutSharePointItem(ctx, it); err != nil {
		return j.failed(ctx, l, fmt.Errorf("sharepoint: save file: %w", err))
	}
	if grantErr != nil {
		return j.failed(ctx, l, grantErr)
	}
	l.Status, l.UpdatedAt = string(model.SharePointShared), time.Now()
	if err := d.Records.PutSharePointLink(ctx, l); err != nil {
		return fmt.Errorf("sharepoint: save link: %w", err)
	}
	return nil
}

// failed records why a link was not shared. A transient failure with retries
// left is returned, so the job runs again and the link stays pending.
func (j *sharePointJob) failed(ctx context.Context, l *store.SharePointLink, err error) error {
	problem := sharePointProblem(err)
	if problem == model.SharePointUnavailable && !sharePointFinalAttempt(ctx) {
		return err
	}
	slog.WarnContext(ctx, "sharepoint link not shared", "parentID", l.ParentID, "posterID", l.PosterID, "problem", problem, "error", err)
	l.Status, l.Problem, l.UpdatedAt = string(model.SharePointFailed), string(problem), time.Now()
	if err := j.s.d.Records.PutSharePointLink(ctx, l); err != nil {
		return fmt.Errorf("sharepoint: save link: %w", err)
	}
	return nil
}

func sharePointProblem(err error) model.SharePointProblem {
	switch {
	case errors.Is(err, ErrNoDelegatedToken), errors.Is(err, msgraph.ErrSignInRequired):
		return model.SharePointSignIn
	case errors.Is(err, msgraph.ErrForbidden):
		return model.SharePointDenied
	case errors.Is(err, msgraph.ErrNotFound):
		return model.SharePointNotFound
	default:
		return model.SharePointUnavailable
	}
}

// members lists the parent's members.
func (j *sharePointJob) members(ctx context.Context) ([]string, error) {
	d := j.s.d
	channelID := j.task.ParentID
	if j.task.ParentType == ParentConversation {
		conv, err := d.Conversations.GetConversation(ctx, j.task.ParentID)
		if err != nil {
			return nil, fmt.Errorf("sharepoint: read conversation: %w", err)
		}
		if conv.ConvertedToChannelID == "" {
			return conv.ParticipantIDs, nil
		}
		channelID = conv.ConvertedToChannelID
	}
	mems, err := d.Members.ListMembers(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("sharepoint: list members: %w", err)
	}
	ids := make([]string, 0, len(mems))
	for _, m := range mems {
		ids = append(ids, m.UserID)
	}
	return ids, nil
}

func without(ids []string, drop string) []string {
	return slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return id == drop })
}

// absent reports a member nobody would expect to have the file: a machine
// account, or an account that is gone. They are passed over without a word.
func absent(u *model.User) bool {
	return u.IsBot || u.IsAgent() || u.Status == "deactivated"
}

// shareable reports whether a person can be given access: one with a
// Microsoft directory account, not a guest. The poster hears about the rest.
func shareable(u *model.User) bool {
	return u.MSObjectID != "" && u.AuthProvider != model.AuthProviderGuest && u.SystemRole != model.SystemRoleGuest
}

// grant gives the members who don't have it yet edit access, as ts. Members
// who already hold a permission of their own are recorded without one, so
// leaving never takes away access the app didn't give. A refusal that is the
// poster's to fix stops it; members Microsoft 365 failed transiently are
// retried with the job, or listed as not shared on its last run.
func (j *sharePointJob) grant(ctx context.Context, it *store.SharePointItem, ts oauth2.TokenSource, userIDs []string) error {
	d := j.s.d
	userIDs = slices.DeleteFunc(slices.Clone(userIDs), func(id string) bool {
		_, granted := it.Grants[id]
		return granted
	})
	if len(userIDs) == 0 {
		return nil
	}
	users, err := d.Users.GetUsersByIDs(ctx, userIDs)
	if err != nil {
		return fmt.Errorf("sharepoint: read members: %w", err)
	}
	var invite []*model.User
	for _, u := range users {
		switch {
		case absent(u):
		case shareable(u):
			invite = append(invite, u)
		default:
			addNotShared(it, u.ID)
		}
	}
	if len(invite) == 0 {
		return nil
	}
	grantees, err := d.Graph.Grantees(ctx, ts, it.DriveID, it.ItemID)
	if err != nil {
		return err
	}
	had := map[string]bool{}
	for _, g := range grantees {
		for _, key := range []string{g.ID, g.Email} {
			if key != "" {
				had[strings.ToLower(key)] = true
			}
		}
	}
	var (
		mu      sync.Mutex
		failed  []string
		lastErr error
		g       errgroup.Group
	)
	g.SetLimit(sharePointInviters)
	for _, u := range invite {
		if had[strings.ToLower(u.MSObjectID)] || (u.Email != "" && had[strings.ToLower(u.Email)]) {
			it.Grants[u.ID] = ""
			removeNotShared(it, u.ID)
			continue
		}
		g.Go(func() error {
			perm, err := d.Graph.Invite(ctx, ts, it.DriveID, it.ItemID, u.MSObjectID)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				it.Grants[u.ID] = perm
				removeNotShared(it, u.ID)
			case sharePointProblem(err) != model.SharePointUnavailable:
				return err
			default:
				failed, lastErr = append(failed, u.ID), err
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	if len(failed) > 0 {
		if !sharePointFinalAttempt(ctx) {
			return lastErr
		}
		addNotShared(it, failed...)
		j.owe(it)
	}
	return nil
}

func addNotShared(it *store.SharePointItem, ids ...string) {
	for _, id := range ids {
		if !slices.Contains(it.NotShared, id) {
			it.NotShared = append(it.NotShared, id)
		}
	}
}

func removeNotShared(it *store.SharePointItem, id string) {
	it.NotShared = slices.DeleteFunc(it.NotShared, func(n string) bool { return n == id })
}

// revoke takes back the permissions the app created for these members, as
// the file's grantor. When the grantor's token can no longer do it, the
// access stays until their next sign-in: nobody else's token may act for
// them.
func (j *sharePointJob) revoke(ctx context.Context, it *store.SharePointItem, userIDs []string) error {
	d := j.s.d
	var ts oauth2.TokenSource
	for _, uid := range slices.Sorted(slices.Values(userIDs)) {
		perm, ok := it.Grants[uid]
		if !ok {
			continue
		}
		if perm != "" {
			if ts == nil {
				var err error
				if ts, err = d.Tokens.TokenSource(ctx, it.GrantorID); err != nil {
					return j.unrevoked(ctx, it, err)
				}
			}
			if err := d.Graph.DeletePermission(ctx, ts, it.DriveID, it.ItemID, perm); err != nil {
				return j.unrevoked(ctx, it, err)
			}
		}
		delete(it.Grants, uid)
	}
	return nil
}

func (j *sharePointJob) unrevoked(ctx context.Context, it *store.SharePointItem, err error) error {
	if sharePointProblem(err) == model.SharePointUnavailable && !sharePointFinalAttempt(ctx) {
		return err
	}
	slog.WarnContext(ctx, "sharepoint access not taken back", "parentID", it.ParentID, "fileID", it.ID, "grantorID", it.GrantorID, "error", err)
	j.owe(it)
	return nil
}

// joined gives members who joined access to every file shared in the
// parent, as each file's grantor.
func (j *sharePointJob) joined(ctx context.Context) error {
	d := j.s.d
	items, err := d.Records.ListSharePointItems(ctx, j.task.ParentID)
	if err != nil {
		return fmt.Errorf("sharepoint: list files: %w", err)
	}
	for i := range items {
		it := &items[i]
		if it.Retired {
			continue
		}
		users := without(j.task.UserIDs, it.GrantorID)
		gaveUp, retry := j.grantAsGrantor(ctx, it, users)
		if gaveUp {
			for _, u := range users {
				if _, ok := it.Grants[u]; !ok {
					addNotShared(it, u)
				}
			}
		}
		if err := d.Records.PutSharePointItem(ctx, it); err != nil {
			return fmt.Errorf("sharepoint: save file: %w", err)
		}
		if retry != nil {
			return retry
		}
		j.all = true
	}
	return nil
}

// grantAsGrantor gives users access as the file's grantor. A transient
// failure with retries left is returned for the job to run again; any other
// is left for the grantor's next sign-in (gaveUp).
func (j *sharePointJob) grantAsGrantor(ctx context.Context, it *store.SharePointItem, users []string) (gaveUp bool, retry error) {
	ts, err := j.s.d.Tokens.TokenSource(ctx, it.GrantorID)
	if err == nil {
		err = j.grant(ctx, it, ts, users)
	}
	switch {
	case err == nil:
		return false, nil
	case sharePointProblem(err) == model.SharePointUnavailable && !sharePointFinalAttempt(ctx):
		return false, err
	}
	slog.WarnContext(ctx, "sharepoint file not shared with members", "parentID", it.ParentID, "fileID", it.ID, "grantorID", it.GrantorID, "error", err)
	j.owe(it)
	return true, nil
}

// left takes back the access the app gave members who left.
func (j *sharePointJob) left(ctx context.Context) error {
	d := j.s.d
	items, err := d.Records.ListSharePointItems(ctx, j.task.ParentID)
	if err != nil {
		return fmt.Errorf("sharepoint: list files: %w", err)
	}
	for i := range items {
		it := &items[i]
		if it.Retired {
			continue
		}
		before := len(it.Grants) + len(it.NotShared)
		if err := j.revoke(ctx, it, j.task.UserIDs); err != nil {
			return err
		}
		for _, u := range j.task.UserIDs {
			removeNotShared(it, u)
		}
		if len(it.Grants)+len(it.NotShared) == before {
			continue
		}
		if err := d.Records.PutSharePointItem(ctx, it); err != nil {
			return fmt.Errorf("sharepoint: save file: %w", err)
		}
		j.all = true
	}
	return nil
}

// resume finishes, as grantors who signed in again, what their tokens left
// undone here: each of their files gets back in line with the members.
func (j *sharePointJob) resume(ctx context.Context) error {
	d := j.s.d
	items, err := d.Records.ListSharePointItems(ctx, j.task.ParentID)
	if err != nil {
		return fmt.Errorf("sharepoint: list files: %w", err)
	}
	members, err := j.members(ctx)
	if err != nil {
		return err
	}
	for i := range items {
		it := &items[i]
		if !slices.Contains(j.task.UserIDs, it.GrantorID) {
			continue
		}
		if err := j.reconcile(ctx, it, members); err != nil {
			return err
		}
		j.all = true
	}
	return nil
}

// reconcile takes back the access of members who have gone (of everyone,
// for a retired file) and gives it to members who still lack it.
func (j *sharePointJob) reconcile(ctx context.Context, it *store.SharePointItem, members []string) error {
	keep := members
	if it.Retired {
		keep = nil
	}
	var gone []string
	for uid := range it.Grants {
		if !slices.Contains(keep, uid) {
			gone = append(gone, uid)
		}
	}
	if err := j.revoke(ctx, it, gone); err != nil {
		return err
	}
	it.NotShared = slices.DeleteFunc(it.NotShared, func(uid string) bool { return !slices.Contains(keep, uid) })
	if it.Retired {
		return j.forget(ctx, it)
	}
	_, retry := j.grantAsGrantor(ctx, it, without(members, it.GrantorID))
	if err := j.s.d.Records.PutSharePointItem(ctx, it); err != nil {
		return fmt.Errorf("sharepoint: save file: %w", err)
	}
	return retry
}

// retry shares a failed link again, as the person retrying it.
func (j *sharePointJob) retry(ctx context.Context) error {
	d := j.s.d
	l, err := d.Records.GetSharePointLink(ctx, j.task.ParentID, j.task.URL)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("sharepoint: read link: %w", err)
	}
	// Pending: an earlier run of this retry broke off.
	if l.Status == string(model.SharePointShared) || len(l.MessageIDs) == 0 || len(j.task.UserIDs) == 0 {
		return nil
	}
	msg, err := d.Messages.GetMessage(ctx, j.task.ParentID, l.MessageIDs[len(l.MessageIDs)-1])
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("sharepoint: read message: %w", err)
	}
	l.PosterID = j.task.UserIDs[0]
	return j.share(ctx, l, msg)
}

// EnqueueSharePoint queues a SharePoint job on the app's one asynq producer.
func (s *AsynqPushScheduler) EnqueueSharePoint(ctx context.Context, t SharePointTask) error {
	payload := mustJSONBody(json.Marshal(t))
	if _, err := s.client.EnqueueContext(ctx, asynq.NewTask(TaskTypeSharePointSync, payload),
		asynq.Queue(SharePointTaskQueue),
		asynq.MaxRetry(sharePointMaxRetry),
		asynq.Timeout(sharePointTaskTimeout),
	); err != nil {
		return fmt.Errorf("sharepoint: enqueue: %w", err)
	}
	return nil
}
