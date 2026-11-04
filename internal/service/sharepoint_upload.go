package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
)

// Office files in a private channel. A Word, Excel or PowerPoint file posted
// in a private channel goes into its uploader's OneDrive, under
// Ex/<channel>, rather than ex's own storage: the message then carries its
// link, which shares it with the channel's members (see sharepoint.go) and
// shows it as its file, open for editing in Office. Everywhere else — and for
// anyone without a working Microsoft sign-in — it stays an ordinary
// attachment; the client falls back to that whenever this refuses.

// officeExtensions are the files that go to OneDrive.
var officeExtensions = map[string]bool{"doc": true, "docx": true, "xls": true, "xlsx": true, "ppt": true, "pptx": true}

// oneDriveFolder is the folder in the uploader's OneDrive the files go under.
const oneDriveFolder = "Ex"

// ErrMicrosoftSignInRequired: the uploader has no working Microsoft sign-in,
// so nothing can be put in their OneDrive.
var ErrMicrosoftSignInRequired = apperr.Conflict("sign in with Microsoft to keep Office files in OneDrive")

// OfficeUpload is an Office file put into its uploader's OneDrive.
type OfficeUpload struct {
	Name   string `json:"name"`
	WebURL string `json:"webURL"`
	Size   int64  `json:"size"`
}

// oneDriveName makes a name OneDrive accepts: none of " * : < > ? / \ | or
// control characters, and no leading or trailing spaces or dots.
func oneDriveName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`"*:<>?/\|`, r) {
			return '-'
		}
		return r
	}, name)
	return strings.Trim(name, " .")
}

// UploadOfficeFile puts an Office file, posted by userID in a private channel
// they belong to, into their own OneDrive and returns its link. body holds
// exactly size bytes.
func (s *SharePointService) UploadOfficeFile(ctx context.Context, userID, channelID, name string, body io.Reader, size int64) (*OfficeUpload, error) {
	name = oneDriveName(path.Base(strings.ReplaceAll(name, `\`, "/")))
	if !officeExtensions[strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))] {
		return nil, apperr.Invalid("sharepoint: only Word, Excel and PowerPoint files go to OneDrive")
	}
	if !s.d.Uploads.AllowsExtension(ctx, name) || !s.d.Uploads.AllowsSize(ctx, size) {
		return nil, apperr.Invalid("sharepoint: this file's type or size isn't allowed")
	}
	ch, err := s.d.Channels.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if ch.Type != model.ChannelTypePrivate || ch.Archived {
		return nil, apperr.Invalid("sharepoint: Office files go to OneDrive only in private channels")
	}
	if err := s.d.Access.CheckAccess(ctx, userID, channelID, ParentChannel); err != nil {
		return nil, err
	}
	ts, err := s.d.Tokens.TokenSource(ctx, userID)
	if errors.Is(err, ErrNoDelegatedToken) {
		return nil, ErrMicrosoftSignInRequired
	}
	if err != nil {
		return nil, err
	}
	folder := oneDriveName(ch.Name)
	if folder == "" {
		folder = ch.ID
	}
	item, err := s.d.Graph.Upload(ctx, ts, []string{oneDriveFolder, folder}, name, body, size)
	if errors.Is(err, msgraph.ErrSignInRequired) {
		return nil, ErrMicrosoftSignInRequired
	}
	if err != nil {
		return nil, fmt.Errorf("sharepoint: upload: %w", err)
	}
	// Only a link on a shared host reaches the channel's members; one on
	// another host would be a file only the uploader can open.
	u, err := url.Parse(item.WebURL)
	if err != nil || u.Scheme != "https" || !matchesHost(s.d.Hosts, u.Hostname()) {
		return nil, fmt.Errorf("sharepoint: uploaded file's link %q is not on a shared host", item.WebURL)
	}
	return &OfficeUpload{Name: item.Name, WebURL: item.WebURL, Size: item.Size}, nil
}
