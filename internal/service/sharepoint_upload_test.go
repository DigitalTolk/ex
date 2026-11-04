package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/store"
)

type spChannels struct{ channels map[string]*model.Channel }

func (c *spChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	if ch, ok := c.channels[id]; ok {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

type spUploadLimits struct {
	refuseType bool
	maxSize    int64
}

func (l *spUploadLimits) AllowsExtension(context.Context, string) bool { return !l.refuseType }
func (l *spUploadLimits) AllowsSize(_ context.Context, size int64) bool { return size <= l.maxSize }

// officeUpload is alice in the private channel "deal room" (ch-deal), signed
// in with Microsoft, whose OneDrive answers with a file on a shared host.
type officeUpload struct {
	svc      *SharePointService
	graph    *spGraph
	tokens   *spTokens
	access   *spAccess
	limits   *spUploadLimits
	channels *spChannels
}

func newOfficeUpload() *officeUpload {
	u := &officeUpload{
		graph:  newSPGraph(),
		tokens: &spTokens{missing: map[string]bool{}},
		access: &spAccess{},
		limits: &spUploadLimits{maxSize: 1 << 20},
		channels: &spChannels{channels: map[string]*model.Channel{
			"ch-deal":     {ID: "ch-deal", Name: "deal room", Type: model.ChannelTypePrivate},
			"ch-open":     {ID: "ch-open", Name: "general", Type: model.ChannelTypePublic},
			"ch-old":      {ID: "ch-old", Name: "old deals", Type: model.ChannelTypePrivate, Archived: true},
			"ch-nameless": {ID: "ch-nameless", Name: "...", Type: model.ChannelTypePrivate},
		}},
	}
	u.graph.uploadItem = &msgraph.DriveItem{ID: "it-1", Name: "Q3- plan.docx", Size: 5, WebURL: "https://contoso-my.sharepoint.com/personal/alice/Q3-%20plan.docx"}
	u.svc = NewSharePointService(SharePointDeps{
		Graph: u.graph, Tokens: u.tokens, Access: u.access, Channels: u.channels, Uploads: u.limits,
		Hosts: []string{"*.sharepoint.com"},
	})
	return u
}

func (u *officeUpload) upload(channelID, name string) (*OfficeUpload, error) {
	return u.svc.UploadOfficeFile(context.Background(), "alice", channelID, name, strings.NewReader("hello"), 5)
}

// The file goes into alice's own OneDrive, under Ex/<channel>, as her, named
// the way OneDrive accepts (a browser's fake path and a colon dropped).
func TestUploadOfficeFile(t *testing.T) {
	u := newOfficeUpload()
	got, err := u.upload("ch-deal", `C:\fakepath\Q3: plan.docx`)
	if err != nil {
		t.Fatalf("UploadOfficeFile: %v", err)
	}
	if *got != (OfficeUpload{Name: "Q3- plan.docx", WebURL: "https://contoso-my.sharepoint.com/personal/alice/Q3-%20plan.docx", Size: 5}) {
		t.Fatalf("upload = %+v", got)
	}
	if want := "Ex/deal room/Q3- plan.docx (5 of 5) as tok-alice"; len(u.graph.uploads) != 1 || u.graph.uploads[0] != want {
		t.Fatalf("uploads = %v, want %q", u.graph.uploads, want)
	}

	// A channel whose name leaves nothing OneDrive accepts gets its id.
	if _, err := u.upload("ch-nameless", "Budget.XLSX"); err != nil {
		t.Fatalf("nameless channel: %v", err)
	}
	if u.graph.uploads[1] != "Ex/ch-nameless/Budget.XLSX (5 of 5) as tok-alice" {
		t.Fatalf("uploads = %v", u.graph.uploads)
	}
}

// Anything it won't do is refused before a byte reaches Microsoft 365 — the
// client then attaches the file the ordinary way.
func TestUploadOfficeFileRefusals(t *testing.T) {
	for _, c := range []struct {
		name    string
		channel string
		file    string
		setup   func(*officeUpload)
		want    error
	}{
		{"not an Office file", "ch-deal", "notes.txt", nil, apperr.ErrValidation},
		{"a type the workspace refuses", "ch-deal", "a.docx", func(u *officeUpload) { u.limits.refuseType = true }, apperr.ErrValidation},
		{"too big for the workspace", "ch-deal", "a.docx", func(u *officeUpload) { u.limits.maxSize = 4 }, apperr.ErrValidation},
		{"no such channel", "ch-gone", "a.docx", nil, store.ErrNotFound},
		{"a public channel", "ch-open", "a.docx", nil, apperr.ErrValidation},
		{"an archived channel", "ch-old", "a.pptx", nil, apperr.ErrValidation},
		{"not a member", "ch-deal", "a.docx", func(u *officeUpload) { u.access.err = ErrForbidden }, ErrForbidden},
		{"never signed in with Microsoft", "ch-deal", "a.doc", func(u *officeUpload) { u.tokens.missing["alice"] = true }, ErrMicrosoftSignInRequired},
	} {
		t.Run(c.name, func(t *testing.T) {
			u := newOfficeUpload()
			if c.setup != nil {
				c.setup(u)
			}
			if _, err := u.upload(c.channel, c.file); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if len(u.graph.uploads) != 0 {
				t.Fatalf("uploaded anyway: %v", u.graph.uploads)
			}
		})
	}
}

func TestUploadOfficeFileFailures(t *testing.T) {
	tokensDown := errors.New("redis down")
	graphDown := errors.New("503")
	for _, c := range []struct {
		name  string
		setup func(*officeUpload)
		want  error
	}{
		{"token store down", func(u *officeUpload) { u.tokens.err = tokensDown }, tokensDown},
		{"Microsoft wants a fresh sign-in", func(u *officeUpload) { u.graph.uploadErr = msgraph.ErrSignInRequired }, ErrMicrosoftSignInRequired},
		{"Microsoft 365 down", func(u *officeUpload) { u.graph.uploadErr = graphDown }, graphDown},
	} {
		t.Run(c.name, func(t *testing.T) {
			u := newOfficeUpload()
			c.setup(u)
			if _, err := u.upload("ch-deal", "a.docx"); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}

	// A link the channel's members couldn't be given — another host, plain
	// http, or no link at all — is no use in the message.
	for _, link := range []string{"https://files.example.com/a.docx", "http://contoso.sharepoint.com/a.docx", "::"} {
		u := newOfficeUpload()
		u.graph.uploadItem.WebURL = link
		if _, err := u.upload("ch-deal", "a.docx"); err == nil || !strings.Contains(err.Error(), "not on a shared host") {
			t.Errorf("%q: err = %v", link, err)
		}
	}
}
