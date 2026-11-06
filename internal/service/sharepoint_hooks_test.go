package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"golang.org/x/oauth2"
)

// spHooks records what the message and channel services tell SharePoint.
type spHooks struct {
	mu       sync.Mutex
	sent     []string
	edited   []string // "before→after"
	deleted  [][]string
	joined   []string // "channel:user"
	left     [][]string
	files    []SharePointFileEntry
	filesErr error
}

func (h *spHooks) MessageSent(_ context.Context, msg *model.Message, _ string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sent = append(h.sent, msg.ID)
}

func (h *spHooks) MessageEdited(_ context.Context, before, after *model.Message, _ string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.edited = append(h.edited, before.Body+"→"+after.Body)
}

func (h *spHooks) MessagesDeleted(_ context.Context, _, _ string, ids []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.deleted = append(h.deleted, ids)
}

func (h *spHooks) Files(context.Context, string) ([]SharePointFileEntry, error) {
	return h.files, h.filesErr
}

func (h *spHooks) MemberJoined(_ context.Context, channelID, userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.joined = append(h.joined, channelID+":"+userID)
}

func (h *spHooks) ParentLeft(_ context.Context, userIDs []string, _ string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.left = append(h.left, userIDs)
}

func TestMessagesTellSharePoint(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	hooks := &spHooks{}
	svc.SetSharePoint(hooks)
	grantChannelMember(memberships, "ch1", "u1")
	ctx := context.Background()

	msg, err := svc.Send(ctx, "u1", "ch1", ParentChannel, "plan "+spLink, "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !slices.Equal(hooks.sent, []string{msg.ID}) {
		t.Fatalf("sent = %v", hooks.sent)
	}
	if _, err := svc.Edit(ctx, "u1", "ch1", ParentChannel, msg.ID, "no link", nil); err != nil {
		t.Fatalf("Edit: %v", err)
	}
	// An edit that leaves the text alone says nothing.
	if _, err := svc.Edit(ctx, "u1", "ch1", ParentChannel, msg.ID, "no link", nil); err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if !slices.Equal(hooks.edited, []string{"plan " + spLink + "→no link"}) {
		t.Fatalf("edited = %v", hooks.edited)
	}
	if err := svc.Delete(ctx, "u1", "ch1", ParentChannel, msg.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(hooks.deleted) != 1 || hooks.deleted[0][0] != msg.ID {
		t.Fatalf("deleted = %v", hooks.deleted)
	}
}

func TestListFilesListsSharePointFiles(t *testing.T) {
	f := newFilesFixture(t)
	hooks := &spHooks{files: []SharePointFileEntry{{
		File:      &model.SharePointFile{ID: "file-1", Name: "Budget.xlsx", WebURL: "https://contoso.sharepoint.com/b"},
		MessageID: "m-sp", AuthorID: "u-carol", SharedAt: f.base.Add(5 * time.Minute),
	}}}
	f.svc.SetSharePoint(hooks)
	f.share("att-old", "old.pdf", "m-1", 0)
	f.share("att-new", "new.png", "m-2", 10)

	page := f.list(t, FileQuery{})
	if got := fileIDs(page); !slices.Equal(got, []string{"att-new", "sp:file-1", "att-old"}) {
		t.Fatalf("order = %v", got)
	}
	sp := page.Files[1]
	if sp.SharePoint == nil || sp.SharePoint.Name != "Budget.xlsx" || sp.Attachment != nil || sp.MessageID != "m-sp" || sp.AuthorID != "u-carol" {
		t.Fatalf("sharepoint entry = %+v", sp)
	}
	// The search matches SharePoint files by name too, without reading
	// attachments for them.
	page = f.list(t, FileQuery{Query: "budget"})
	if got := fileIDs(page); !slices.Equal(got, []string{"sp:file-1"}) {
		t.Fatalf("search = %v", got)
	}
	// A page of SharePoint files alone reads no messages.
	f.messages.messages = map[string]*model.Message{}
	if got := fileIDs(f.list(t, FileQuery{Query: "budget"})); !slices.Equal(got, []string{"sp:file-1"}) {
		t.Fatalf("search without messages = %v", got)
	}

	hooks.filesErr = errors.New("dynamo")
	if _, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, FileQuery{}); err == nil {
		t.Fatal("want the SharePoint list error")
	}
}

func TestChannelMembershipTellsSharePoint(t *testing.T) {
	svc, _, _, users, _, _ := setupChannelServiceWithUsers()
	users.users["owner"] = &model.User{ID: "owner", DisplayName: "Owner", SystemRole: model.SystemRoleMember, Status: "active"}
	users.users["u-join"] = &model.User{ID: "u-join", DisplayName: "Join", SystemRole: model.SystemRoleMember, Status: "active"}
	hooks := &spHooks{}
	svc.SetSharePointSync(hooks)
	ctx := context.Background()

	ch, err := svc.Create(ctx, "owner", "plans", model.ChannelTypePublic, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := svc.Join(ctx, "u-join", ch.ID); err != nil {
		t.Fatalf("Join: %v", err)
	}
	users.users["u-add"] = &model.User{ID: "u-add", DisplayName: "Add", Status: "active"}
	if err := svc.AddMember(ctx, "owner", ch.ID, "u-add", model.ChannelRoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if !slices.Contains(hooks.joined, ch.ID+":u-join") || !slices.Contains(hooks.joined, ch.ID+":u-add") {
		t.Fatalf("joined = %v", hooks.joined)
	}
	if err := svc.Leave(ctx, "u-join", ch.ID); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if err := svc.RemoveMember(ctx, "owner", ch.ID, "u-add"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if len(hooks.left) != 2 || hooks.left[0][0] != "u-join" || hooks.left[1][0] != "u-add" {
		t.Fatalf("left = %v", hooks.left)
	}
}

type spTokenSaver struct {
	saved []string
	err   error
}

func (s *spTokenSaver) SaveDelegatedToken(_ context.Context, userID string, tok *oauth2.Token) error {
	if tok != nil {
		s.saved = append(s.saved, userID+":"+tok.RefreshToken)
	}
	return s.err
}

func TestSSOLoginKeepsTheMicrosoftToken(t *testing.T) {
	for _, saveErr := range []error{nil, errors.New("dynamo")} {
		env := setupAuthService()
		env.oidc.userInfo.Token = &oauth2.Token{AccessToken: "graph", RefreshToken: "refresh"}
		saver := &spTokenSaver{err: saveErr}
		env.svc.SetDelegatedTokens(saver)
		// A token that can't be saved never fails the login.
		_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce")
		if err != nil {
			t.Fatalf("login: %v", err)
		}
		if !slices.Equal(saver.saved, []string{user.ID + ":refresh"}) {
			t.Fatalf("saved = %v", saver.saved)
		}
	}
}
